/**
 * ClassificationService.ts — Specificity Waterfall Classification.
 *
 * FOUR-STEP PIPELINE (greedy — exits on first confident match):
 *
 *   STEP 0 — ARCHIVES BAN
 *     If the file was created/modified in the last 3 months, every
 *     NOISE_FOLDER (Archives, Misc, Old …) is completely disqualified.
 *     They are never shown to the AI and never appear in matching.
 *
 *   STEP 1 — BULLSEYE (100 % confidence, zero AI)
 *     Two-phase check:
 *
 *     Phase A — HEADER AUTHORITY (first 500 chars of content)
 *       If a folder name appears in the document header (lines 1-10),
 *       it acts as a Super-Trump Card and wins at 100 % regardless of
 *       what the body text says.
 *       ➜ "AP Seminar" in header beats "FBLA" keywords in body.
 *
 *     Phase B — STANDARD BULLSEYE (filename + first 100 words)
 *       Tokenise the filename + first 100 words of content.
 *       If every word of a folder name (or ≥75 % of an alias / Core Topic)
 *       appears in the token set, assign at 100 %.
 *       ➜ "ap20-seminar-task-1.pdf" matches "AP Seminar" here.
 *
 *   STEP 2 — SPECIFIC MATCH (80-90 % confidence, 2 Ollama calls)
 *     a) Global Domain classifier  → Education / US History
 *     b) Domain-aware chain-of-thought against folder fingerprints,
 *        with folders sorted MOST-SPECIFIC-FIRST so "AP Seminar" is
 *        tried before "School".
 *     If the result's confidence ≥ 60 %, return it.
 *
 *   STEP 3 — BROAD FALLBACK (≤ 60 % confidence)
 *     Only when the Specific Match was too weak.
 *     Maps the Global Domain to a parent folder and suggests a
 *     hierarchical path ("School/APUSH").
 *     This is the ONLY time a broad/generic folder is acceptable.
 *
 * INTELLIGENCE LAYERS (preserved):
 *   1. Folder Fingerprinting  (ContextService)
 *   2. Topic Aliasing         (alias_map.json / Core Topics)
 *   3. Noise Penalty / Domain-Aware Rejection / Archives Ban
 *   4. Text Extraction + OCR  (TextExtractionService)
 *   5. Chain-of-Thought Prompt
 *   6. Confidence Gating      (requires_review when < 60)
 */

import fs from "fs";
import http from "http";
import path from "path";
import { buildLearningBlock, recordCorrection } from "./LearningService";
import { enrichPoolFromCorrection } from "./PoolEnrichmentService";
import { getHistoryBoost } from "./ConsistencyService";
import {
  getFolderContext,
  getFolderContextForPrompt,
  isNoiseFolderName,
} from "./ContextService";
import type { FolderContextMap } from "./ContextService";
import {
  extractForClassification,
  extractMetadata,
  type FileMetadata,
} from "./TextExtractionService";
import {
  addTermsToPool,
  readMergedPool as poolManagerReadMergedPool,
  getTopDistinctiveTerms,
  computePoolHealth,
} from "../intelligence/universal-pool-manager";
import {
  recordClassification,
  applyDisambiguationRules,
  getConfidenceTier,
} from "../validation/accuracy-monitor";

const { scanUserFolders } = require("./fileService");

// Lazy accessor — avoids potential startup-time circular dependency
type IndexSearchFn = (query: string, limit?: number) => Array<{ filename: string; folder: string; timestamp: number; fullPath: string }>;
let _indexSearchFiles: IndexSearchFn | null = null;
function getIndexSearch(): IndexSearchFn | null {
  if (!_indexSearchFiles) {
    try { _indexSearchFiles = require("./SearchIndexService").searchFiles; } catch {}
  }
  return _indexSearchFiles;
}

// ── Configuration ──────────────────────────────────────────

const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;

// Model preference order — first one found installed wins.
// If you pull llama3.2:3b locally, it auto-upgrades at next launch.
const PREFERRED_MODELS = ["llama3.2:3b", "llama3.2:1b", "llama3.2", "llama3:latest"];
let resolvedModelName: string | null = null;

/** Query Ollama /api/tags once per session; cache the best available model. */
async function getModelName(): Promise<string> {
  if (resolvedModelName) return resolvedModelName;

  try {
    const available = await new Promise<string[]>((resolve) => {
      const req = http.request(
        { hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: "/api/tags", method: "GET", timeout: 5000 },
        (res) => {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString()));
          res.on("end", () => {
            try {
              const data = JSON.parse(body);
              resolve((data.models || []).map((m: { name: string }) => m.name as string));
            } catch {
              resolve([]);
            }
          });
        }
      );
      req.on("error", () => resolve([]));
      req.on("timeout", () => { req.destroy(); resolve([]); });
      req.end();
    });

    for (const preferred of PREFERRED_MODELS) {
      if (available.some((m) => m === preferred || m.startsWith(preferred.split(":")[0] + ":"))) {
        // Use exact match first, then any version of same family
        const exact = available.find((m) => m === preferred);
        resolvedModelName = exact || available.find((m) => m.startsWith(preferred.split(":")[0] + ":")) || preferred;
        console.log(`[Classification] Using model: ${resolvedModelName}`);
        return resolvedModelName;
      }
    }
  } catch {
    // Ollama not reachable yet — fall back to safe default
  }

  resolvedModelName = "llama3.2:1b";
  return resolvedModelName;
}

// Keep synchronous MODEL_NAME for non-async call sites (fallback only)
const MODEL_NAME = "llama3.2:1b";
const REQUEST_TIMEOUT_MS = 90_000;

const REVIEW_THRESHOLD = 60;
const NOISE_FOLDER_PENALTY = 30;
const DOMAIN_CONFIDENCE_THRESHOLD = 60;
const DOMAIN_CLASSIFIER_WORDS = 2000;

/** Words from file content scanned during the Bullseye check. */
const BULLSEYE_CONTENT_WORDS = 100;

/** Characters from file content treated as the "Header Zone" (lines 1-10). */
const HEADER_ZONE_CHARS = 500;

/** Files over this word count are smart-sampled for classification. */
const FULL_TEXT_SAMPLE_THRESHOLD = 50_000;

/** Maximum words sent to Ollama in the specific-match classification prompt. */
const MAX_OLLAMA_CONTENT_WORDS = 3_000;

/** Files younger than this are subject to the Archives Ban. */
const RECENCY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 3 months

// ── Full-text extraction with smart sampling ─────────────

/**
 * Read a file's complete text.
 *
 * - Files ≤ 50,000 words: returned in full.
 * - Files > 50,000 words: first 3,000 + middle 2,000 + last 2,000 words with
 *   separator markers so the classifier sees beginning, body, and end without
 *   loading the entire document into memory.
 */
async function sampleFileContent(filePath: string): Promise<string> {
  // FIX 2: use extractForClassification (15k word limit) instead of extractFullText (unlimited)
  const raw = await extractForClassification(filePath);
  if (!raw) return "";

  const words = raw.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= FULL_TEXT_SAMPLE_THRESHOLD) return words.join(" ");

  const firstChunk  = words.slice(0, 3_000).join(" ");
  const midStart    = Math.floor(words.length / 2) - 1_000;
  const middleChunk = words.slice(midStart, midStart + 2_000).join(" ");
  const lastChunk   = words.slice(-2_000).join(" ");

  return [
    firstChunk,
    "\n\n[... middle section ...]\n\n",
    middleChunk,
    "\n\n[... end section ...]\n\n",
    lastChunk,
  ].join("");
}

// ── Global Domains ────────────────────────────────────────

interface GlobalDomainConfig {
  examples: string;
  folderHints: string[];
}

const GLOBAL_DOMAINS: Record<string, GlobalDomainConfig> = {
  Education: {
    examples: "Homework, syllabi, textbooks, courses, school assignments, academic papers, lectures, exams",
    folderHints: ["School", "Courses", "Academic", "Classes", "Education", "Study"],
  },
  Finance: {
    examples: "Taxes, invoices, bank statements, budgets, receipts, payroll, financial reports, investments",
    folderHints: ["Finance", "Financial", "Money", "Banking", "Accounting", "Taxes"],
  },
  Legal: {
    examples: "Contracts, terms of service, legal briefs, court documents, agreements, compliance, NDAs",
    folderHints: ["Legal", "Law", "Contracts"],
  },
  Medical: {
    examples: "Lab results, prescriptions, medical records, insurance claims, health reports, clinical notes",
    folderHints: ["Medical", "Health", "Healthcare"],
  },
  Personal: {
    examples: "Travel plans, recipes, family documents, personal letters, journals, hobbies, photos",
    folderHints: ["Personal", "Home", "Family", "Life"],
  },
  Tech: {
    examples: "Source code, technical manuals, API docs, system documentation, configs, architecture diagrams",
    folderHints: ["Tech", "Code", "Development", "Engineering", "Programming"],
  },
  Work: {
    examples: "Resumes, business reports, project plans, presentations, meeting notes, proposals, professional docs",
    folderHints: ["Work", "Business", "Career", "Professional", "Projects"],
  },
  Mathematics: {
    examples: "Calculus, algebra, geometry, statistics, proofs, equations, theorems, trigonometry, precalculus, linear algebra",
    folderHints: ["Math", "Mathematics", "Precalculus", "PreCalc", "Pre-Calc", "Pre Calc",
                  "Calculus", "Algebra", "Geometry", "Statistics", "Trigonometry", "STEM"],
  },
};

// ── Types ──────────────────────────────────────────────────

export interface GlobalDomainResult {
  domain: string;
  subdomain: string;
  confidence: number;
}

export interface ClassificationResult {
  category: string;
  confidence: number;
  reasoning: string;
  isNewFolder: boolean;
  detected_concepts: string[];
  concept_abstraction: string;
  requires_review: boolean;
  was_noise_penalized: boolean;
  global_domain: string;
  global_subdomain: string;
  suggested_path: string;
  /** Which waterfall step produced this result. */
  match_level: "bullseye" | "specific" | "pool" | "broad" | "fallback";
  /** When a conflict is detected (2+ categories >75%), lists the conflicting categories. */
  conflict_categories?: string[];
  /** Runner-up category from the AI scan (used by the disambiguation pipeline). */
  second_category?: string;
  /** Confidence score of the runner-up category. */
  second_confidence?: number;
}

interface FolderContextEntry {
  autoKeywords: string;
  coreTopics: string;
  description: string;
  isNoiseFolder: boolean;
}

type RichFolderContextMap = Record<string, FolderContextEntry>;

// ── Ollama API call ────────────────────────────────────────

interface OllamaCallOptions {
  temperature?: number;
  numCtx?: number;
  timeout?: number;
}

function callOllama(
  systemPrompt: string,
  userMessage: string,
  opts?: OllamaCallOptions
): Promise<string> {
  const temperature = opts?.temperature ?? 0.1;
  const numCtx = opts?.numCtx ?? 4096;
  const timeout = opts?.timeout ?? REQUEST_TIMEOUT_MS;

  // Resolve best available model (3b > 1b, cached after first call)
  return getModelName().then((modelName) => new Promise((resolve, reject) => {
    const messages: { role: string; content: string }[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: userMessage });

    const payload = JSON.stringify({
      model: modelName,
      messages,
      stream: false,
      options: { temperature, num_ctx: numCtx },
    });

    const req = http.request(
      {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: "/api/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            resolve(data.message?.content || "");
          } catch {
            reject(new Error("Failed to parse Ollama response"));
          }
        });
        res.on("error", (err: Error) => reject(err));
      }
    );

    req.on("error", (err: Error) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Ollama request timed out"));
    });

    req.write(payload);
    req.end();
  }));
}

// ═══════════════════════════════════════════════════════════
//  STEP 0 — ARCHIVES BAN + helpers
// ═══════════════════════════════════════════════════════════

/**
 * Returns `true` when the file was created / last modified within
 * the RECENCY_WINDOW (default 3 months).  Recent files are never
 * allowed to land in noise folders.
 */
function isFileRecent(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    // Prefer birth-time (creation); fall back to mtime
    const created = stat.birthtimeMs || stat.mtimeMs;
    return Date.now() - created < RECENCY_WINDOW_MS;
  } catch {
    return false; // cannot stat → don't apply the ban
  }
}

// ── Tokeniser (shared by Bullseye + specificity sort) ─────

/**
 * Split text into a normalised token set.
 *
 *   "ap20-seminar-task-1.pdf"
 *   → Set { "ap", "ap20", "seminar", "task" }
 *
 * Also splits digit-letter boundaries so "ap20" emits "ap".
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const raw = text
    .toLowerCase()
    .replace(/[-_.,;:!?()\[\]{}'"/\\@#$%^&*+=~`<>]/g, " ");
  const words = raw.split(/\s+/).filter((w) => w.length >= 2);

  for (const word of words) {
    tokens.add(word);

    // "ap20" → also emit "ap"
    const alphaPrefix = word.match(/^([a-z]+)\d/);
    if (alphaPrefix && alphaPrefix[1].length >= 2) {
      tokens.add(alphaPrefix[1]);
    }
    // "20th" → also emit "th" — usually too short, filtered by length
    const alphaSuffix = word.match(/\d([a-z]{2,})$/);
    if (alphaSuffix) {
      tokens.add(alphaSuffix[1]);
    }
  }

  return tokens;
}

/**
 * Fuzzy token-to-word match that tolerates plurals and common
 * suffixes (-s, -es, -ing, -ed …).
 *
 *   "tax" ↔ "taxes"   → ✓  (3/5 = 0.60)
 *   "tax" ↔ "taxonomy" → ✗  (3/8 = 0.38)
 *   "seminar" ↔ "seminars" → ✓
 */
function tokenMatchesWord(token: string, word: string): boolean {
  if (token === word) return true;
  const shorter = token.length <= word.length ? token : word;
  const longer = token.length > word.length ? token : word;
  if (shorter.length <= 2) {
    return longer.startsWith(shorter);
  }
  return longer.startsWith(shorter) && shorter.length / longer.length >= 0.6;
}

// ── Specificity sort ──────────────────────────────────────

/**
 * Sort folders so the most specific ones are tried first during
 * partial-match resolution.  "AP Seminar" (2 words, has aliases)
 * is tried before "Documents" (1 generic word).
 */
function sortBySpecificity(
  folders: string[],
  fingerprints: FolderContextMap
): string[] {
  return [...folders].sort((a, b) => {
    const fpA = fingerprints[a];
    const fpB = fingerprints[b];

    // Folders with user-defined Core Topics are most intentional
    const topicsA = fpA?.coreTopics?.length || 0;
    const topicsB = fpB?.coreTopics?.length || 0;
    if (topicsA !== topicsB) return topicsB - topicsA;

    // More name-words = more specific
    const wordsA = a.split(/[\s_-]+/).length;
    const wordsB = b.split(/[\s_-]+/).length;
    if (wordsA !== wordsB) return wordsB - wordsA;

    // Longer name = more specific
    return b.length - a.length;
  });
}

// ═══════════════════════════════════════════════════════════
//  STEP 1 — BULLSEYE CHECK (zero AI, 100 % confidence)
// ═══════════════════════════════════════════════════════════

/**
 * Two-phase lexical match (zero AI):
 *
 *   Phase A — HEADER AUTHORITY
 *     Scan the first 500 chars of the file content (the "Header Zone").
 *     If a folder name (or Core Topic) appears there, assign at 100 %
 *     immediately.  The header is authoritative — it beats anything in
 *     the body.
 *
 *   Phase B — STANDARD BULLSEYE
 *     Tokenise the filename + first 100 words of content and check
 *     every non-noise folder for a direct name or alias hit.
 *
 * Returns a ClassificationResult at 100 % confidence, or `null` if no
 * folder is an obvious match.
 */
function tryBullseyeMatch(
  filename: string,
  fileContent: string,
  fingerprints: FolderContextMap,
  activeFolders: string[]
): ClassificationResult | null {
  interface Hit {
    folder: string;
    matched: number;   // matched word count
    total: number;     // total word count
    via: string;       // human-readable source
  }

  // Helper: scan a token set against all active folders
  function collectHits(tokens: Set<string>, viaPrefix: string): Hit[] {
    const found: Hit[] = [];

    for (const folder of activeFolders) {
      const fp = fingerprints[folder];
      if (!fp || fp.isNoiseFolder) continue;

      // A) Folder-name match (all name-words must be in tokens)
      const nameWords = folder
        .replace(/[-_]/g, " ")
        .split(/\s+/)
        .map((w) => w.toLowerCase())
        .filter((w) => w.length >= 2);

      if (nameWords.length > 0) {
        const matched = nameWords.filter((w) =>
          [...tokens].some((t) => tokenMatchesWord(t, w))
        );

        if (matched.length === nameWords.length) {
          found.push({
            folder,
            matched: matched.length,
            total: nameWords.length,
            via: `${viaPrefix}folder name [${matched.join(", ")}]`,
          });
          continue; // name matched — skip alias check
        }
      }

      // A-2) Hyphen-normalised folder-name substring match
      // Handles "Pre-Calc" folder ↔ "PreCalc" in filename (and vice-versa).
      // Strips hyphens/underscores/spaces from both sides before comparing.
      {
        const normFolder = folder.toLowerCase().replace(/[-_\s+.]/g, "");
        const rawText = [
          filename.replace(/\.[^.]+$/, ""),
          fileContent ? fileContent.split(/\s+/).slice(0, BULLSEYE_CONTENT_WORDS).join(" ") : "",
        ].join(" ").toLowerCase().replace(/[-_]/g, "");
        if (normFolder.length >= 3 && rawText.includes(normFolder)) {
          found.push({
            folder,
            matched: normFolder.length,
            total: normFolder.length,
            via: `${viaPrefix}normalised-name substring "${normFolder}"`,
          });
          continue;
        }
      }

      // B) Core-topic / alias match (≥75 % of topic words)
      for (const topic of fp.coreTopics) {
        const topicWords = topic
          .toLowerCase()
          .split(/[\s,]+/)
          .filter((w) => w.length >= 2);

        if (topicWords.length === 0) continue;

        const matched = topicWords.filter((w) =>
          [...tokens].some((t) => tokenMatchesWord(t, w))
        );

        if (matched.length >= Math.ceil(topicWords.length * 0.75)) {
          found.push({
            folder,
            matched: matched.length,
            total: topicWords.length,
            via: `${viaPrefix}Core Topic "${topic}" [${matched.join(", ")}]`,
          });
        }
      }
    }

    return found;
  }

  // Helper: pick best hit and build result
  function pickBest(hits: Hit[]): ClassificationResult {
    hits.sort((a, b) => {
      if (a.matched !== b.matched) return b.matched - a.matched;
      return b.folder.length - a.folder.length;
    });

    const best = hits[0];
    const reasoning =
      `BULLSEYE: "${best.folder}" matched via ${best.via} ` +
      `(${best.matched}/${best.total} words).`;

    console.log(`[Classification] ${reasoning}`);

    return {
      category: best.folder,
      confidence: 100,
      reasoning,
      isNewFolder: false,
      detected_concepts: [],
      concept_abstraction: `Direct token match — ${best.via}`,
      requires_review: false,
      was_noise_penalized: false,
      global_domain: "",
      global_subdomain: "",
      suggested_path: "",
      match_level: "bullseye",
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase A — HEADER AUTHORITY (first 500 chars)
  //
  //  If the student writes "AP Seminar" at the top of the doc,
  //  it IS AP Seminar — even if the essay body is about GDP.
  // ═══════════════════════════════════════════════════════════

  const headerZone = fileContent
    ? fileContent.slice(0, HEADER_ZONE_CHARS)
    : "";

  if (headerZone) {
    const headerTokens = tokenize(headerZone);
    const headerHits = collectHits(headerTokens, "HEADER ");

    if (headerHits.length > 0) {
      console.log(
        `[Classification] HEADER AUTHORITY: ${headerHits.length} match(es) ` +
        `in first ${HEADER_ZONE_CHARS} chars — header overrides body.`
      );
      return pickBest(headerHits);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase B — STANDARD BULLSEYE (filename + first 100 words)
  // ═══════════════════════════════════════════════════════════

  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent
    ? fileContent.split(/\s+/).slice(0, BULLSEYE_CONTENT_WORDS).join(" ")
    : "";
  const tokens = tokenize(nameNoExt + " " + contentHead);

  const hits = collectHits(tokens, "");

  if (hits.length === 0) return null;

  return pickBest(hits);
}

// ═══════════════════════════════════════════════════════════
//  STEP 0.5 — METADATA BULLSEYE (FIX 1)
//
//  PDFs and DOCX files carry hidden document properties (title,
//  subject, author, keywords).  If the subject field contains a
//  known folder name or alias, we treat it as a 100 % Bullseye.
// ═══════════════════════════════════════════════════════════

/**
 * Scan PDF / DOCX metadata for folder-name / alias hits.
 * Returns a 100 % confidence result if the subject or keywords
 * contain a known folder name, or null if nothing matched.
 */
function tryMetadataBullseye(
  metadata: FileMetadata | null,
  activeFolders: string[],
  fingerprints: FolderContextMap,
  filename: string
): ClassificationResult | null {
  if (!metadata) return null;

  // Collect all metadata strings into a single searchable block
  const metaText = [
    metadata.title,
    metadata.subject,
    metadata.keywords,
    metadata.description,
    metadata.creator,
  ]
    .filter(Boolean)
    .join(" ");

  if (metaText.trim().length < 3) return null;

  const metaTokens = tokenize(metaText);

  for (const folder of activeFolders) {
    const fp = fingerprints[folder];
    if (!fp || fp.isNoiseFolder) continue;

    // Check folder name words
    const nameWords = folder
      .replace(/[-_]/g, " ")
      .split(/\s+/)
      .map((w) => w.toLowerCase())
      .filter((w) => w.length >= 2);

    if (nameWords.length > 0) {
      const matched = nameWords.filter((w) =>
        [...metaTokens].some((t) => tokenMatchesWord(t, w))
      );
      if (matched.length === nameWords.length) {
        const reasoning = `METADATA BULLSEYE: folder "${folder}" matched via document metadata — ` +
          `subject="${metadata.subject || ""}" keywords="${metadata.keywords || ""}"`;
        console.log(`[Classification] ${reasoning}`);
        console.log(`[Classification] PDF metadata hit: subject='${metadata.subject || ""}'`);
        return {
          category: folder,
          confidence: 100,
          reasoning,
          isNewFolder: false,
          detected_concepts: [metadata.subject || metadata.title || folder],
          concept_abstraction: `Document metadata match`,
          requires_review: false,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: "bullseye",
        };
      }
    }

    // Check core topics
    for (const topic of fp.coreTopics) {
      const topicWords = topic
        .toLowerCase()
        .split(/[\s,]+/)
        .filter((w) => w.length >= 2);
      if (topicWords.length === 0) continue;
      const matched = topicWords.filter((w) =>
        [...metaTokens].some((t) => tokenMatchesWord(t, w))
      );
      if (matched.length >= Math.ceil(topicWords.length * 0.75)) {
        const reasoning = `METADATA BULLSEYE: folder "${folder}" Core Topic "${topic}" matched via metadata`;
        console.log(`[Classification] ${reasoning}`);
        return {
          category: folder,
          confidence: 100,
          reasoning,
          isNewFolder: false,
          detected_concepts: [topic],
          concept_abstraction: `Document metadata match`,
          requires_review: false,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: "bullseye",
        };
      }
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════
//  STEP 1.5 — KEYWORD MAP (zero AI, 95% confidence)
//
//  Before calling Ollama, check if the file content contains
//  subject-specific keywords that map directly to a known folder.
//  This prevents the AI from lazily dumping research papers
//  and specific documents into generic "Documents".
//
//  PRIORITY ORDER:
//    - TIER 1 (Bullseye): folder name literally in header (100%)
//    - TIER 1.5 (Keywords): subject keywords → folder (95%)
//    - TIER 2 (AI Specific): Ollama chain-of-thought (80-90%)
//    - TIER 3 (Broad Fallback): domain → parent folder (≤60%)
// ═══════════════════════════════════════════════════════════

/**
 * Map of keywords → target folder name.
 * Each entry: [array of trigger keywords, target folder].
 * If ANY keyword appears in the file content (case-insensitive),
 * the file routes to the target folder.
 *
 * Keywords are checked against: filename + first 500 words of content.
 */
const KEYWORD_MAP: Array<{ keywords: string[]; folder?: string; folderMatcher?: (folders: string[]) => string | undefined; confidence: number }> = [
  // ── APUSH — checked FIRST. Uses folderMatcher so it works whether the
  //    folder is named "APUSH", "AP US History", "US History", etc. ──────
  {
    // Unambiguous APUSH identifiers → 100% confidence
    keywords: [
      "amsco", "apush", "ap us history", "ap united states history",
      "united states history", "period 4", "period 5", "period 6",
      "period 7", "period 8", "period 9",
      "dbq", "document based question", "leq", "long essay question",
      "saq", "short answer question",
    ],
    folderMatcher: (folders) =>
      folders.find((f) =>
        ["apush", "ushistory", "us history", "american history", "united states",
         "usgov", "us gov", "history"].some((s) =>
          f.toLowerCase().replace(/[-_\s+.]/g, "").includes(s.replace(/\s/g, ""))
        )
      ),
    confidence: 100,
  },
  {
    // Common APUSH event/era terms → 88% (avoid over-routing general docs)
    keywords: [
      "reconstruction", "civil war", "manifest destiny", "new deal",
      "great depression", "american revolution", "constitutional convention",
      "gilded age", "progressive era", "cold war", "new frontier",
      "jacksonian democracy", "antebellum", "emancipation proclamation",
    ],
    folderMatcher: (folders) =>
      folders.find((f) =>
        ["apush", "ushistory", "us history", "american history", "united states",
         "history"].some((s) =>
          f.toLowerCase().replace(/[-_\s+.]/g, "").includes(s.replace(/\s/g, ""))
        )
      ),
    confidence: 88,
  },
  // ── AP Seminar — folderMatcher so "AP Seminar", "Seminar", "APSem" all work ──
  {
    keywords: [
      "ap seminar", "college board", "performance task",
      "individual research report", "individual multimedia presentation",
      "team multimedia presentation", "irr", "imp", "tmp",
      "stimulus material", "cross-curricular",
      "geopolitics", "international relations", "diplomacy",
      "national security", "foreign policy",
    ],
    folderMatcher: (folders) =>
      folders.find((f) =>
        ["seminar", "apsem", "apresearch", "research"].some((s) =>
          f.toLowerCase().replace(/[-_\s+.]/g, "").includes(s)
        )
      ),
    confidence: 95,
  },
  // ── FBLA — folderMatcher so "FBLA", "Business", "BizLead" all work ──
  {
    keywords: [
      "fbla", "future business leaders", "competitive event",
      "business plan", "business financial plan", "entrepreneurship",
      "business presentation", "parliamentary procedure",
      "business ethics",
    ],
    folderMatcher: (folders) =>
      folders.find((f) =>
        ["fbla", "business", "deca", "entrepreneurship"].some((s) =>
          f.toLowerCase().replace(/[-_\s+.]/g, "").includes(s)
        )
      ),
    confidence: 95,
  },
  // ── Career / Finance — still folder-name matched but case-insensitive ──
  {
    keywords: [
      "resume", "cover letter", "curriculum vitae", "job application",
      "linkedin", "career objective",
    ],
    folderMatcher: (folders) =>
      folders.find((f) =>
        ["career", "job", "resume", "employment"].some((s) =>
          f.toLowerCase().replace(/[-_\s+.]/g, "").includes(s)
        )
      ),
    confidence: 95,
  },
  {
    keywords: [
      "invoice", "tax return", "w-2", "1099", "bank statement",
      "financial statement", "balance sheet", "income statement",
    ],
    folderMatcher: (folders) =>
      folders.find((f) =>
        ["finance", "financial", "money", "tax", "accounting", "banking"].some((s) =>
          f.toLowerCase().replace(/[-_\s+.]/g, "").includes(s)
        )
      ),
    confidence: 95,
  },
  // ── Math compound phrases → dynamic folder match ──────────
  {
    keywords: [
      // Compound / multi-word phrases (high specificity)
      "cross product", "dot product", "vectors in the plane",
      "3d coordinate", "coordinate system", "vector applications",
      "vectors in space", "unit vector", "direction angles",
      "dot products", "linear combination", "parametric equation",
      "polar coordinates", "conic section", "complex number",
      "rational function", "polynomial function", "logarithm",
      "trigonometric", "radian", "derivative", "integral",
      "limit of", "sequences and series",
      // Single-word math-specific terms (unambiguous in student notes)
      "precalculus", "pre-calculus", "precalc", "pre calc",
      "unit circle", "pythagorean", "sinusoidal",
      "completing the square", "vertex form", "standard form",
      "law of sines", "law of cosines",
      "arithmetic sequence", "geometric sequence", "binomial theorem",
      "angle of elevation", "angle of depression",
      "inverse function", "composition of functions",
      "sum and difference", "double angle", "half angle",
      "amplitude", "period", "phase shift",
      "asymptote", "discontinuity",
      "slope intercept", "point slope", "standard form",
      "quadratic formula", "discriminant",
      "imaginary number", "complex plane",
    ],
    folderMatcher: (folders) =>
      folders.find((f) =>
        ["precalc", "calc", "math", "mathematics", "algebra",
         "geometry", "trig", "stem"].some((s) =>
          f.toLowerCase().includes(s)
        )
      ),
    confidence: 88,
  },
];

/**
 * Check file content against the KEYWORD_MAP.
 * Returns a classification result at 95% confidence if a keyword
 * match is found, or null if no match.
 */
function tryKeywordMatch(
  filename: string,
  fileContent: string,
  activeFolders: string[]
): ClassificationResult | null {
  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent ?? "";
  const searchText = (nameNoExt + " " + contentHead).toLowerCase();

  for (const entry of KEYWORD_MAP) {
    // Resolve the target folder — either fixed name or dynamic matcher
    let actualFolder: string | undefined;
    if (entry.folderMatcher) {
      actualFolder = entry.folderMatcher(activeFolders);
    } else if (entry.folder) {
      const folderExists = activeFolders.some(
        (f) => f.toLowerCase() === entry.folder!.toLowerCase()
      );
      if (folderExists) {
        actualFolder = activeFolders.find(
          (f) => f.toLowerCase() === entry.folder!.toLowerCase()
        );
      }
    }
    if (!actualFolder) continue;

    for (const keyword of entry.keywords) {
      const kw = keyword.toLowerCase();
      const matched = kw.length < 5
        ? new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(searchText)
        : searchText.includes(kw);
      if (matched) {
        const conf = entry.confidence;
        const reasoning =
          `KEYWORD MAP: "${keyword}" found in content → routed to "${actualFolder}" (${conf}%)`;
        console.log(`[Classification] ${reasoning}`);

        return {
          category: actualFolder,
          confidence: conf,
          reasoning,
          isNewFolder: false,
          detected_concepts: [keyword],
          concept_abstraction: `Keyword-mapped to ${actualFolder} via "${keyword}"`,
          requires_review: false,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: conf === 100 ? "bullseye" : "specific",
        };
      }
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════
//  STEP 1.75 — SMART GROUPS (dynamic, zero AI, zero config)
//
//  Universal keyword system: any folder you create is auto-
//  matched to a Subject Group by name.  "Precalc" → MATH,
//  "Biology" → SCIENCE, "AP Seminar" → ACADEMIC_RESEARCH, etc.
//
//  If a file's content has high keyword density for a group,
//  it routes to the best-matching folder in that group.
//
//  NO hardcoded folder names — works for any folder you create.
// ═══════════════════════════════════════════════════════════

interface SubjectGroup {
  /** Substrings that, if found in a folder name, link it to this group. */
  folderHints: string[];
  /** Content keywords to scan for (all lowercase). */
  keywords: string[];
}

const SUBJECT_GROUPS: Record<string, SubjectGroup> = {
  MATH: {
    folderHints: [
      "math", "calc", "precalc", "algebra", "geometry", "trig",
      "statistics", "stats", "arithmetic",
    ],
    keywords: [
      "equation", "formula", "sine", "cosine", "tangent", "derivative",
      "integral", "algebra", "geometry", "trigonometry", "function",
      "calculus", "precalc", "problem set", "polynomial", "quadratic",
      "logarithm", "exponent", "matrix", "vector", "variable",
      "coefficient", "slope", "intercept", "asymptote", "limit",
    ],
  },
  SCIENCE: {
    folderHints: [
      "science", "bio", "chem", "physics", "anatomy", "ecology",
      "enviro", "astro", "geology",
    ],
    keywords: [
      "cell", "dna", "gene", "atom", "molecule", "reaction", "force",
      "energy", "gravity", "lab report", "experiment", "data", "analysis",
      "hypothesis", "organism", "evolution", "photosynthesis", "mitosis",
      "meiosis", "protein", "enzyme", "element", "compound", "velocity",
      "acceleration", "nucleus", "chromosome", "ecosystem",
    ],
  },
  HUMANITIES: {
    folderHints: [
      "history", "apush", "gov", "government", "civics", "social",
      "geography", "econ", "economics", "politics", "anthropology",
    ],
    keywords: [
      "history", "war", "treaty", "constitution", "century", "period",
      "era", "amsco", "document", "primary source", "context",
      "civilization", "revolution", "amendment", "congress", "democracy",
      "republic", "colony", "independence", "reconstruction",
      "civil rights", "legislation", "sovereignty",
    ],
  },
  LITERATURE: {
    folderHints: [
      "english", "lit", "writing", "composition", "lang", "rhetoric",
      "creative writing", "journalism",
    ],
    keywords: [
      "essay", "novel", "poem", "thesis", "analysis", "literary",
      "theme", "quote", "draft", "composition", "metaphor", "simile",
      "narrative", "rhetoric", "argument", "author", "protagonist",
      "symbolism", "allegory", "irony", "tone", "diction",
    ],
  },
  ACADEMIC_RESEARCH: {
    folderHints: [
      "seminar", "research", "capstone", "thesis", "academic",
      "ap seminar", "ap research",
    ],
    keywords: [
      "seminar", "college board", "performance task", "irr", "tmp",
      "iwa", "source", "academic", "bibliography", "citation",
      "methodology", "abstract", "peer review", "literature review",
      "research question", "annotated", "works cited",
    ],
  },
  BUSINESS: {
    folderHints: [
      "business", "fbla", "deca", "entrepreneurship", "marketing",
      "management", "accounting",
    ],
    keywords: [
      "business", "finance", "marketing", "entrepreneur", "revenue",
      "profit", "loss", "investment", "budget", "competitive",
      "market analysis", "stakeholder", "strategy", "roi",
      "supply chain", "inventory", "cash flow",
    ],
  },
  COMPUTER_SCIENCE: {
    folderHints: [
      "cs", "compsci", "programming", "coding", "apcsa", "apcsp",
      "software", "cyber",
    ],
    keywords: [
      "algorithm", "variable", "loop", "function", "class", "object",
      "array", "string", "boolean", "recursion", "iteration",
      "data structure", "binary", "compiler", "runtime", "debug",
      "api", "database", "server", "client", "html", "python", "java",
    ],
  },
};

/** Minimum number of keyword hits to trigger a Smart Group match. */
const SMART_GROUP_MIN_HITS = 3;

/** Confidence awarded by a Smart Group match. */
const SMART_GROUP_CONFIDENCE = 85;

/**
 * For each active folder, check if its name contains a Subject Group hint.
 * If it does, count how many of that group's keywords appear in the file.
 * The folder with the highest keyword density wins.
 *
 * Returns a ClassificationResult or null if no group matched well enough.
 */
function trySmartGroupMatch(
  filename: string,
  fileContent: string,
  activeFolders: string[]
): ClassificationResult | null {
  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent ?? "";
  const searchText = (nameNoExt + " " + contentHead).toLowerCase();

  // Build a scored list: { folder, group, hits, matchedKeywords }
  interface GroupScore {
    folder: string;
    group: string;
    hits: number;
    matchedKeywords: string[];
  }

  const scores: GroupScore[] = [];

  for (const folder of activeFolders) {
    if (isNoiseFolderName(folder)) continue;
    const folderLower = folder.toLowerCase();

    for (const [groupName, group] of Object.entries(SUBJECT_GROUPS)) {
      // Does this folder name match any hint for this group?
      const hintMatch = group.folderHints.some((hint) =>
        folderLower.includes(hint)
      );
      if (!hintMatch) continue;

      // Count keyword hits in the file content
      const matchedKeywords: string[] = [];
      for (const kw of group.keywords) {
        if (searchText.includes(kw)) {
          matchedKeywords.push(kw);
        }
      }

      if (matchedKeywords.length >= SMART_GROUP_MIN_HITS) {
        scores.push({
          folder,
          group: groupName,
          hits: matchedKeywords.length,
          matchedKeywords,
        });
      }
    }
  }

  if (scores.length === 0) return null;

  // Pick the folder with the most keyword hits
  scores.sort((a, b) => b.hits - a.hits);

  // Tiebreaker: if any scored folder's name appears in the filename,
  // give it a massive boost so it always wins over same-group competitors.
  // e.g. "PreCalc" in filename → PreCalc wins over Biology/Chemistry even
  // if Biology/Chemistry had more SCIENCE keyword hits from ambiguous terms.
  {
    const filenamePlain = filename.toLowerCase().replace(/[-_\s+.]/g, "");
    for (const entry of scores) {
      const folderPlain = entry.folder.toLowerCase().replace(/[-_\s+.]/g, "");
      if (folderPlain.length >= 3 && filenamePlain.includes(folderPlain)) {
        entry.hits += 10000; // filename is the strongest possible signal
      }
      // Secondary: boost if any group hint for this folder appears in filename
      const grp = SUBJECT_GROUPS[entry.group];
      if (grp) {
        for (const hint of grp.folderHints) {
          const hintPlain = hint.replace(/[-_\s+.]/g, "");
          if (hintPlain.length >= 4 && filenamePlain.includes(hintPlain)) {
            entry.hits += 100;
            break;
          }
        }
      }
    }
    scores.sort((a, b) => b.hits - a.hits);
  }

  const best = scores[0];

  const reasoning =
    `SMART GROUP: folder "${best.folder}" matched group ${best.group} — ` +
    `${best.hits} keyword(s) found: [${best.matchedKeywords.slice(0, 5).join(", ")}]`;
  console.log(`[Classification] ${reasoning}`);

  return {
    category: best.folder,
    confidence: SMART_GROUP_CONFIDENCE,
    reasoning,
    isNewFolder: false,
    detected_concepts: best.matchedKeywords.slice(0, 5),
    concept_abstraction: `${best.group} subject detected — routed to "${best.folder}"`,
    requires_review: false,
    was_noise_penalized: false,
    global_domain: "",
    global_subdomain: "",
    suggested_path: "",
    match_level: "specific",
  };
}

// ═══════════════════════════════════════════════════════════
//  STEP 1.85 — POOL MATCH (global_concepts.json + knowledge_base.json)
//
//  Reads from BOTH the global concepts pool and the legacy
//  knowledge base, merges them, and scores concept hits.
//
//  Confidence scales 60-85% based on hit count:
//    3 hits = 60%, 5 hits = 70%, 8+ hits = 85%
// ═══════════════════════════════════════════════════════════

const POOL_MIN_HITS = 3;

/**
 * Read a JSON file and return its parsed contents, or {} on failure.
 */
function readJsonFile(filePath: string): Record<string, string[]> {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {
    // Corrupt or missing — return empty
  }
  return {};
}

/**
 * Read merged concept pool: global_concepts.json + knowledge_base.json
 */
function readMergedPool(targetDir: string): Record<string, string[]> {
  const pool = readJsonFile(path.join(targetDir, "global_concepts.json"));
  const kb = readJsonFile(path.join(targetDir, "knowledge_base.json"));

  // Merge kb into pool (additive)
  for (const [cat, concepts] of Object.entries(kb)) {
    if (!pool[cat]) {
      pool[cat] = concepts;
    } else {
      pool[cat] = [...new Set([...pool[cat], ...concepts])];
    }
  }
  return pool;
}

/**
 * Scale confidence based on hit count: 3 hits = 60%, 5 = 70%, 8+ = 85%.
 */
function scalePoolConfidence(hits: number): number {
  if (hits >= 8) return 85;
  if (hits >= 5) return 70;
  if (hits >= 3) return 60;
  return 0;
}

function tryPoolMatch(
  filename: string,
  fileContent: string,
  activeFolders: string[],
  targetDir: string
): ClassificationResult | null {
  const pool = readMergedPool(targetDir);
  const categories = Object.keys(pool);
  if (categories.length === 0) return null;

  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent ?? "";
  const searchText = (nameNoExt + " " + contentHead).toLowerCase();

  if (searchText.length < 10) return null;

  // ── Distinctiveness-weighted scoring ──────────────────────────
  // Instead of scoring purely by inverse frequency (which ignores how
  // exclusive a term is to a single folder), we weight each matched term
  // by its distinctiveness score from the pool manager.
  //
  // High-distinctiveness term (score 90) matched → contributes 9x the
  // weight of a low-distinctiveness term (score 10).
  //
  // This ensures "DBQ" (100% exclusive to APUSH) beats "essay" (found
  // everywhere) even when both appear in the file.

  const totalFolders = categories.length;

  // Cross-folder term frequency (for inverse weighting as fallback).
  const conceptFreq: Record<string, number> = {};
  for (const cats of Object.values(pool as Record<string, string[]>)) {
    for (const c of cats) {
      const k = c.toLowerCase();
      conceptFreq[k] = (conceptFreq[k] || 0) + 1;
    }
  }

  // Pre-compute distinctiveness for all terms.
  // distinctiveness = (1 - foldersWithTerm / totalFolders) * 100
  function getDistinctiveness(term: string): number {
    const folderCount = conceptFreq[term.toLowerCase()] || 1;
    return Math.max(0, (1 - folderCount / totalFolders) * 100);
  }

  let bestCategory: string | null = null;
  let bestScore = 0;
  let bestHits = 0;
  let bestMatched: string[] = [];

  for (const [category, concepts] of Object.entries(pool)) {
    // Only consider categories that exist as active folders
    const folderMatch = activeFolders.find(
      (f) => f.toLowerCase() === category.toLowerCase()
    );
    if (!folderMatch) continue;

    let score = 0;
    const matched: string[] = [];
    for (const concept of concepts) {
      if (concept.length >= 3 && searchText.includes(concept.toLowerCase())) {
        matched.push(concept);
        // Weight by distinctiveness: more exclusive terms score higher.
        const distinctiveness = getDistinctiveness(concept.toLowerCase());
        score += Math.max(0.1, distinctiveness / 100);
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestHits = matched.length;
      bestCategory = folderMatch;
      bestMatched = matched;
    }
  }

  if (!bestCategory || bestHits < POOL_MIN_HITS) return null;
  // Score floor: reject pool matches too weak to be trusted.
  // Below 1.5 means fewer than 2 solid concept overlaps — let AI handle it.
  if (bestScore < 1.5) return null;

  const confidence = scalePoolConfidence(bestHits);

  const reasoning =
    `POOL MATCH: folder "${bestCategory}" matched ${bestHits} ` +
    `concept(s): [${bestMatched.slice(0, 8).join(", ")}]`;
  console.log(`[Classification] ${reasoning}`);

  return {
    category: bestCategory,
    confidence,
    reasoning,
    isNewFolder: false,
    detected_concepts: bestMatched.slice(0, 5),
    concept_abstraction: `Pool concept match — routed to "${bestCategory}"`,
    requires_review: false,
    was_noise_penalized: false,
    global_domain: "",
    global_subdomain: "",
    suggested_path: "",
    match_level: "pool",
  };
}

// ═══════════════════════════════════════════════════════════
//  STEP 1.9 — INTERNET RETRY (Datamuse lookup for file nouns)
//
//  Runs only if Pool Match scored < 40% (or returned null).
//  Extracts top nouns from filename + content, queries Datamuse
//  for each, checks overlap with folder pool concepts.
// ═══════════════════════════════════════════════════════════

const INTERNET_RETRY_CONFIDENCE = 65;
const INTERNET_RETRY_MIN_OVERLAP = 3;

/** Stopwords for noun extraction in classification context. */
const CLASSIFY_STOP_WORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with","by",
  "from","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","shall","may","might",
  "can","this","that","these","those","it","its","not","no","so","if",
  "then","than","when","where","how","what","which","who","all","each",
  "every","both","few","more","most","some","any","many","much","such",
  "very","just","also","into","over","after","before","about","as","up",
  "out","one","two","new","used","first","other","file","document","page",
]);

/**
 * Extract top N nouns from text using frequency counting.
 */
function extractNouns(text: string, count: number): string[] {
  if (!text) return [];
  const words = text.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/);
  const freq: Record<string, number> = {};
  for (const w of words) {
    if (w.length < 3 || CLASSIFY_STOP_WORDS.has(w)) continue;
    freq[w] = (freq[w] || 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([word]) => word);
}

/**
 * Fetch related words from Datamuse for a single term.
 * Uses https — lightweight lookup, max 30 results.
 */
function fetchDatamuseForTerm(term: string): Promise<string[]> {
  const https = require("https");
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(term);
    const url = `https://api.datamuse.com/words?ml=${encoded}&max=30`;
    https.get(url, (res: any) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const words = Array.isArray(parsed)
            ? parsed.map((e: any) => e.word).filter(Boolean)
            : [];
          resolve(words);
        } catch { resolve([]); }
      });
      res.on("error", () => resolve([]));
    }).on("error", () => resolve([]));
  });
}

async function tryInternetRetry(
  filename: string,
  fileContent: string,
  activeFolders: string[],
  targetDir: string
): Promise<ClassificationResult | null> {
  const pool = readMergedPool(targetDir);
  if (Object.keys(pool).length === 0) return null;

  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent ?? "";
  const nouns = extractNouns(nameNoExt + " " + contentHead, 3);
  if (nouns.length === 0) return null;

  console.log(`[Classification] INTERNET RETRY: querying Datamuse for nouns [${nouns.join(", ")}]`);

  // Fetch related words for each noun in parallel
  const apiResults = await Promise.all(nouns.map(fetchDatamuseForTerm));
  const allApiWords = new Set(apiResults.flat());

  // Check overlap with each folder's pool concepts
  const conceptFreq: Record<string, number> = {};
  for (const cats of Object.values(pool as Record<string, string[]>)) {
    for (const c of cats) {
      const k = c.toLowerCase();
      conceptFreq[k] = (conceptFreq[k] || 0) + 1;
    }
  }

  let bestFolder: string | null = null;
  let bestOverlap = 0;
  let bestScore = 0;
  let bestOverlapWords: string[] = [];

  for (const [category, concepts] of Object.entries(pool)) {
    const folderMatch = activeFolders.find(
      (f) => f.toLowerCase() === category.toLowerCase()
    );
    if (!folderMatch) continue;

    let score = 0;
    const overlap: string[] = [];
    for (const concept of concepts) {
      if (concept.length >= 3 && allApiWords.has(concept.toLowerCase())) {
        overlap.push(concept);
        const freq = conceptFreq[concept.toLowerCase()] || 1;
        score += 1 / freq;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestOverlap = overlap.length;
      bestFolder = folderMatch;
      bestOverlapWords = overlap;
    }
  }

  if (!bestFolder || bestOverlap < INTERNET_RETRY_MIN_OVERLAP) return null;

  // Side effect: save newly discovered concepts to global_concepts.json
  // Uses pool manager validation to prevent pollution.
  try {
    const datamuseStopWords = new Set([
      "the","and","for","with","from","this","that","have","will",
      "your","they","been","were","are","its","has","but","not",
    ]);
    const candidateConcepts = [...allApiWords].filter(
      (w) => w.length >= 4 && !datamuseStopWords.has(w.toLowerCase())
    );
    // addTermsToPool handles deduplication and validation internally.
    const added = addTermsToPool(candidateConcepts.slice(0, 30), bestFolder!, targetDir);
    if (added > 0) {
      console.log(`[Classification] INTERNET RETRY: added ${added} validated concepts to "${bestFolder}" pool`);
    }
  } catch {}

  const reasoning =
    `INTERNET RETRY: nouns [${nouns.join(", ")}] → Datamuse → ${bestOverlap} overlap(s) ` +
    `with "${bestFolder}": [${bestOverlapWords.slice(0, 5).join(", ")}]`;
  console.log(`[Classification] ${reasoning}`);

  return {
    category: bestFolder,
    confidence: INTERNET_RETRY_CONFIDENCE,
    reasoning,
    isNewFolder: false,
    detected_concepts: bestOverlapWords.slice(0, 5),
    concept_abstraction: `Internet retry match — routed to "${bestFolder}"`,
    requires_review: false,
    was_noise_penalized: false,
    global_domain: "",
    global_subdomain: "",
    suggested_path: "",
    match_level: "pool",
  };
}

// ═══════════════════════════════════════════════════════════
//  STEP 1.95 — DEEP LINK MATCH (reverse Datamuse lookup)
//
//  When a file matches NO existing keywords, extract top 5 nouns,
//  reverse-query Datamuse ("What is 'Plantation' related to?"),
//  then check if the returned words match:
//    a) A folder NAME directly (weighted higher), or
//    b) Any folder's pool concepts.
//
//  This catches cases like a file about "Plantation agriculture"
//  matching folder "APUSH" because Datamuse returns "history",
//  "colonial", etc. which overlap with APUSH's pool.
// ═══════════════════════════════════════════════════════════

const DEEP_LINK_CONFIDENCE = 62;
const DEEP_LINK_MIN_OVERLAP = 2;

async function tryDeepLinkMatch(
  filename: string,
  fileContent: string,
  activeFolders: string[],
  targetDir: string
): Promise<ClassificationResult | null> {
  const pool = readMergedPool(targetDir);
  if (activeFolders.length === 0) return null;

  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent ?? "";
  const nouns = extractNouns(nameNoExt + " " + contentHead, 5);
  if (nouns.length === 0) return null;

  console.log(`[Classification] DEEP LINK MATCH: reverse-querying Datamuse for nouns [${nouns.join(", ")}]`);

  // Reverse query: for each noun, get related words from Datamuse
  const apiResults = await Promise.all(nouns.map(fetchDatamuseForTerm));
  const allApiWords = new Set(apiResults.flat().map((w: string) => w.toLowerCase()));

  if (allApiWords.size === 0) return null;

  // Score each folder by:
  //   a) Folder name words appearing in API results (weighted x3)
  //   b) Pool concepts overlapping with API results (weighted x1)
  const conceptFreq: Record<string, number> = {};
  for (const cats of Object.values(pool as Record<string, string[]>)) {
    for (const c of cats) {
      const k = c.toLowerCase();
      conceptFreq[k] = (conceptFreq[k] || 0) + 1;
    }
  }

  let bestFolder: string | null = null;
  let bestScore = 0;
  let bestEvidence: string[] = [];

  for (const folder of activeFolders) {
    if (isNoiseFolderName(folder)) continue;

    let score = 0;
    const evidence: string[] = [];

    // a) Check if API words match folder name words (high weight)
    const nameWords = folder.toLowerCase().replace(/[-_]/g, " ").split(/\s+/).filter((w) => w.length >= 2);
    for (const nw of nameWords) {
      if (allApiWords.has(nw)) {
        score += 3;
        evidence.push(`name:"${nw}"`);
      }
    }

    // b) Check overlap with pool concepts (normal weight)
    const concepts = pool[folder] || [];
    for (const concept of concepts) {
      if (concept.length >= 3 && allApiWords.has(concept.toLowerCase())) {
        const freq = conceptFreq[concept.toLowerCase()] || 1;
        score += 1 / freq;
        evidence.push(concept);
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestFolder = folder;
      bestEvidence = evidence;
    }
  }

  // Need minimum overlap to be confident
  if (!bestFolder || bestScore < DEEP_LINK_MIN_OVERLAP) return null;

  // Side effect: save newly discovered concepts to the matched folder's pool.
  // Uses pool manager validation to prevent pollution.
  try {
    const datamuseStopWords = new Set([
      "the","and","for","with","from","this","that","have","will",
      "your","they","been","were","are","its","has","but","not",
    ]);
    const candidateConcepts = [...allApiWords].filter(
      (w) => w.length >= 4 && !datamuseStopWords.has(w.toLowerCase())
    );
    const added = addTermsToPool(candidateConcepts.slice(0, 25), bestFolder!, targetDir);
    if (added > 0) {
      console.log(`[Classification] DEEP LINK: added ${added} validated concepts to "${bestFolder}" pool`);
    }
  } catch {}

  const reasoning =
    `DEEP LINK MATCH: nouns [${nouns.join(", ")}] → Datamuse reverse lookup → ` +
    `matched "${bestFolder}" (score=${bestScore}): [${bestEvidence.slice(0, 6).join(", ")}]`;
  console.log(`[Classification] ${reasoning}`);

  return {
    category: bestFolder,
    confidence: DEEP_LINK_CONFIDENCE,
    reasoning,
    isNewFolder: false,
    detected_concepts: bestEvidence.slice(0, 5),
    concept_abstraction: `Deep Link reverse match — routed to "${bestFolder}"`,
    requires_review: false,
    was_noise_penalized: false,
    global_domain: "",
    global_subdomain: "",
    suggested_path: "",
    match_level: "pool",
  };
}

// ═══════════════════════════════════════════════════════════
//  STEP 1.97 — ENTITY RECOGNITION (Wikipedia-backed)
//
//  Extract capitalized multi-word proper nouns from file content
//  (e.g., "Solomon Northup", "Slave Narratives"), query Wikipedia
//  for each entity's summary, then match summary keywords against
//  folder pool concepts to find the best folder.
//
//  This catches files like "Slave Narratives.pdf" that mention
//  historical figures — Wikipedia connects them to "History" domain
//  which overlaps with the APUSH folder's pool.
//
//  PRIVACY: Only extracted entity names are sent to Wikipedia REST API.
//  NO file content is uploaded.
// ═══════════════════════════════════════════════════════════

const ENTITY_RECOGNITION_CONFIDENCE = 68;
const ENTITY_MIN_POOL_OVERLAP = 2;

/**
 * Extract capitalized multi-word proper nouns from text.
 * Returns unique entities like ["Solomon Northup", "Slave Narratives"].
 */
function extractEntities(text: string): string[] {
  if (!text) return [];
  // Match sequences of 2+ capitalized words (e.g., "Solomon Northup")
  const matches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
  // Also match all-caps acronyms with context (e.g., "APUSH")
  const acronyms = text.match(/\b[A-Z]{2,}\b/g) || [];
  // Deduplicate and filter out very common phrases
  const commonPhrases = new Set(["The", "This", "That", "These", "Those", "United States"]);
  const entities = [...new Set([...matches, ...acronyms])]
    .filter((e) => !commonPhrases.has(e) && e.length >= 3)
    .slice(0, 5); // Max 5 entities to limit API calls
  return entities;
}

/**
 * Fetch Wikipedia summary for an entity and extract keywords.
 * Returns array of lowercase keywords from the summary.
 * PRIVACY: Only the entity name is sent to Wikipedia.
 */
function fetchEntitySummary(entity: string): Promise<string[]> {
  const https = require("https");
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(entity.replace(/\s+/g, "_"));
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`;
    https.get(url, { headers: { "User-Agent": "AIOrganizer/1.0" } }, (res: any) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const extract = parsed.extract || "";
          // Split into keywords, filter stopwords
          const words = extract
            .toLowerCase()
            .replace(/[^a-z\s]/g, " ")
            .split(/\s+/)
            .filter((w: string) => w.length >= 3 && !CLASSIFY_STOP_WORDS.has(w));
          resolve([...new Set(words)]);
        } catch { resolve([]); }
      });
      res.on("error", () => resolve([]));
    }).on("error", () => resolve([]));
  });
}

/**
 * Entity Recognition step: extract proper nouns from file content,
 * query Wikipedia for each, check if summary keywords overlap with
 * any folder's pool concepts.
 */
async function tryEntityRecognition(
  filename: string,
  fileContent: string,
  activeFolders: string[],
  targetDir: string
): Promise<ClassificationResult | null> {
  const pool = readMergedPool(targetDir);
  if (Object.keys(pool).length === 0) return null;

  // Extract entities from first 1000 chars of content + filename
  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent ?? "";
  const entities = extractEntities(nameNoExt + " " + contentHead);
  if (entities.length === 0) return null;

  console.log(`[Classification] ENTITY RECOGNITION: found entities [${entities.join(", ")}]`);

  // Query Wikipedia for each entity (parallel, max 5)
  const summaryResults = await Promise.all(entities.map(fetchEntitySummary));
  const allSummaryWords = new Set(summaryResults.flat());

  if (allSummaryWords.size === 0) return null;

  // Score each folder by overlap between Wikipedia summary keywords and pool concepts
  const conceptFreq: Record<string, number> = {};
  for (const cats of Object.values(pool as Record<string, string[]>)) {
    for (const c of cats) {
      const k = c.toLowerCase();
      conceptFreq[k] = (conceptFreq[k] || 0) + 1;
    }
  }

  let bestFolder: string | null = null;
  let bestOverlap = 0;
  let bestScore = 0;
  let bestEvidence: string[] = [];

  for (const [category, concepts] of Object.entries(pool)) {
    const folderMatch = activeFolders.find(
      (f) => f.toLowerCase() === category.toLowerCase()
    );
    if (!folderMatch) continue;

    let score = 0;
    const overlap: string[] = [];
    for (const concept of concepts) {
      if (concept.length >= 3 && allSummaryWords.has(concept.toLowerCase())) {
        overlap.push(concept);
        const freq = conceptFreq[concept.toLowerCase()] || 1;
        score += 1 / freq;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestOverlap = overlap.length;
      bestFolder = folderMatch;
      bestEvidence = overlap;
    }
  }

  if (!bestFolder || bestOverlap < ENTITY_MIN_POOL_OVERLAP) return null;

  const reasoning =
    `ENTITY RECOGNITION: entities [${entities.join(", ")}] → Wikipedia → ` +
    `${bestOverlap} pool overlap(s) with "${bestFolder}": [${bestEvidence.slice(0, 5).join(", ")}]`;
  console.log(`[Classification] ${reasoning}`);

  return {
    category: bestFolder,
    confidence: ENTITY_RECOGNITION_CONFIDENCE,
    reasoning,
    isNewFolder: false,
    detected_concepts: bestEvidence.slice(0, 5),
    concept_abstraction: `Historical Entity Match — routed to "${bestFolder}"`,
    requires_review: false,
    was_noise_penalized: false,
    global_domain: "",
    global_subdomain: "",
    suggested_path: "",
    match_level: "pool",
  };
}

// ═══════════════════════════════════════════════════════════
//  SMART ARBITER — Density-Weighted Conflict Detection
//
//  Three-layer filter before declaring a True Conflict:
//
//   1. DENSITY SCORING — keyword frequency / total word count.
//      If a category's density < 5%, it was a "brief mention" → DROP it.
//
//   2. SPECIFICITY OVERRIDE — if Category A's matched keywords are
//      a subset of Category B's pool, B is the more specific topic.
//      "Specific beats General" → B auto-wins.
//
//   3. TRUE CONFLICT — only when both scores are >70% AND neither
//      topic is a subset of the other (e.g., Biology vs History).
//
//  Priority rules (saved from user corrections) are checked LAST
//  and can override even a True Conflict.
// ═══════════════════════════════════════════════════════════

/** Minimum confidence for BOTH categories before a conflict is considered. */
const CONFLICT_THRESHOLD = 70;

/** Drop a candidate if its keyword density (hits / total words) < this. */
const DENSITY_MIN_PERCENT = 5;

/**
 * What fraction of Category A's matched keywords are also found inside
 * Category B's full pool? If > this threshold, A is a "parent" of B
 * (or B is a sub-topic of A) and the more specific topic auto-wins.
 */
const SUBSET_OVERLAP_THRESHOLD = 0.5;

interface PoolScore {
  folder: string;
  hits: number;
  confidence: number;
  matched: string[];
  /** Keyword density: (matched keyword count / total words in text) × 100 */
  density: number;
}

/**
 * Score ALL pool categories for a given file with density scoring.
 *
 * Density = (number of matched keywords / total word count) × 100.
 * Categories with density < DENSITY_MIN_PERCENT are dropped immediately
 * ("brief mention" filter — mentioning "FBLA" once in the footer ≠ a match).
 *
 * Returns sorted array (highest confidence first), already pruned.
 */
function scoreAllPoolCategories(
  filename: string,
  fileContent: string,
  activeFolders: string[],
  targetDir: string
): PoolScore[] {
  const pool = readMergedPool(targetDir);
  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent ?? "";
  const searchText = (nameNoExt + " " + contentHead).toLowerCase();
  const totalWords = searchText.split(/\s+/).filter((w) => w.length >= 2).length;

  if (searchText.length < 10 || totalWords < 3) return [];

  const conceptFreq: Record<string, number> = {};
  for (const cats of Object.values(pool as Record<string, string[]>)) {
    for (const c of cats) {
      const k = c.toLowerCase();
      conceptFreq[k] = (conceptFreq[k] || 0) + 1;
    }
  }

  const scores: PoolScore[] = [];

  for (const [category, concepts] of Object.entries(pool)) {
    const folderMatch = activeFolders.find(
      (f) => f.toLowerCase() === category.toLowerCase()
    );
    if (!folderMatch) continue;

    let score = 0;
    const matched: string[] = [];
    for (const concept of concepts) {
      if (concept.length >= 3 && searchText.includes(concept.toLowerCase())) {
        matched.push(concept);
        const freq = conceptFreq[concept.toLowerCase()] || 1;
        score += 1 / freq;
      }
    }

    if (matched.length < POOL_MIN_HITS) continue;

    // ── Density scoring: what % of this category's known concepts appear in the file ──
    const categoryConceptCount = concepts.length;
    if (categoryConceptCount === 0) continue;
    const density = (matched.length / categoryConceptCount) * 100;

    // DROP "brief mentions" — matching a tiny fraction of a large pool is noise
    if (density < DENSITY_MIN_PERCENT) {
      console.log(
        `[Classification] DENSITY DROP: "${folderMatch}" density ${density.toFixed(1)}% ` +
        `(${matched.length}/${categoryConceptCount} concepts) < ${DENSITY_MIN_PERCENT}% — ignored as brief mention`
      );
      continue;
    }

    scores.push({
      folder: folderMatch,
      hits: score,
      confidence: scalePoolConfidence(matched.length),
      matched,
      density,
    });
  }

  scores.sort((a, b) => b.hits - a.hits || b.confidence - a.confidence);
  return scores;
}

/**
 * Check if Category A's matched keywords are a subset of Category B's pool.
 * Returns true if >50% of A's matched keywords appear in B's pool concepts.
 * This means B is a more specific sub-topic that contains A's domain.
 */
function isSubsetOf(
  matchedKeywordsA: string[],
  poolConceptsB: string[]
): boolean {
  if (matchedKeywordsA.length === 0) return false;
  const poolSetB = new Set(poolConceptsB.map((c) => c.toLowerCase()));
  let overlapCount = 0;
  for (const kw of matchedKeywordsA) {
    if (poolSetB.has(kw.toLowerCase())) overlapCount++;
  }
  return overlapCount / matchedKeywordsA.length >= SUBSET_OVERLAP_THRESHOLD;
}

/**
 * Read priority_rules.json from targetDir.
 */
function readPriorityRulesFile(targetDir: string): Array<{
  keywords: string[];
  winner: string;
  losers: string[];
  conflictCategories: string[];
}> {
  const rulesPath = path.join(targetDir, "priority_rules.json");
  try {
    if (fs.existsSync(rulesPath)) {
      return JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
    }
  } catch {}
  return [];
}

/**
 * Smart Arbiter: detect conflicts with density filtering + specificity override.
 *
 * Flow:
 *   1. Score all categories (density-filtered — brief mentions already dropped).
 *   2. If < 2 strong candidates remain, no conflict → return null.
 *   3. SPECIFICITY OVERRIDE: if one topic's keywords are a subset of the other's
 *      pool, the more specific topic auto-wins ("Specific beats General").
 *   4. Check saved PRIORITY RULES for a learned resolution.
 *   5. TRUE CONFLICT: neither is a subset → "Needs Review" with conflict tag.
 *
 * Returns a ClassificationResult if conflict is detected/resolved, or null.
 */
function detectPoolConflicts(
  filename: string,
  fileContent: string,
  activeFolders: string[],
  targetDir: string
): ClassificationResult | null {
  const allScores = scoreAllPoolCategories(filename, fileContent, activeFolders, targetDir);
  if (allScores.length < 2) return null;

  // Find categories with confidence >= CONFLICT_THRESHOLD (70%)
  const strongCategories = allScores.filter((s) => s.confidence >= CONFLICT_THRESHOLD);
  if (strongCategories.length < 2) return null;

  const pool = readMergedPool(targetDir);

  // ── SPECIFICITY OVERRIDE: check parent-child relationships ──
  // For each pair, check if one's matched keywords are a subset of the other's pool.
  // If so, the more specific (child) topic auto-wins.
  for (let i = 0; i < strongCategories.length; i++) {
    for (let j = i + 1; j < strongCategories.length; j++) {
      const catA = strongCategories[i];
      const catB = strongCategories[j];
      const poolA = pool[catA.folder] || [];
      const poolB = pool[catB.folder] || [];

      // Is A's matched keywords found inside B's pool? (B is more specific, contains A's domain)
      const aInsideB = isSubsetOf(catA.matched, poolB);
      // Is B's matched keywords found inside A's pool? (A is more specific, contains B's domain)
      const bInsideA = isSubsetOf(catB.matched, poolA);

      if (aInsideB && !bInsideA) {
        // B is more specific — B auto-wins
        const reasoning =
          `SPECIFICITY OVERRIDE: "${catA.folder}" keywords found inside "${catB.folder}" pool → ` +
          `"${catB.folder}" wins (Specific beats General). ` +
          `Density: ${catA.folder}=${catA.density.toFixed(1)}%, ${catB.folder}=${catB.density.toFixed(1)}%`;
        console.log(`[Classification] ${reasoning}`);

        return {
          category: catB.folder,
          confidence: catB.confidence,
          reasoning,
          isNewFolder: false,
          detected_concepts: catB.matched.slice(0, 5),
          concept_abstraction: `Specificity override — "${catB.folder}" is more specific than "${catA.folder}"`,
          requires_review: false,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: "pool",
        };
      }

      if (bInsideA && !aInsideB) {
        // A is more specific — A auto-wins
        const reasoning =
          `SPECIFICITY OVERRIDE: "${catB.folder}" keywords found inside "${catA.folder}" pool → ` +
          `"${catA.folder}" wins (Specific beats General). ` +
          `Density: ${catA.folder}=${catA.density.toFixed(1)}%, ${catB.folder}=${catB.density.toFixed(1)}%`;
        console.log(`[Classification] ${reasoning}`);

        return {
          category: catA.folder,
          confidence: catA.confidence,
          reasoning,
          isNewFolder: false,
          detected_concepts: catA.matched.slice(0, 5),
          concept_abstraction: `Specificity override — "${catA.folder}" is more specific than "${catB.folder}"`,
          requires_review: false,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: "pool",
        };
      }

      // If BOTH are subsets of each other, fall through to priority rules / true conflict
    }
  }

  // ── PRIORITY RULES: check saved user resolutions ──
  const conflictNames = strongCategories.map((s) => s.folder);
  console.log(
    `[Classification] TRUE CONFLICT CANDIDATE: ${conflictNames.join(" vs ")} ` +
    `(${strongCategories.map((s) => `${s.folder}=${s.confidence}% density=${s.density.toFixed(1)}%`).join(", ")})`
  );

  const rules = readPriorityRulesFile(targetDir);
  for (const rule of rules) {
    const ruleSet = new Set(rule.conflictCategories.map((c) => c.toLowerCase()));
    const conflictSet = new Set(conflictNames.map((c) => c.toLowerCase()));

    const isMatch = [...conflictSet].every((c) => ruleSet.has(c));
    if (isMatch && conflictNames.map((c) => c.toLowerCase()).includes(rule.winner.toLowerCase())) {
      const actualWinner = activeFolders.find(
        (f) => f.toLowerCase() === rule.winner.toLowerCase()
      ) || rule.winner;
      const winnerScore = strongCategories.find(
        (s) => s.folder.toLowerCase() === rule.winner.toLowerCase()
      );

      const reasoning =
        `PRIORITY RULE: conflict [${conflictNames.join(" vs ")}] auto-resolved → ` +
        `"${actualWinner}" (saved rule from previous correction)`;
      console.log(`[Classification] ${reasoning}`);

      return {
        category: actualWinner,
        confidence: winnerScore?.confidence || 80,
        reasoning,
        isNewFolder: false,
        detected_concepts: winnerScore?.matched.slice(0, 5) || [],
        concept_abstraction: `Priority rule resolved conflict — routed to "${actualWinner}"`,
        requires_review: false,
        was_noise_penalized: false,
        global_domain: "",
        global_subdomain: "",
        suggested_path: "",
        match_level: "pool",
      };
    }
  }

  // ── TRUE CONFLICT: neither is a subset, no priority rule ──
  const reasoning =
    `TRUE CONFLICT: ${conflictNames.join(" vs ")} both scored >=${CONFLICT_THRESHOLD}%, ` +
    `neither is a sub-topic of the other. ` +
    `Scores: ${strongCategories.map((s) => `${s.folder}=${s.confidence}% (density ${s.density.toFixed(1)}%)`).join(", ")}. ` +
    `Routed to Needs Review for manual resolution.`;
  console.log(`[Classification] ${reasoning}`);

  return {
    category: "Needs Review",
    confidence: 0,
    reasoning,
    isNewFolder: false,
    detected_concepts: strongCategories[0].matched.slice(0, 5),
    concept_abstraction: `True Conflict — ${conflictNames.join(" vs ")}`,
    requires_review: true,
    was_noise_penalized: false,
    global_domain: "",
    global_subdomain: "",
    suggested_path: "",
    match_level: "fallback",
    conflict_categories: conflictNames,
  };
}

// ═══════════════════════════════════════════════════════════
//  STEP 1.98 — SIBLING FILE SIGNAL (FIX 3)
//
//  "Chapter 8 Textbook Pages.pdf" next to several already-
//  classified "Chapter N APUSH Notes.pdf" files is extremely
//  strong evidence the new file is also APUSH.
//
//  Searches the existing search index for files with:
//    • A similar naming pattern (shared prefix or "Chapter N" style)
//    • Same file extension
//    • Indexed within 48 h of the current file
//  If 2 + siblings live in the same non-noise folder, return a
//  +40 confidence boost for that folder.
// ═══════════════════════════════════════════════════════════

const SIBLING_TIME_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours
const SIBLING_MIN_COUNT = 2;
const SIBLING_MIN_CONFIDENCE = 80;
const SIBLING_BOOST = 40;

/**
 * Extract a stable "naming pattern" from a filename.
 * Returns a query string suitable for the search index.
 * e.g.  "Chapter 8 APUSH Notes.pdf"  → "Chapter APUSH"
 *       "Week 3 Biology Lab.pdf"      → "Week Biology"
 *       "FBLA Business Plan 2025.pdf" → "FBLA Business Plan"
 */
function extractNamingPattern(filename: string): string | null {
  const nameNoExt = filename.replace(/\.[^.]+$/, "");

  // Pattern: numbered sequence ("Chapter 8", "Unit 3", "Lecture 5", "Week 2", "Part IV")
  const sequenceMatch = nameNoExt.match(
    /^(.*?)\s*(?:chapter|unit|week|lecture|module|part|section|lesson|period|lab)\s*(?:\d+|[IVX]+)/i
  );
  if (sequenceMatch) {
    const prefix = sequenceMatch[1].trim();
    // Also capture subject words after the number
    const afterNum = nameNoExt.replace(sequenceMatch[0], "").trim();
    const combined = [prefix, afterNum].filter((s) => s.length >= 2).join(" ").trim();
    if (combined.length >= 3) return combined;
  }

  // Pattern: generic numbered "APUSH Notes 7", "Bio Lab 3"
  const numberedMatch = nameNoExt.match(/^(.+?)\s+\d+\s*$/);
  if (numberedMatch && numberedMatch[1].trim().length >= 4) {
    return numberedMatch[1].trim();
  }

  // Fall back to first 3 meaningful words
  const words = nameNoExt
    .replace(/\d+/g, "")
    .replace(/[-_]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  if (words.length >= 2) return words.slice(0, 3).join(" ");

  return null;
}

/**
 * Check the search index for files with a similar naming pattern.
 * Returns a boost record if enough siblings live in the same folder,
 * or null if the signal is too weak.
 */
async function trySiblingSignal(
  filename: string,
  filePath: string,
  activeFolders: string[]
): Promise<{ folder: string; boost: number; count: number } | null> {
  const searchFn = getIndexSearch();
  if (!searchFn) return null;

  const pattern = extractNamingPattern(filename);
  if (!pattern) return null;

  const ext = path.extname(filename).toLowerCase();

  // Get modification time of the file being classified
  let currentMtime = Date.now();
  try {
    const stat = fs.statSync(filePath);
    currentMtime = stat.mtimeMs;
  } catch {}

  let results: Array<{ filename: string; folder: string; timestamp: number; fullPath: string }> = [];
  try {
    results = searchFn(pattern, 30);
  } catch {
    return null;
  }

  // Filter: same extension, within 48 h of current file, non-noise folder, high confidence
  const siblings = results.filter((r) => {
    if (path.extname(r.filename).toLowerCase() !== ext) return false;
    if (isNoiseFolderName(r.folder)) return false;
    if (!activeFolders.some((f) => f.toLowerCase() === r.folder.toLowerCase())) return false;
    const timeDiff = Math.abs(r.timestamp - currentMtime);
    return timeDiff <= SIBLING_TIME_WINDOW_MS;
  });

  if (siblings.length < SIBLING_MIN_COUNT) return null;

  // Count occurrences per folder
  const folderCounts: Record<string, number> = {};
  for (const s of siblings) {
    const folderKey = s.folder.toLowerCase();
    folderCounts[folderKey] = (folderCounts[folderKey] || 0) + 1;
  }

  // Find the most common folder
  const best = Object.entries(folderCounts).sort(([, a], [, b]) => b - a)[0];
  if (!best || best[1] < SIBLING_MIN_COUNT) return null;

  const actualFolder = activeFolders.find((f) => f.toLowerCase() === best[0]);
  if (!actualFolder) return null;

  console.log(
    `[Classification] Sibling signal: ${best[1]} similar files already in "${actualFolder}" — boosting confidence`
  );

  return { folder: actualFolder, boost: SIBLING_BOOST, count: best[1] };
}

// ═══════════════════════════════════════════════════════════
//  STEP 2-a — GLOBAL DOMAIN CLASSIFIER (zero-shot)
// ═══════════════════════════════════════════════════════════

async function classifyGlobalDomain(
  filename: string,
  extension: string,
  fileContent: string
): Promise<GlobalDomainResult | null> {
  const domainList = Object.entries(GLOBAL_DOMAINS)
    .map(([name, cfg]) => `- ${name}: ${cfg.examples}`)
    .join("\n");

  const contentPreview = fileContent
    ? fileContent.split(/\s+/).slice(0, DOMAIN_CLASSIFIER_WORDS).join(" ")
    : "";

  const prompt = [
    "Classify this document into exactly ONE domain and identify its specific sub-topic.",
    "",
    "DOMAINS:",
    domainList,
    "",
    `Filename: ${filename}`,
    extension ? `Type: ${extension}` : "",
    "",
    contentPreview
      ? `CONTENT (first ${DOMAIN_CLASSIFIER_WORDS} words):\n${contentPreview}`
      : "No content available. Classify by filename only.",
    "",
    "Respond with ONLY valid JSON:",
    '{"domain": "Education", "subdomain": "US History", "confidence": 85}',
    "",
    "Rules:",
    "- Pick exactly ONE domain from the list above.",
    '- subdomain: Be as SPECIFIC as possible. "AP US History" is better than "History".',
    '  "Tax Returns" is better than "Finance". "AP Seminar" is better than "School".',
    "- confidence: 0-100. How clearly does this content fit the domain?",
  ].join("\n");

  try {
    const raw = await callOllama("", prompt, {
      numCtx: 2048,
      timeout: 30_000,
    });

    let cleaned = raw.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];

    const parsed = JSON.parse(cleaned);
    const rawDomain = String(parsed.domain || "").trim();
    const subdomain = String(parsed.subdomain || "").trim();
    const confidence = Math.min(100, Math.max(0, Number(parsed.confidence) || 0));

    const domain =
      Object.keys(GLOBAL_DOMAINS).find(
        (d) => d.toLowerCase() === rawDomain.toLowerCase()
      ) || "";

    if (domain) {
      console.log(
        `[Classification] STEP 2a — Global domain: ${domain} / ${subdomain} (${confidence}%)`
      );
      return { domain, subdomain, confidence };
    }

    console.warn(`[Classification] STEP 2a — Unrecognised domain "${rawDomain}"`);
    return null;
  } catch (err) {
    console.warn(`[Classification] STEP 2a — Global domain call failed: ${err}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
//  AUTO-HIERARCHY helpers
// ═══════════════════════════════════════════════════════════

// ── Duplicate Folder Prevention ──────────────────────────────
// Catches near-duplicates like "precalc" vs "precalculus", "Pre-Calc" vs "PreCalc",
// "AP Bio" vs "APBio", etc. before a new folder is ever created.

/**
 * Normalize a name for fuzzy comparison:
 * lowercase, strip hyphens/underscores/spaces/dots/plus-signs, collapse "pre" prefixes.
 */
function normForDedup(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_\s+.]/g, "")      // "Pre-Calc" → "precalc"
    .replace(/\b(pre)\b/g, "pre");  // keep "pre" as-is
}

/**
 * Build a set of stem variants for a name so we can catch abbreviations.
 * e.g. "precalculus" → ["precalculus", "precalc"]
 *      "biology"     → ["biology", "bio"]
 *      "statistics"  → ["statistics", "stats"]
 */
const COMMON_ABBREVS: [RegExp, string][] = [
  [/calculus$/i,     "calc"],
  [/precalculus$/i,  "precalc"],
  [/biology$/i,      "bio"],
  [/chemistry$/i,    "chem"],
  [/physics$/i,      "phys"],
  [/statistics$/i,   "stats"],
  [/psychology$/i,   "psych"],
  [/economics$/i,    "econ"],
  [/government$/i,   "gov"],
  [/geography$/i,    "geo"],
  [/literature$/i,   "lit"],
  [/philosophy$/i,   "phil"],
  [/sociology$/i,    "soc"],
  [/technology$/i,   "tech"],
  [/engineering$/i,  "eng"],
  [/trigonometry$/i, "trig"],
  [/environmental$/i,"enviro"],
  [/^bio$/i,         "biology"],
  [/^chem$/i,        "chemistry"],
  [/^calc$/i,        "calculus"],
  [/^precalc$/i,     "precalculus"],
  [/^stats$/i,       "statistics"],
  [/^psych$/i,       "psychology"],
  [/^econ$/i,        "economics"],
  [/^gov$/i,         "government"],
  [/^geo$/i,         "geography"],
  [/^lit$/i,         "literature"],
  [/^phil$/i,        "philosophy"],
  [/^trig$/i,        "trigonometry"],
  [/^phys$/i,        "physics"],
  [/^eng$/i,         "engineering"],
];

function getNameVariants(name: string): Set<string> {
  const norm = normForDedup(name);
  const variants = new Set([norm]);

  for (const [pattern, replacement] of COMMON_ABBREVS) {
    if (pattern.test(norm)) {
      variants.add(normForDedup(norm.replace(pattern, replacement)));
    }
  }

  return variants;
}

/**
 * Given an AI-suggested folder name, find an existing folder that is
 * semantically equivalent. Returns the existing folder name if found, or null.
 *
 * Strategies (in order):
 *  1. Exact match (case-insensitive)
 *  2. Normalized match (strip hyphens/spaces/underscores)
 *  3. Abbreviation expansion (precalc ↔ precalculus, bio ↔ biology)
 *  4. Substring containment for short names (one contains the other after normalization)
 */
export function findExistingEquivalent(
  suggestedName: string,
  existingFolders: string[]
): string | null {
  if (!suggestedName || existingFolders.length === 0) return null;

  const sugNorm = normForDedup(suggestedName);
  const sugVariants = getNameVariants(suggestedName);

  for (const folder of existingFolders) {
    const folderNorm = normForDedup(folder);

    // Strategy 1: Normalized exact match ("Pre-Calc" ↔ "PreCalc" ↔ "precalc")
    if (sugNorm === folderNorm) return folder;

    // Strategy 2: Abbreviation match ("precalculus" ↔ "precalc", "bio" ↔ "biology")
    const folderVariants = getNameVariants(folder);
    for (const sv of sugVariants) {
      if (folderVariants.has(sv)) return folder;
    }

    // Strategy 3: One fully contains the other (only for meaningful-length names)
    // "precalc" is contained in "precalculus" — they're the same subject
    if (sugNorm.length >= 3 && folderNorm.length >= 3) {
      if (sugNorm.includes(folderNorm) || folderNorm.includes(sugNorm)) {
        // Only match if the shorter is at least 60% of the longer to avoid
        // false positives like "art" matching "artificial"
        const shorter = Math.min(sugNorm.length, folderNorm.length);
        const longer = Math.max(sugNorm.length, folderNorm.length);
        if (shorter / longer >= 0.6) return folder;
      }
    }
  }

  return null;
}

function sanitizeFolderName(name: string): string {
  return name
    .replace(/[<>:"|?*\x00-\x1f]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 40) || "Misc";
}

function buildSuggestedPath(
  globalDomain: GlobalDomainResult | null,
  validFolders: string[],
  aiSuggestedName: string
): string {
  if (aiSuggestedName.includes("/")) {
    return aiSuggestedName.split("/").map(sanitizeFolderName).join("/");
  }

  if (!globalDomain?.domain) {
    return sanitizeFolderName(aiSuggestedName);
  }

  const domainCfg = GLOBAL_DOMAINS[globalDomain.domain];
  if (!domainCfg) return sanitizeFolderName(aiSuggestedName);

  const child = sanitizeFolderName(
    aiSuggestedName || globalDomain.subdomain || globalDomain.domain
  );

  for (const hint of domainCfg.folderHints) {
    const existing = validFolders.find(
      (f) => f.toLowerCase() === hint.toLowerCase()
    );
    if (existing) return `${existing}/${child}`;
  }

  return `${domainCfg.folderHints[0]}/${child}`;
}

// ═══════════════════════════════════════════════════════════
//  STEP 2-b — DOMAIN-AWARE PROMPT  (Specific Match)
// ═══════════════════════════════════════════════════════════

function buildSystemPrompt(
  folderContextMap: RichFolderContextMap,
  globalDomain: GlobalDomainResult | null,
  folderNames?: string[],
  currentFilename?: string,
  currentExtension?: string
): string {
  // Pass current filename + extension so LearningService scores corrections
  // by term overlap (similar filenames surface as better few-shot examples).
  const learningBlock = buildLearningBlock(currentFilename, currentExtension);
  const domainActive =
    globalDomain !== null &&
    globalDomain.confidence >= DOMAIN_CONFIDENCE_THRESHOLD;

  const folderDescriptions: string[] = [];
  let folderCount = 0;

  for (const [folderName, context] of Object.entries(folderContextMap)) {
    if (context.isNoiseFolder) continue;

    folderCount++;
    const lines: string[] = [`  📁 ${folderName}`];
    // Cold-start fix: inject folder name words as implicit keywords
    const folderNameWords = folderName.split(/[\s_-]+/).filter((w: string) => w.length >= 3).map((w: string) => w.toLowerCase());
    const combinedKw = context.autoKeywords
      ? `${folderNameWords.join(", ")}, ${context.autoKeywords}`
      : folderNameWords.join(", ");
    lines.push(`     Keywords: [${combinedKw}]`);

    if (context.coreTopics) {
      lines.push(`     ⭐ Core Topics: ${context.coreTopics}`);
    }

    folderDescriptions.push(lines.join("\n"));
  }

  const parts: string[] = [];

  if (domainActive) {
    parts.push(
      "── UNIVERSAL CLASSIFICATION (Pre-Analysis) ──────────────────",
      "The Universal Topic Router has pre-classified this document:",
      `  Domain:     ${globalDomain!.domain}`,
      `  Sub-topic:  ${globalDomain!.subdomain}`,
      `  Confidence: ${globalDomain!.confidence}%`,
      "",
      "DOMAIN-AWARE RULES:",
      `- This is a ${globalDomain!.domain} document about "${globalDomain!.subdomain}".`,
      `- STRONGLY prefer folders whose keywords or Core Topics relate to ${globalDomain!.domain.toLowerCase()}.`,
      "- Do NOT match to generic catch-all folders (Archives, Misc, Documents, Old, etc.).",
      `- If no existing folder covers "${globalDomain!.subdomain}", you MUST set isNewFolder: true`,
      "  and suggest a specific, descriptive folder name — not a generic one.",
      '- ALWAYS provide suggested_path in "Parent/Child" format',
      '  (e.g., "Math/Calculus", "Science/Chemistry", "History/APUSH", "Finance/Taxes").',
      "──────────────────────────────────────────────────────────────",
      "",
    );
  }

  // Cold-start fix: explicit category list so AI knows all folder names even if they have no keywords yet
  if (folderNames && folderNames.length > 0) {
    const nonNoise = folderNames.filter((f) => !isNoiseFolderName(f));
    parts.push(
      `AVAILABLE CATEGORIES (exact names): ${nonNoise.join(", ")}`,
      "You MUST pick from this list unless none fit. Only suggest a new folder if no category above applies.",
      "",
    );
  }

  parts.push(
    "You are an Expert Librarian AI. Your job is to file documents into the correct folder",
    "by understanding the ABSTRACT IDEAS in the text, not by matching surface keywords.",
    "",
    "PREFER the MOST SPECIFIC folder. 'AP Seminar' is better than 'School'.",
    "'Tax Returns' is better than 'Finance'. Match to the NARROWEST topic that fits.",
    "",
    `AVAILABLE FOLDERS (${folderCount} topic folders):`,
    "",
    "Each folder has Keywords (extracted from existing files) and optional Core Topics",
    "(user-defined semantic aliases). Core Topics are AUTHORITATIVE — trust them over keywords.",
    "",
    folderDescriptions.join("\n\n"),
    "",
  );

  if (learningBlock) {
    parts.push(learningBlock, "");
  }

  parts.push(
    "TASK — Follow these steps IN ORDER:",
    "",
    "STEP 1 — ABSTRACT:",
    "  Read the document content carefully.",
    "  Identify the HIGH-LEVEL DOMAIN this document belongs to.",
    "  Write a single sentence describing what field/discipline this document is from.",
    "",
    "STEP 2 — CONCEPTUALIZE:",
    "  List exactly 3 abstract concepts/themes present in this document.",
    "  These should be domain-specific ideas, not generic words.",
    '  Good: "constitutional law", "cellular respiration", "market segmentation"',
    '  Bad: "document", "information", "file"',
    "",
    "STEP 3 — MAP:",
    "  Compare your concepts against EACH folder's Keywords and Core Topics.",
    "  ⭐ Core Topics take PRIORITY — if a folder has Core Topics that match, it wins.",
    "  Look for SEMANTIC PROXIMITY, not just exact word matches.",
    "  CHECK THE MOST SPECIFIC FOLDERS FIRST — a precise match beats a vague one.",
    "",
    "STEP 4 — MATCH:",
    "  Pick the SINGLE folder whose domain best matches the document.",
    "  If NO existing folder covers this domain, suggest a new folder name (1-2 words).",
  );

  parts.push(
    "",
    "STEP 5 — HIERARCHY (ALWAYS required):",
    '  ALWAYS provide a suggested_path in "Parent/Child" format.',
    "  Use a BROAD parent category and a SPECIFIC child subcategory.",
    "  Common parent categories: Math, Science, History, English, CS, Business, Finance, Art, Music, Languages, Health, Engineering, Law, Personal",
    '  Examples: "Math/Precalculus", "Science/Biology", "History/APUSH", "CS/Python", "English/Essays", "Finance/Taxes"',
    "  If the file matches an existing folder that is ALREADY a child (e.g., 'Math/Precalculus'), use that exact path.",
    "  If the file matches a top-level folder (e.g., 'Precalculus'), place it under the correct parent (e.g., 'Math/Precalculus').",
  );

  parts.push(
    "",
    "OUTPUT — Respond with ONLY valid JSON:",
    "{",
    '  "concept_abstraction": "This document is from the field of X, specifically Y.",',
    '  "detected_concepts": ["concept1", "concept2", "concept3"],',
    '  "reasoning": "The document discusses X. This matches FolderName because its Core Topic \'Y\' covers this domain.",',
    '  "best_fit_folder": "FolderName",',
    '  "confidence": 0-100,',
    '  "isNewFolder": false,',
    '  "suggested_path": ""',
    "}",
    "",
    "RULES:",
    "- concept_abstraction: REQUIRED. A sentence describing the document's academic/professional field.",
    "- detected_concepts: EXACTLY 3 domain-specific themes.",
    "- reasoning: MUST reference specific Core Topics or Keywords that match.",
    "- confidence: 0-100. Above 80 = strong match. Below 60 = weak.",
    "- isNewFolder: true ONLY when no folder's domain overlaps.",
    "- When isNewFolder is true, best_fit_folder should be a concise name (1-2 words).",
    '- suggested_path: ALWAYS provide a "Parent/Child" path (e.g., "Math/Precalculus", "Science/Chemistry"). This is REQUIRED for every classification.',
    "- User's past corrections ALWAYS override your analysis.",
    "- Prefer EXISTING folders. Only suggest new ones for genuinely novel domains.",
    "- ⭐ Core Topics are AUTHORITATIVE — trust them over auto-detected keywords.",
    "- ⚠️ NEVER suggest a new folder that is a synonym, abbreviation, or variant of an existing one.",
    '  For example: if "PreCalc" exists, do NOT suggest "Precalculus", "Pre-Calculus", or "Pre Calc".',
    '  If "Bio" exists, do NOT suggest "Biology". If "Stats" exists, do NOT suggest "Statistics".',
    "  ALWAYS use the existing folder name even if the new name seems more descriptive.",
  );

  return parts.join("\n");
}

function buildUserMessage(
  filename: string,
  extension: string,
  fileContent: string
): string {
  const lines: string[] = ["Classify this file.", "", `Filename: ${filename}`];

  if (extension) lines.push(`Type: ${extension}`);

  if (fileContent) {
    const allWords = fileContent.split(/\s+/).filter((w) => w.length > 0);
    const wc = allWords.length;
    // Limit what goes into the Ollama prompt to fit its context window
    const limited = wc > MAX_OLLAMA_CONTENT_WORDS
      ? allWords.slice(0, MAX_OLLAMA_CONTENT_WORDS).join(" ") +
        ` [first ${MAX_OLLAMA_CONTENT_WORDS} of ${wc} words shown]`
      : fileContent;
    lines.push("", `FILE CONTENT (${Math.min(wc, MAX_OLLAMA_CONTENT_WORDS)} words):`, limited);
  } else {
    lines.push(
      "",
      "No readable content available. Classify based on the filename, file type,",
      "and the folder fingerprints only."
    );
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════
//  FIX 4 — CLASSIFICATION PROMPT V2 (Chain-of-Thought)
//
//  Stronger structured prompt that forces the model to reason
//  about subject-specific terms before picking a folder.
//  Uses plain-text TERMS/FOLDER/CONFIDENCE/REASON format which
//  is more robust than JSON for small models.
// ═══════════════════════════════════════════════════════════

/**
 * Build the V2 classification prompt with forced CoT reasoning.
 * Shows each folder's top 5 distinctive terms from the pool.
 */
function buildClassificationPromptV2(
  activeFolders: string[],
  fileContent: string,
  filename: string,
  targetDir: string,
  globalDomain: GlobalDomainResult | null
): string {
  const nonNoiseFolders = activeFolders.filter((f) => !isNoiseFolderName(f));

  // Build folder list with top-5 pool terms
  const folderLines = nonNoiseFolders.map((folder) => {
    let terms: string[] = [];
    try {
      terms = getTopDistinctiveTerms(folder, targetDir, 5);
    } catch {}
    const termStr = terms.length > 0 ? `: ${terms.join(", ")}` : "";
    return `  - ${folder}${termStr}`;
  });

  const allWords = fileContent.split(/\s+/).filter((w) => w.length > 0);
  const limitedContent = allWords.length > MAX_OLLAMA_CONTENT_WORDS
    ? allWords.slice(0, MAX_OLLAMA_CONTENT_WORDS).join(" ")
    : fileContent;

  const domainHint = globalDomain && globalDomain.confidence >= DOMAIN_CONFIDENCE_THRESHOLD
    ? `\nDOCUMENT DOMAIN (pre-classified): ${globalDomain.domain} / ${globalDomain.subdomain} (${globalDomain.confidence}% confidence)\n`
    : "";

  return [
    "You are a precise file classifier. Your job is to read this document's content",
    "and determine which folder it belongs in.",
    "",
    "AVAILABLE FOLDERS:",
    ...folderLines,
    "",
    `FILENAME: ${filename}`,
    domainHint,
    "DOCUMENT CONTENT:",
    limitedContent || "(no readable content — classify by filename and folder list only)",
    "",
    "INSTRUCTIONS:",
    "Step 1 — List the 3 most subject-specific terms or phrases you found in the content",
    "         (not generic words like 'chapter', 'the', 'notes', 'document').",
    "Step 2 — Based on those terms, which folder from the list above matches best and why?",
    "Step 3 — How confident are you as a percentage (0-100)?",
    "",
    "If the content gives you genuinely no signal, say CONFIDENCE: 0.",
    "Do not guess. A wrong answer is worse than sending to review.",
    "You MUST pick a folder from the AVAILABLE FOLDERS list above.",
    "",
    "Reply in this EXACT format (nothing else):",
    "TERMS: [term1], [term2], [term3]",
    "FOLDER: [exact folder name from the list]",
    "CONFIDENCE: [number 0-100]",
    "REASON: [one sentence]",
  ].join("\n");
}

/**
 * Parse the V2 TERMS/FOLDER/CONFIDENCE/REASON response.
 * Returns structured fields or null if the format is unrecognisable.
 */
function parseClassificationResponseV2(
  raw: string,
  activeFolders: string[]
): { terms: string[]; folder: string; confidence: number; reason: string } | null {
  const termsM  = raw.match(/TERMS\s*:\s*(.+)/i);
  const folderM = raw.match(/FOLDER\s*:\s*(.+)/i);
  const confM   = raw.match(/CONFIDENCE\s*:\s*(\d+)/i);
  const reasonM = raw.match(/REASON\s*:\s*(.+)/i);

  if (!folderM || !confM) return null;

  const folderRaw  = folderM[1].trim().replace(/[\[\]]/g, "");
  const confidence = Math.min(100, Math.max(0, parseInt(confM[1], 10)));
  const terms = termsM
    ? termsM[1].replace(/[\[\]]/g, "").split(",").map((t) => t.trim()).filter((t) => t.length >= 2)
    : [];
  const reason = reasonM ? reasonM[1].trim() : "";

  // Resolve folder name (case-insensitive, partial match)
  const lower = folderRaw.toLowerCase();
  const resolved =
    activeFolders.find((f) => f.toLowerCase() === lower) ||
    activeFolders.find((f) => f.toLowerCase().includes(lower) || lower.includes(f.toLowerCase())) ||
    folderRaw;

  return { terms, folder: resolved, confidence, reason };
}

// ═══════════════════════════════════════════════════════════
//  FIX 5 — MULTI-SIGNAL CONSENSUS
//
//  At the Ollama stage, compare signals from:
//    • Pool scoring (even if tryPoolMatch threshold wasn't reached)
//    • Sibling file pattern (FIX 3)
//    • Ollama v2 result
//
//  Consensus rules:
//    2+ signals agree     → high confidence, proceed
//    Signals disagree     → highest-confidence signal, requires_review, -15
//    Only weak Ollama (<75 %) → Needs Review
// ═══════════════════════════════════════════════════════════

interface ClassificationSignal {
  source: string;
  folder: string;
  confidence: number;
}

function applyMultiSignalConsensus(
  signals: ClassificationSignal[],
  baseResult: ClassificationResult,
  filename: string
): ClassificationResult {
  if (signals.length === 0) return baseResult;

  // Log the full signal breakdown
  const breakdown = signals
    .map((s) => `${s.source}=${s.folder}(${s.confidence})`)
    .join(", ");

  // Count agreements
  const folderVotes: Record<string, { totalConf: number; count: number }> = {};
  for (const sig of signals) {
    const key = sig.folder.toLowerCase();
    if (!folderVotes[key]) folderVotes[key] = { totalConf: 0, count: 0 };
    folderVotes[key].totalConf += sig.confidence;
    folderVotes[key].count++;
  }

  // Find the folder with the most votes (tiebreak: highest total confidence)
  const sorted = Object.entries(folderVotes).sort(([, a], [, b]) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.totalConf - a.totalConf;
  });

  const [topKey, topVotes] = sorted[0];
  const topFolder = signals.find((s) => s.folder.toLowerCase() === topKey)?.folder ?? topKey;
  const avgConf = Math.round(topVotes.totalConf / topVotes.count);

  const consensus = topVotes.count >= 2;

  if (consensus) {
    // 2+ signals agree → boost confidence slightly
    const finalConf = Math.min(100, avgConf + 5);
    console.log(
      `[Classification] Signals: ${breakdown} → CONSENSUS: ${topFolder}(${finalConf})`
    );
    return {
      ...baseResult,
      category: topFolder,
      confidence: finalConf,
      reasoning: baseResult.reasoning + ` [Consensus: ${topVotes.count} signals agree on "${topFolder}"]`,
      requires_review: finalConf < REVIEW_THRESHOLD,
    };
  }

  // Signals disagree — use the highest-confidence signal but flag for review
  const bestSignal = signals.reduce((a, b) => a.confidence >= b.confidence ? a : b);
  const penalisedConf = Math.max(0, bestSignal.confidence - 15);

  console.log(
    `[Classification] Signals: ${breakdown} → DISAGREEMENT: using ${bestSignal.source}=${bestSignal.folder}(${penalisedConf}) requires_review`
  );

  // If only Ollama and it's weak, send to Needs Review
  if (signals.length === 1 && bestSignal.source === "Ollama" && bestSignal.confidence < 75) {
    return {
      ...baseResult,
      category: "Needs Review",
      confidence: 0,
      reasoning: baseResult.reasoning + ` [Single weak Ollama signal (${bestSignal.confidence}%) — routed to Needs Review]`,
      requires_review: true,
      match_level: "fallback",
    };
  }

  return {
    ...baseResult,
    category: bestSignal.folder,
    confidence: penalisedConf,
    reasoning: baseResult.reasoning + ` [Signal disagreement: ${breakdown} — using highest-confidence signal, flagged for review]`,
    requires_review: true,
  };
}

// ═══════════════════════════════════════════════════════════
//  RESPONSE PARSER  (specificity-sorted + domain-aware)
// ═══════════════════════════════════════════════════════════

function parseResponse(
  raw: string,
  validFolders: string[],
  globalDomain: GlobalDomainResult | null,
  fingerprints?: FolderContextMap
): ClassificationResult {
  const gd = globalDomain?.domain || "";
  const gs = globalDomain?.subdomain || "";
  const domainActive =
    globalDomain !== null &&
    globalDomain.confidence >= DOMAIN_CONFIDENCE_THRESHOLD;

  // Sort folders most-specific-first so partial matching prefers
  // "AP Seminar" over "Archives".
  const sortedFolders = fingerprints
    ? sortBySpecificity(validFolders, fingerprints)
    : validFolders;

  function makeResult(
    base: Omit<
      ClassificationResult,
      "global_domain" | "global_subdomain" | "suggested_path" | "match_level"
    > & { suggested_path?: string; match_level?: ClassificationResult["match_level"] }
  ): ClassificationResult {
    return {
      ...base,
      global_domain: gd,
      global_subdomain: gs,
      suggested_path: base.suggested_path ?? "",
      match_level: base.match_level ?? "specific",
    };
  }

  // Strip markdown code fences
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) cleaned = jsonMatch[0];

  try {
    const parsed = JSON.parse(cleaned);

    let confidence = Math.min(100, Math.max(0, Number(parsed.confidence) || 50));
    const reasoning = String(parsed.reasoning || "");
    const conceptAbstraction = String(parsed.concept_abstraction || "");
    const isNewFolder = Boolean(parsed.isNewFolder);
    let wasNoisePenalized = false;
    const aiSuggestedPath = String(parsed.suggested_path || "").trim();

    let detectedConcepts: string[] = [];
    if (Array.isArray(parsed.detected_concepts)) {
      detectedConcepts = parsed.detected_concepts
        .filter((c: unknown) => typeof c === "string")
        .slice(0, 5)
        .map((c: string) => c.trim());
    }

    const folderName = String(
      parsed.best_fit_folder || parsed.category || ""
    ).trim();

    if (folderName) {
      // ═══ SUBJECT CONFIDENCE BOOST ══════════════════════════
      // If the global domain subdomain overlaps with the matched folder name, boost confidence
      if (domainActive && gs) {
        const subWords = gs.toLowerCase().split(/\s+/);
        const folderWords = folderName.toLowerCase().split(/[\s_-]+/);
        const overlap = folderWords.filter(
          (w) => w.length >= 3 && subWords.some((sw) => sw.includes(w) || w.includes(sw))
        );
        if (overlap.length > 0) {
          const boost = Math.min(15, overlap.length * 5);
          confidence = Math.min(100, confidence + boost);
          console.log(
            `[Classification] Subject boost +${boost}% for "${folderName}" (subdomain overlap: ${overlap.join(", ")})`
          );
        }
      }

      // ═══ DOMAIN-AWARE NOISE HARD-REJECT ═══════════════════
      if (isNoiseFolderName(folderName) && domainActive) {
        const sugName = globalDomain!.subdomain || folderName;
        const sugPath =
          aiSuggestedPath ||
          buildSuggestedPath(globalDomain, sortedFolders, sugName);
        const leaf = sugPath.includes("/")
          ? sanitizeFolderName(sugPath.split("/").pop()!)
          : sanitizeFolderName(sugName);

        console.log(
          `[Classification] DOMAIN OVERRIDE: "${folderName}" rejected → "${sugPath}"`
        );

        return makeResult({
          category: leaf,
          confidence: Math.max(confidence - NOISE_FOLDER_PENALTY, 0),
          reasoning:
            reasoning +
            ` [Domain router overrode noise folder "${folderName}"]`,
          isNewFolder: true,
          detected_concepts: detectedConcepts,
          concept_abstraction: conceptAbstraction,
          requires_review: true,
          was_noise_penalized: true,
          suggested_path: sugPath,
        });
      }

      // ═══ LEGACY NOISE PENALTY ══════════════════════════════
      if (isNoiseFolderName(folderName) && !domainActive) {
        console.log(
          `[Classification] NOISE PENALTY: "${folderName}" -${NOISE_FOLDER_PENALTY}%`
        );
        confidence = Math.max(0, confidence - NOISE_FOLDER_PENALTY);
        wasNoisePenalized = true;
      }

      const requiresReview = confidence < REVIEW_THRESHOLD;

      // ── Resolve hierarchical path for ALL classifications ──
      const sugPath =
        aiSuggestedPath ||
        (domainActive
          ? buildSuggestedPath(globalDomain, sortedFolders, folderName)
          : "");

      // ── New folder suggestion ─────────────────────────────
      if (isNewFolder) {
        // ═══ DEDUP CHECK: does an equivalent folder already exist? ═══
        // Check the full path first (e.g., "Math/Precalculus" against existing "Math/PreCalc")
        const fullPathMatch = sugPath.includes("/")
          ? findExistingEquivalent(sugPath, sortedFolders)
          : null;
        if (fullPathMatch) {
          console.log(
            `[Classification] DEDUP: path "${sugPath}" → merged into existing "${fullPathMatch}"`
          );
          return makeResult({
            category: fullPathMatch,
            confidence: Math.min(100, confidence + 5),
            reasoning:
              reasoning +
              ` [Dedup: "${sugPath}" merged into existing "${fullPathMatch}"]`,
            isNewFolder: false,
            detected_concepts: detectedConcepts,
            concept_abstraction: conceptAbstraction,
            requires_review: requiresReview,
            was_noise_penalized: wasNoisePenalized,
            suggested_path: fullPathMatch,
          });
        }

        // Check the flat folder name
        const existingMatch = findExistingEquivalent(folderName, sortedFolders);
        if (existingMatch) {
          console.log(
            `[Classification] DEDUP: AI suggested new folder "${folderName}" → merged into existing "${existingMatch}"`
          );
          return makeResult({
            category: existingMatch,
            confidence: Math.min(100, confidence + 5),
            reasoning:
              reasoning +
              ` [Dedup: "${folderName}" merged into existing "${existingMatch}"]`,
            isNewFolder: false,
            detected_concepts: detectedConcepts,
            concept_abstraction: conceptAbstraction,
            requires_review: requiresReview,
            was_noise_penalized: wasNoisePenalized,
            suggested_path: existingMatch,
          });
        }

        const leaf = sugPath.includes("/")
          ? sanitizeFolderName(sugPath.split("/").pop()!)
          : sanitizeFolderName(folderName);

        // Also dedup the leaf name (it might differ from folderName after path parsing)
        const leafMatch = findExistingEquivalent(leaf, sortedFolders);
        if (leafMatch) {
          console.log(
            `[Classification] DEDUP: leaf "${leaf}" → merged into existing "${leafMatch}"`
          );
          return makeResult({
            category: leafMatch,
            confidence: Math.min(100, confidence + 5),
            reasoning:
              reasoning +
              ` [Dedup: "${leaf}" merged into existing "${leafMatch}"]`,
            isNewFolder: false,
            detected_concepts: detectedConcepts,
            concept_abstraction: conceptAbstraction,
            requires_review: requiresReview,
            was_noise_penalized: wasNoisePenalized,
            suggested_path: leafMatch,
          });
        }

        // Use the full hierarchical path as category (e.g., "Math/Precalculus")
        const hierarchicalCategory = sugPath || leaf || "Miscellaneous";
        return makeResult({
          category: hierarchicalCategory,
          confidence,
          reasoning,
          isNewFolder: true,
          detected_concepts: detectedConcepts,
          concept_abstraction: conceptAbstraction,
          requires_review: requiresReview,
          was_noise_penalized: wasNoisePenalized,
          suggested_path: sugPath,
        });
      }

      // ── Exact match ───────────────────────────────────────
      if (sortedFolders.includes(folderName)) {
        // If the AI provided a hierarchical path and the matching folder is already hierarchical, use it
        // Otherwise, check if we can find a hierarchical version (e.g., "Precalculus" → "Math/Precalculus")
        let resolvedCategory = folderName;
        if (sugPath && sugPath.includes("/") && sortedFolders.includes(sugPath)) {
          resolvedCategory = sugPath;
        } else {
          // Check if this folder exists as a child in any parent (e.g., "Math/Precalculus")
          const hierarchicalMatch = sortedFolders.find(
            (f) => f.includes("/") && f.split("/").pop()!.toLowerCase() === folderName.toLowerCase()
          );
          if (hierarchicalMatch) resolvedCategory = hierarchicalMatch;
        }
        return makeResult({
          category: resolvedCategory,
          confidence,
          reasoning,
          isNewFolder: false,
          detected_concepts: detectedConcepts,
          concept_abstraction: conceptAbstraction,
          requires_review: requiresReview,
          was_noise_penalized: wasNoisePenalized,
          suggested_path: resolvedCategory.includes("/") ? resolvedCategory : sugPath,
        });
      }

      // ── Case-insensitive match ────────────────────────────
      const lower = folderName.toLowerCase();
      const ciMatch = sortedFolders.find((f) => f.toLowerCase() === lower);
      if (ciMatch) {
        if (isNoiseFolderName(ciMatch) && domainActive) {
          const sugName = globalDomain!.subdomain || folderName;
          const ciSugPath = buildSuggestedPath(globalDomain, sortedFolders, sugName);

          return makeResult({
            category: ciSugPath || sanitizeFolderName(sugName),
            confidence: Math.max(0, confidence - NOISE_FOLDER_PENALTY),
            reasoning: reasoning + ` [Domain router overrode "${ciMatch}"]`,
            isNewFolder: true,
            detected_concepts: detectedConcepts,
            concept_abstraction: conceptAbstraction,
            requires_review: true,
            was_noise_penalized: true,
            suggested_path: ciSugPath,
          });
        }

        if (isNoiseFolderName(ciMatch) && !wasNoisePenalized) {
          confidence = Math.max(0, confidence - NOISE_FOLDER_PENALTY);
          wasNoisePenalized = true;
        }

        // Resolve to hierarchical path if available
        let resolvedCI = ciMatch;
        const ciHierarchical = sortedFolders.find(
          (f) => f.includes("/") && f.split("/").pop()!.toLowerCase() === ciMatch.toLowerCase()
        );
        if (ciHierarchical) resolvedCI = ciHierarchical;

        return makeResult({
          category: resolvedCI,
          confidence,
          reasoning,
          isNewFolder: false,
          detected_concepts: detectedConcepts,
          concept_abstraction: conceptAbstraction,
          requires_review: confidence < REVIEW_THRESHOLD,
          was_noise_penalized: wasNoisePenalized,
          suggested_path: resolvedCI.includes("/") ? resolvedCI : sugPath,
        });
      }

      // ── Partial / substring match (specificity-sorted) ────
      const partial = sortedFolders.find(
        (f) =>
          f.toLowerCase().includes(lower) ||
          lower.includes(f.toLowerCase())
      );
      if (partial) {
        if (isNoiseFolderName(partial) && domainActive) {
          const sugName = globalDomain!.subdomain || folderName;
          const partialSugPath = buildSuggestedPath(globalDomain, sortedFolders, sugName);

          return makeResult({
            category: partialSugPath || sanitizeFolderName(sugName),
            confidence: Math.max(0, confidence - NOISE_FOLDER_PENALTY),
            reasoning: reasoning + ` [Domain router overrode "${partial}"]`,
            isNewFolder: true,
            detected_concepts: detectedConcepts,
            concept_abstraction: conceptAbstraction,
            requires_review: true,
            was_noise_penalized: true,
            suggested_path: partialSugPath,
          });
        }

        let partialConf = Math.max(confidence - 10, 0);
        if (isNoiseFolderName(partial)) {
          partialConf = Math.max(0, partialConf - NOISE_FOLDER_PENALTY);
          wasNoisePenalized = true;
        }

        // Resolve partial to hierarchical if available
        let resolvedPartial = partial;
        const partialHierarchical = sortedFolders.find(
          (f) => f.includes("/") && f.split("/").pop()!.toLowerCase() === partial.toLowerCase()
        );
        if (partialHierarchical) resolvedPartial = partialHierarchical;

        return makeResult({
          category: resolvedPartial,
          confidence: partialConf,
          reasoning,
          isNewFolder: false,
          detected_concepts: detectedConcepts,
          concept_abstraction: conceptAbstraction,
          requires_review: partialConf < REVIEW_THRESHOLD,
          was_noise_penalized: wasNoisePenalized,
          suggested_path: resolvedPartial.includes("/") ? resolvedPartial : sugPath,
        });
      }

      // ── AI picked a name not in the list — use full hierarchical path ──
      const fallbackPath = sugPath || (domainActive
        ? buildSuggestedPath(globalDomain, sortedFolders, folderName)
        : "");

      return makeResult({
        category: fallbackPath || sanitizeFolderName(folderName) || "Documents",
        confidence: Math.max(confidence - 20, 0),
        reasoning,
        isNewFolder: true,
        detected_concepts: detectedConcepts,
        concept_abstraction: conceptAbstraction,
        requires_review: true,
        was_noise_penalized: wasNoisePenalized,
        suggested_path: fallbackPath,
      });
    }
  } catch {
    // JSON parse failed
  }

  // ── Last resort: scan raw text for folder names ───────────
  for (const folder of sortedFolders) {
    if (raw.toLowerCase().includes(folder.toLowerCase())) {
      if (isNoiseFolderName(folder) && domainActive) {
        const sugName = globalDomain!.subdomain || "Misc";
        const sugPath = buildSuggestedPath(globalDomain, sortedFolders, sugName);
        return makeResult({
          category: sanitizeFolderName(sugName),
          confidence: 10,
          reasoning: `Domain router rejected noise folder "${folder}" from unparseable response`,
          isNewFolder: true,
          detected_concepts: [],
          concept_abstraction: "",
          requires_review: true,
          was_noise_penalized: true,
          suggested_path: sugPath,
        });
      }

      let conf = 25;
      let penalized = false;
      if (isNoiseFolderName(folder)) {
        conf = Math.max(0, conf - NOISE_FOLDER_PENALTY);
        penalized = true;
      }

      return makeResult({
        category: folder,
        confidence: conf,
        reasoning: "Extracted folder name from unparseable AI response",
        isNewFolder: false,
        detected_concepts: [],
        concept_abstraction: "",
        requires_review: true,
        was_noise_penalized: penalized,
      });
    }
  }

  // ── Absolute last resort — use domain if available ────────
  if (domainActive) {
    const sugName = globalDomain!.subdomain || globalDomain!.domain;
    const sugPath = buildSuggestedPath(globalDomain, sortedFolders, sugName);
    return makeResult({
      category: sanitizeFolderName(sugName),
      confidence: 20,
      reasoning: `Fallback — could not parse AI response. Domain: ${gd} / ${gs}.`,
      isNewFolder: true,
      detected_concepts: [],
      concept_abstraction: "",
      requires_review: true,
      was_noise_penalized: false,
      suggested_path: sugPath,
      match_level: "fallback",
    });
  }

  return makeResult({
    category: "Documents",
    confidence: 5,
    reasoning: "Fallback — could not parse AI response",
    isNewFolder: validFolders.length === 0,
    detected_concepts: [],
    concept_abstraction: "",
    requires_review: true,
    was_noise_penalized: false,
    match_level: "fallback",
  });
}

// ═══════════════════════════════════════════════════════════
//  PUBLIC API — Specificity Waterfall
// ═══════════════════════════════════════════════════════════

/**
 * Classify a single file through the Specificity Waterfall:
 *
 *   0. Archives Ban   — disqualify noise folders for recent files
 *   1. Bullseye       — instant token match (100 %, zero AI)
 *   2. Specific Match — Global Domain + AI chain-of-thought
 *   3. Broad Fallback — domain → parent folder suggestion
 */
export async function classifyFile(
  filePath: string,
  targetDir: string
): Promise<ClassificationResult> {
  // ── Phase 0: load everything in parallel ──────────────────
  const [userFolders, rawFingerprints, folderContext, fileContent, fileMetadata] =
    await Promise.all([
      scanUserFolders(targetDir),
      getFolderContext(targetDir),
      getFolderContextForPrompt(targetDir),
      sampleFileContent(filePath),
      extractMetadata(filePath),   // FIX 1: PDF/DOCX metadata signals
    ]);

  const filename = path.basename(filePath);
  const extension = path.extname(filePath).toLowerCase();

  // ── PRE-CHECK: Folder name literally in filename ────────────
  // Strongest possible signal — no AI needed. Handles "PreCalc" ↔ "Pre-Calc"
  // by stripping hyphens/underscores/spaces before comparing.
  // Minimum folder name length of 4 prevents false matches from short names.
  {
    const filenamePlain = filename.toLowerCase().replace(/\.[^.]+$/, "").replace(/[-_\s+.]/g, "");
    for (const folder of userFolders) {
      if (isNoiseFolderName(folder)) continue;
      const folderPlain = folder.toLowerCase().replace(/[-_\s+.]/g, "");
      if (folderPlain.length >= 4 && filenamePlain.includes(folderPlain)) {
        const preCheckResult: ClassificationResult = {
          category: folder,
          confidence: 100,
          reasoning: `FILENAME MATCH: folder name "${folder}" found verbatim in filename "${filename}"`,
          isNewFolder: false,
          detected_concepts: [folder],
          concept_abstraction: `Folder name found in filename`,
          requires_review: false,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: "bullseye",
        };
        logResult(filename, fileContent, preCheckResult);
        return preCheckResult;
      }
    }
  }

  // ── CONSISTENCY CHECK: History-based pre-classification ──────────────
  // Fires ONLY when past classifications give strong agreement on the same
  // folder for this "class key" (subject tokens stripped of noise).
  // Zero AI calls — purely deterministic. Falls through if evidence is weak.
  {
    const historyBoost = getHistoryBoost(filename, userFolders);
    if (historyBoost) {
      const consistencyResult: ClassificationResult = {
        category: historyBoost.folder,
        confidence: historyBoost.confidence,
        reasoning:
          `HISTORY MATCH: class key "${historyBoost.matchedKey}" was previously ` +
          `classified to "${historyBoost.folder}" ${historyBoost.hitCount} time(s)`,
        isNewFolder: false,
        detected_concepts: [historyBoost.matchedKey],
        concept_abstraction: `History pattern match`,
        requires_review: false,
        was_noise_penalized: false,
        global_domain: "",
        global_subdomain: "",
        suggested_path: "",
        match_level: "bullseye",
      };
      logResult(filename, fileContent, consistencyResult);
      return consistencyResult;
    }
  }

  // ── DISAMBIGUATION RULES CHECK ────────────────────────────────────────
  // Auto-generated rules from confusion matrix data. Fires when a
  // folder pair has been confused 10+ times and we've computed indicators.
  {
    const disambig = applyDisambiguationRules(filename, fileContent);
    if (disambig && userFolders.some((f) => f.toLowerCase() === disambig.folder.toLowerCase())) {
      const actualFolder =
        userFolders.find((f) => f.toLowerCase() === disambig.folder.toLowerCase()) ??
        disambig.folder;
      const disambigResult: ClassificationResult = {
        category: actualFolder,
        confidence: disambig.confidence,
        reasoning:
          `DISAMBIGUATION RULE: "${actualFolder}" matched ` +
          `${disambig.rule.a_indicators.length + disambig.rule.b_indicators.length} ` +
          `exclusive indicators (auto-generated from confusion history)`,
        isNewFolder: false,
        detected_concepts: disambig.rule.a_indicators.slice(0, 5),
        concept_abstraction: `Disambiguation rule match`,
        requires_review: false,
        was_noise_penalized: false,
        global_domain: "",
        global_subdomain: "",
        suggested_path: "",
        match_level: "specific",
      };
      logResult(filename, fileContent, disambigResult);
      return disambigResult;
    }
  }

  // ── STEP 0: Archives Ban ──────────────────────────────────
  let activeFolders: string[] = userFolders;
  const fileRecent = isFileRecent(filePath);
  if (fileRecent) {
    activeFolders = userFolders.filter((f) => !isNoiseFolderName(f));
    const banned = userFolders.length - activeFolders.length;
    if (banned > 0) {
      console.log(
        `[Classification] ARCHIVES BAN: file <3 months old — ${banned} noise folder(s) disqualified`
      );
    }
  }

  // ── STEP 0.5: Metadata Bullseye (FIX 1) ─────────────────
  if (fileMetadata) {
    const metaBullseye = tryMetadataBullseye(fileMetadata, activeFolders, rawFingerprints, filename);
    if (metaBullseye) {
      logResult(filename, fileContent, metaBullseye);
      return metaBullseye;
    }
  }

  // ── STEP 1: Bullseye ─────────────────────────────────────
  const bullseye = tryBullseyeMatch(
    filename,
    fileContent,
    rawFingerprints,
    activeFolders
  );
  if (bullseye) {
    logResult(filename, fileContent, bullseye);
    return bullseye;
  }

  // ── STEP 1.5: Keyword Map (hardcoded rules) ────────────
  const keywordHit = tryKeywordMatch(filename, fileContent, activeFolders);
  if (keywordHit) {
    logResult(filename, fileContent, keywordHit);
    return keywordHit;
  }

  // ── STEP 1.75: Smart Groups (dynamic, zero config) ────
  const smartHit = trySmartGroupMatch(filename, fileContent, activeFolders);
  if (smartHit) {
    logResult(filename, fileContent, smartHit);
    return smartHit;
  }

  // ── STEP 1.85: Pool Match (global_concepts.json + knowledge_base.json) ──
  const poolHit = tryPoolMatch(filename, fileContent, activeFolders, targetDir);
  if (poolHit) {
    // ── CONFLICT DETECTION: before returning pool hit, check for multi-category conflicts ──
    const conflict = detectPoolConflicts(filename, fileContent, activeFolders, targetDir);
    if (conflict) {
      logResult(filename, fileContent, conflict);
      return conflict;
    }
    logResult(filename, fileContent, poolHit);
    return poolHit;
  }

  // ── STEP 1.9: Internet Retry (only if pool match failed) ──
  try {
    const internetHit = await tryInternetRetry(filename, fileContent, activeFolders, targetDir);
    if (internetHit) {
      logResult(filename, fileContent, internetHit);
      return internetHit;
    }
  } catch (err) {
    console.warn(`[Classification] Internet retry failed: ${err}`);
  }

  // ── STEP 1.95: Deep Link Match (reverse Datamuse lookup) ──
  try {
    const deepLinkHit = await tryDeepLinkMatch(filename, fileContent, activeFolders, targetDir);
    if (deepLinkHit) {
      logResult(filename, fileContent, deepLinkHit);
      return deepLinkHit;
    }
  } catch (err) {
    console.warn(`[Classification] Deep Link Match failed: ${err}`);
  }

  // ── STEP 1.97: Entity Recognition (Wikipedia-backed) ──
  try {
    const entityHit = await tryEntityRecognition(filename, fileContent, activeFolders, targetDir);
    if (entityHit) {
      logResult(filename, fileContent, entityHit);
      return entityHit;
    }
  } catch (err) {
    console.warn(`[Classification] Entity Recognition failed: ${err}`);
  }

  // ── STEP 1.98: Sibling File Signal (FIX 3) ─────────────
  let siblingSignal: { folder: string; boost: number; count: number } | null = null;
  try {
    siblingSignal = await trySiblingSignal(filename, filePath, activeFolders);
  } catch (err) {
    console.warn(`[Classification] Sibling signal failed: ${err}`);
  }

  // ── STEP 2: Specific Match (Global Domain + AI v2 CoT prompt) ──────────
  let globalDomain: GlobalDomainResult | null = null;
  try {
    globalDomain = await classifyGlobalDomain(filename, extension, fileContent);
  } catch {
    // Non-fatal
  }

  // ── FIX 5: Collect pool signals for consensus (re-score without early-exit threshold) ──
  const poolScores = scoreAllPoolCategories(filename, fileContent, activeFolders, targetDir);
  const poolSignal: ClassificationSignal | null = poolScores.length > 0
    ? { source: "Pool", folder: poolScores[0].folder, confidence: poolScores[0].confidence }
    : null;

  // ── FIX 4: Use v2 CoT prompt ───────────────────────────────────────────
  const v2Prompt = buildClassificationPromptV2(activeFolders, fileContent, filename, targetDir, globalDomain);

  try {
    const raw = await callOllama("", v2Prompt, { numCtx: 4096 });

    // Try v2 parser first (TERMS/FOLDER/CONFIDENCE/REASON)
    const v2parsed = parseClassificationResponseV2(raw, activeFolders);

    // FIX 4: if confidence is 0, route directly to Needs Review
    if (v2parsed && v2parsed.confidence === 0) {
      const noSignal: ClassificationResult = {
        category: "Needs Review",
        confidence: 0,
        reasoning: `Ollama v2: no signal detected — ${v2parsed.reason}`,
        isNewFolder: false,
        detected_concepts: v2parsed.terms,
        concept_abstraction: "",
        requires_review: true,
        was_noise_penalized: false,
        global_domain: globalDomain?.domain || "",
        global_subdomain: globalDomain?.subdomain || "",
        suggested_path: "",
        match_level: "fallback",
      };
      logResult(filename, fileContent, noSignal);
      return noSignal;
    }

    let result: ClassificationResult;

    if (v2parsed && v2parsed.folder) {
      // FIX 4: enrich pool with terms the AI identified
      if (v2parsed.terms.length > 0 && v2parsed.folder && !isNoiseFolderName(v2parsed.folder)) {
        try { addTermsToPool(v2parsed.terms, v2parsed.folder, targetDir); } catch {}
      }

      // Resolve the v2 folder to a valid existing folder
      const resolvedFolder =
        activeFolders.find((f) => f.toLowerCase() === v2parsed.folder.toLowerCase()) ||
        activeFolders.find((f) => f.toLowerCase().includes(v2parsed.folder.toLowerCase()) || v2parsed.folder.toLowerCase().includes(f.toLowerCase())) ||
        null;

      const sugPath = resolvedFolder && globalDomain
        ? buildSuggestedPath(globalDomain, activeFolders, resolvedFolder)
        : "";

      result = {
        category: resolvedFolder || v2parsed.folder,
        confidence: v2parsed.confidence,
        reasoning: `AI v2 CoT: ${v2parsed.reason} [Terms: ${v2parsed.terms.join(", ")}]`,
        isNewFolder: !resolvedFolder,
        detected_concepts: v2parsed.terms,
        concept_abstraction: v2parsed.reason,
        requires_review: v2parsed.confidence < REVIEW_THRESHOLD,
        was_noise_penalized: false,
        global_domain: globalDomain?.domain || "",
        global_subdomain: globalDomain?.subdomain || "",
        suggested_path: sugPath,
        match_level: "specific",
      };
    } else {
      // V2 parse failed — fall back to existing JSON parser
      const systemPrompt = buildSystemPrompt(folderContext, globalDomain, activeFolders, filename, extension);
      const userMessage = buildUserMessage(filename, extension, fileContent);
      const raw2 = await callOllama(systemPrompt, userMessage);
      result = parseResponse(raw2, activeFolders, globalDomain, rawFingerprints);
    }

    // ── FIX 3: Apply sibling boost ──────────────────────────────────────
    if (siblingSignal) {
      if (result.category.toLowerCase() === siblingSignal.folder.toLowerCase()) {
        result.confidence = Math.min(100, result.confidence + siblingSignal.boost);
        result.reasoning += ` [Sibling boost +${siblingSignal.boost}: ${siblingSignal.count} similar files already in "${siblingSignal.folder}"]`;
      }
    }

    // ── FIX 5: Multi-signal consensus ──────────────────────────────────
    const signals: ClassificationSignal[] = [
      { source: "Ollama", folder: result.category, confidence: result.confidence },
    ];
    if (poolSignal && poolSignal.confidence >= 60) signals.push(poolSignal);
    if (siblingSignal) signals.push({ source: "Sibling", folder: siblingSignal.folder, confidence: 75 });

    const consensusResult = applyMultiSignalConsensus(signals, result, filename);
    consensusResult.match_level = "specific";

    // ── Attach runner-up for disambiguation pipeline ─────────────────────
    // Find the highest-scoring pool category that differs from the primary pick.
    // This gives the UI a second candidate when confidence < 80%.
    {
      const runnerUp = poolScores.find(
        (s) => s.folder.toLowerCase() !== consensusResult.category.toLowerCase()
      );
      if (runnerUp) {
        consensusResult.second_category = runnerUp.folder;
        consensusResult.second_confidence = runnerUp.confidence;
      } else if (poolScores.length > 0 && poolScores[0].folder.toLowerCase() !== consensusResult.category.toLowerCase()) {
        consensusResult.second_category = poolScores[0].folder;
        consensusResult.second_confidence = poolScores[0].confidence;
      }
    }

    if (consensusResult.confidence >= REVIEW_THRESHOLD) {
      logResult(filename, fileContent, consensusResult);
      return consensusResult;
    }

    // ── STEP 3: Broad Fallback ────────────────────────────
    if (globalDomain && globalDomain.confidence >= DOMAIN_CONFIDENCE_THRESHOLD) {
      const sugPath = buildSuggestedPath(globalDomain, activeFolders, globalDomain.subdomain);
      const leaf = sugPath.includes("/")
        ? sanitizeFolderName(sugPath.split("/").pop()!)
        : sanitizeFolderName(globalDomain.subdomain || globalDomain.domain);

      const broad: ClassificationResult = {
        ...consensusResult,
        category: leaf || consensusResult.category,
        confidence: Math.max(consensusResult.confidence, 50),
        reasoning: consensusResult.reasoning + ` [Broad fallback via domain ${globalDomain.domain}/${globalDomain.subdomain}]`,
        isNewFolder: true,
        suggested_path: sugPath,
        match_level: "broad",
      };
      logResult(filename, fileContent, broad);
      return broad;
    }

    // Route to Needs Review
    const needsReview: ClassificationResult = {
      category: "Needs Review",
      confidence: 0,
      reasoning: consensusResult.reasoning + " [Routed to Needs Review — no confident match found]",
      isNewFolder: false,
      detected_concepts: consensusResult.detected_concepts,
      concept_abstraction: consensusResult.concept_abstraction,
      requires_review: true,
      was_noise_penalized: consensusResult.was_noise_penalized,
      global_domain: globalDomain?.domain || "",
      global_subdomain: globalDomain?.subdomain || "",
      suggested_path: "",
      match_level: "fallback",
    };
    logResult(filename, fileContent, needsReview);
    return needsReview;

  } catch (err) {
    console.error(`[ClassificationService] AI call failed: ${err}`);
    // Extension-based fallback before Needs Review
    const extFallbackMap: Record<string, string> = {
      ".pdf": "Documents", ".doc": "Documents", ".docx": "Documents", ".txt": "Documents",
      ".jpg": "Images", ".jpeg": "Images", ".png": "Images", ".heic": "Images", ".gif": "Images",
      ".mp4": "Videos", ".mov": "Videos", ".avi": "Videos",
      ".mp3": "Audio", ".wav": "Audio", ".flac": "Audio",
      ".xls": "Spreadsheets", ".xlsx": "Spreadsheets", ".csv": "Spreadsheets",
      ".zip": "Archives", ".rar": "Archives", ".7z": "Archives",
    };
    const extGuess = extFallbackMap[extension];
    const extFolder = extGuess && activeFolders.find((f) => f.toLowerCase() === extGuess.toLowerCase());
    if (extFolder) {
      return {
        category: extFolder,
        confidence: 45,
        reasoning: `AI unavailable: ${err} [Extension fallback → "${extFolder}"]`,
        isNewFolder: false,
        detected_concepts: [],
        concept_abstraction: "",
        requires_review: true,
        was_noise_penalized: false,
        global_domain: globalDomain?.domain || "",
        global_subdomain: globalDomain?.subdomain || "",
        suggested_path: "",
        match_level: "fallback",
      };
    }
    return {
      category: "Needs Review",
      confidence: 0,
      reasoning: `AI unavailable: ${err}`,
      isNewFolder: false,
      detected_concepts: [],
      concept_abstraction: "",
      requires_review: true,
      was_noise_penalized: false,
      global_domain: globalDomain?.domain || "",
      global_subdomain: globalDomain?.subdomain || "",
      suggested_path: "",
      match_level: "fallback",
    };
  }
}

/**
 * Classify multiple files.
 *
 * Fingerprints are built once; each file still gets its own
 * waterfall run (Bullseye → Specific → Broad).
 */
export async function classifyBatch(
  filePaths: string[],
  targetDir: string
): Promise<ClassificationResult[]> {
  const [userFolders, rawFingerprints, folderContext] = await Promise.all([
    scanUserFolders(targetDir),
    getFolderContext(targetDir),
    getFolderContextForPrompt(targetDir),
  ]);

  const results: ClassificationResult[] = [];

  for (const filePath of filePaths) {
    const filename = path.basename(filePath);
    const extension = path.extname(filePath).toLowerCase();
    // FIX 1+2: extract full 15k-word content and PDF/DOCX metadata in parallel
    const [fileContent, fileMetadata] = await Promise.all([
      sampleFileContent(filePath),
      extractMetadata(filePath),
    ]);

    // PRE-CHECK: Folder name literally in filename (same logic as classifyFile)
    {
      const filenamePlain = filename.toLowerCase().replace(/\.[^.]+$/, "").replace(/[-_\s+.]/g, "");
      let preCheckHit: ClassificationResult | null = null;
      for (const folder of userFolders) {
        if (isNoiseFolderName(folder)) continue;
        const folderPlain = folder.toLowerCase().replace(/[-_\s+.]/g, "");
        if (folderPlain.length >= 4 && filenamePlain.includes(folderPlain)) {
          preCheckHit = {
            category: folder,
            confidence: 100,
            reasoning: `FILENAME MATCH: folder name "${folder}" found verbatim in filename "${filename}"`,
            isNewFolder: false,
            detected_concepts: [folder],
            concept_abstraction: `Folder name found in filename`,
            requires_review: false,
            was_noise_penalized: false,
            global_domain: "",
            global_subdomain: "",
            suggested_path: "",
            match_level: "bullseye",
          };
          break;
        }
      }
      if (preCheckHit) {
        results.push(preCheckHit);
        logResult(filename, fileContent, preCheckHit);
        continue;
      }
    }

    // ── CONSISTENCY SERVICE CHECK (batch) ────────────────────────────────
    // Mirrors the single-file pipeline: fire history-based pre-classification
    // before the main AI waterfall. Zero network, zero AI calls.
    {
      const historyBoost = getHistoryBoost(filename, userFolders);
      if (historyBoost) {
        const consistencyResult: ClassificationResult = {
          category: historyBoost.folder,
          confidence: historyBoost.confidence,
          reasoning:
            `HISTORY MATCH: class key "${historyBoost.matchedKey}" was previously ` +
            `classified to "${historyBoost.folder}" ${historyBoost.hitCount} time(s)`,
          isNewFolder: false,
          detected_concepts: [historyBoost.matchedKey],
          concept_abstraction: `History pattern match`,
          requires_review: false,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: "specific",
        };
        results.push(consistencyResult);
        logResult(filename, fileContent, consistencyResult);
        continue;
      }
    }

    // ── DISAMBIGUATION RULES CHECK (batch) ───────────────────────────────
    // Auto-generated rules from confusion matrix data. Mirrors single-file pipeline.
    {
      const disambig = applyDisambiguationRules(filename, fileContent);
      if (disambig && userFolders.some((f) => f.toLowerCase() === disambig.folder.toLowerCase())) {
        const actualFolder =
          userFolders.find((f) => f.toLowerCase() === disambig.folder.toLowerCase()) ??
          disambig.folder;
        const disambigResult: ClassificationResult = {
          category: actualFolder,
          confidence: disambig.confidence,
          reasoning:
            `DISAMBIGUATION RULE: "${actualFolder}" matched ` +
            `${disambig.rule.a_indicators.length + disambig.rule.b_indicators.length} ` +
            `exclusive indicators (auto-generated from confusion history)`,
          isNewFolder: false,
          detected_concepts: disambig.rule.a_indicators.slice(0, 5),
          concept_abstraction: `Disambiguation rule match`,
          requires_review: false,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: "specific",
        };
        results.push(disambigResult);
        logResult(filename, fileContent, disambigResult);
        continue;
      }
    }

    // Archives Ban (per-file)
    let activeFolders: string[] = userFolders;
    if (isFileRecent(filePath)) {
      activeFolders = userFolders.filter((f) => !isNoiseFolderName(f));
    }

    // Step 0.5: Metadata Bullseye (FIX 1)
    if (fileMetadata) {
      const metaBullseye = tryMetadataBullseye(fileMetadata, activeFolders, rawFingerprints, filename);
      if (metaBullseye) {
        results.push(metaBullseye);
        logResult(filename, fileContent, metaBullseye);
        continue;
      }
    }

    // Step 1: Bullseye
    const bullseye = tryBullseyeMatch(
      filename,
      fileContent,
      rawFingerprints,
      activeFolders
    );
    if (bullseye) {
      results.push(bullseye);
      logResult(filename, fileContent, bullseye);
      continue;
    }

    // Step 1.5: Keyword Map (hardcoded rules)
    const keywordHit = tryKeywordMatch(filename, fileContent, activeFolders);
    if (keywordHit) {
      results.push(keywordHit);
      logResult(filename, fileContent, keywordHit);
      continue;
    }

    // Step 1.75: Smart Groups (dynamic, zero config)
    const smartHit = trySmartGroupMatch(filename, fileContent, activeFolders);
    if (smartHit) {
      results.push(smartHit);
      logResult(filename, fileContent, smartHit);
      continue;
    }

    // Step 1.85: Pool Match (global_concepts.json + knowledge_base.json)
    const poolHit = tryPoolMatch(filename, fileContent, activeFolders, targetDir);
    if (poolHit) {
      // Conflict Detection: before returning pool hit, check for multi-category conflicts
      const conflict = detectPoolConflicts(filename, fileContent, activeFolders, targetDir);
      if (conflict) {
        results.push(conflict);
        logResult(filename, fileContent, conflict);
        continue;
      }
      results.push(poolHit);
      logResult(filename, fileContent, poolHit);
      continue;
    }

    // Step 1.9: Internet Retry (only if pool match failed)
    try {
      const internetHit = await tryInternetRetry(filename, fileContent, activeFolders, targetDir);
      if (internetHit) {
        results.push(internetHit);
        logResult(filename, fileContent, internetHit);
        continue;
      }
    } catch {
      // Non-fatal
    }

    // Step 1.95: Deep Link Match (reverse Datamuse lookup)
    try {
      const deepLinkHit = await tryDeepLinkMatch(filename, fileContent, activeFolders, targetDir);
      if (deepLinkHit) {
        results.push(deepLinkHit);
        logResult(filename, fileContent, deepLinkHit);
        continue;
      }
    } catch {
      // Non-fatal
    }

    // Step 1.97: Entity Recognition (Wikipedia-backed)
    try {
      const entityHit = await tryEntityRecognition(filename, fileContent, activeFolders, targetDir);
      if (entityHit) {
        results.push(entityHit);
        logResult(filename, fileContent, entityHit);
        continue;
      }
    } catch {
      // Non-fatal
    }

    // Step 1.98: Sibling signal (FIX 3)
    let batchSiblingSignal: { folder: string; boost: number; count: number } | null = null;
    try {
      batchSiblingSignal = await trySiblingSignal(filename, filePath, activeFolders);
    } catch {}

    // Step 2: Specific Match (v2 CoT prompt)
    let globalDomain: GlobalDomainResult | null = null;
    try {
      globalDomain = await classifyGlobalDomain(filename, extension, fileContent);
    } catch {
      // Non-fatal
    }

    // FIX 5: pool signals for consensus
    const batchPoolScores = scoreAllPoolCategories(filename, fileContent, activeFolders, targetDir);
    const batchPoolSignal: ClassificationSignal | null = batchPoolScores.length > 0
      ? { source: "Pool", folder: batchPoolScores[0].folder, confidence: batchPoolScores[0].confidence }
      : null;

    const v2Prompt = buildClassificationPromptV2(activeFolders, fileContent, filename, targetDir, globalDomain);

    try {
      const raw = await callOllama("", v2Prompt, { numCtx: 4096 });
      const v2parsed = parseClassificationResponseV2(raw, activeFolders);

      // FIX 4: confidence 0 → Needs Review
      if (v2parsed && v2parsed.confidence === 0) {
        const noSig: ClassificationResult = {
          category: "Needs Review", confidence: 0,
          reasoning: `Ollama v2: no signal — ${v2parsed.reason}`,
          isNewFolder: false, detected_concepts: v2parsed.terms, concept_abstraction: "",
          requires_review: true, was_noise_penalized: false,
          global_domain: globalDomain?.domain || "", global_subdomain: globalDomain?.subdomain || "",
          suggested_path: "", match_level: "fallback",
        };
        results.push(noSig); logResult(filename, fileContent, noSig); continue;
      }

      let result: ClassificationResult;
      if (v2parsed && v2parsed.folder) {
        if (v2parsed.terms.length > 0 && !isNoiseFolderName(v2parsed.folder)) {
          try { addTermsToPool(v2parsed.terms, v2parsed.folder, targetDir); } catch {}
        }
        const resolvedFolder =
          activeFolders.find((f) => f.toLowerCase() === v2parsed.folder.toLowerCase()) ||
          activeFolders.find((f) => f.toLowerCase().includes(v2parsed.folder.toLowerCase()) || v2parsed.folder.toLowerCase().includes(f.toLowerCase())) ||
          null;
        result = {
          category: resolvedFolder || v2parsed.folder,
          confidence: v2parsed.confidence,
          reasoning: `AI v2 CoT: ${v2parsed.reason} [Terms: ${v2parsed.terms.join(", ")}]`,
          isNewFolder: !resolvedFolder,
          detected_concepts: v2parsed.terms,
          concept_abstraction: v2parsed.reason,
          requires_review: v2parsed.confidence < REVIEW_THRESHOLD,
          was_noise_penalized: false,
          global_domain: globalDomain?.domain || "", global_subdomain: globalDomain?.subdomain || "",
          suggested_path: "", match_level: "specific",
        };
      } else {
        const sp = buildSystemPrompt(folderContext, globalDomain, activeFolders, filename, extension);
        const um = buildUserMessage(filename, extension, fileContent);
        const raw2 = await callOllama(sp, um);
        result = parseResponse(raw2, activeFolders, globalDomain, rawFingerprints);
      }

      // FIX 3: sibling boost
      if (batchSiblingSignal && result.category.toLowerCase() === batchSiblingSignal.folder.toLowerCase()) {
        result.confidence = Math.min(100, result.confidence + batchSiblingSignal.boost);
        result.reasoning += ` [Sibling +${batchSiblingSignal.boost}: ${batchSiblingSignal.count} files in "${batchSiblingSignal.folder}"]`;
      }

      // FIX 5: consensus
      const batchSignals: ClassificationSignal[] = [
        { source: "Ollama", folder: result.category, confidence: result.confidence },
      ];
      if (batchPoolSignal && batchPoolSignal.confidence >= 60) batchSignals.push(batchPoolSignal);
      if (batchSiblingSignal) batchSignals.push({ source: "Sibling", folder: batchSiblingSignal.folder, confidence: 75 });

      const batchConsensus = applyMultiSignalConsensus(batchSignals, result, filename);
      batchConsensus.match_level = "specific";

      if (batchConsensus.confidence >= REVIEW_THRESHOLD) {
        results.push(batchConsensus); logResult(filename, fileContent, batchConsensus); continue;
      }

      // Step 3: Broad Fallback
      if (globalDomain && globalDomain.confidence >= DOMAIN_CONFIDENCE_THRESHOLD) {
        const sugPath = buildSuggestedPath(globalDomain, activeFolders, globalDomain.subdomain);
        const leaf = sugPath.includes("/")
          ? sanitizeFolderName(sugPath.split("/").pop()!)
          : sanitizeFolderName(globalDomain.subdomain || globalDomain.domain);
        const broad: ClassificationResult = {
          ...batchConsensus, category: leaf || batchConsensus.category,
          confidence: Math.max(batchConsensus.confidence, 50),
          reasoning: batchConsensus.reasoning + ` [Broad fallback via domain ${globalDomain.domain}/${globalDomain.subdomain}]`,
          isNewFolder: true, suggested_path: sugPath, match_level: "broad",
        };
        results.push(broad); logResult(filename, fileContent, broad); continue;
      }

      // Needs Review
      const needsReview: ClassificationResult = {
        category: "Needs Review", confidence: 0,
        reasoning: batchConsensus.reasoning + " [Routed to Needs Review]",
        isNewFolder: false,
        detected_concepts: batchConsensus.detected_concepts,
        concept_abstraction: batchConsensus.concept_abstraction,
        requires_review: true, was_noise_penalized: batchConsensus.was_noise_penalized,
        global_domain: globalDomain?.domain || "", global_subdomain: globalDomain?.subdomain || "",
        suggested_path: "", match_level: "fallback",
      };
      results.push(needsReview); logResult(filename, fileContent, needsReview);
    } catch (err) {
      console.error(`[ClassificationService] Failed for ${filename}: ${err}`);
      // Extension-based fallback before Needs Review
      const extFallbackMap: Record<string, string> = {
        ".pdf": "Documents", ".doc": "Documents", ".docx": "Documents", ".txt": "Documents",
        ".jpg": "Images", ".jpeg": "Images", ".png": "Images", ".heic": "Images", ".gif": "Images",
        ".mp4": "Videos", ".mov": "Videos", ".avi": "Videos",
        ".mp3": "Audio", ".wav": "Audio", ".flac": "Audio",
        ".xls": "Spreadsheets", ".xlsx": "Spreadsheets", ".csv": "Spreadsheets",
        ".zip": "Archives", ".rar": "Archives", ".7z": "Archives",
      };
      const extGuess = extFallbackMap[extension];
      const extFolder = extGuess && activeFolders.find((f) => f.toLowerCase() === extGuess.toLowerCase());
      if (extFolder) {
        results.push({
          category: extFolder,
          confidence: 45,
          reasoning: `AI unavailable: ${err} [Extension fallback → "${extFolder}"]`,
          isNewFolder: false,
          detected_concepts: [],
          concept_abstraction: "",
          requires_review: true,
          was_noise_penalized: false,
          global_domain: globalDomain?.domain || "",
          global_subdomain: globalDomain?.subdomain || "",
          suggested_path: "",
          match_level: "fallback",
        });
      } else {
        results.push({
          category: "Needs Review",
          confidence: 0,
          reasoning: `AI unavailable: ${err}`,
          isNewFolder: false,
          detected_concepts: [],
          concept_abstraction: "",
          requires_review: true,
          was_noise_penalized: false,
          global_domain: globalDomain?.domain || "",
          global_subdomain: globalDomain?.subdomain || "",
          suggested_path: "",
          match_level: "fallback",
        });
      }
    }
  }

  return results;
}

// ── Logging helper ────────────────────────────────────────

function logResult(
  filename: string,
  fileContent: string,
  r: ClassificationResult
): void {
  const wc = fileContent ? fileContent.split(/\s+/).length : 0;
  console.log(
    `[Classification] "${filename}" (${wc}w) → ${r.category} ` +
      `(${r.confidence}% ${r.match_level}` +
      `${r.isNewFolder ? " NEW" : ""}` +
      `${r.requires_review ? " REVIEW" : ""}` +
      `${r.was_noise_penalized ? " PENALIZED" : ""}` +
      `${r.global_domain ? ` domain=${r.global_domain}/${r.global_subdomain}` : ""}` +
      `${r.suggested_path ? ` path="${r.suggested_path}"` : ""})`
  );
}

// ── Pool management (via universal-pool-manager) ────────────────

/**
 * Get pool health report for a given target directory.
 * Exposes per-folder pollution metrics for the UI dashboard.
 */
export function getPoolHealthReport(targetDir: string) {
  return computePoolHealth(poolManagerReadMergedPool(targetDir));
}

/**
 * Get top distinctive terms for a folder (used for prompt building).
 * Exposed so external tools can inspect what the system knows.
 */
export function getFolderDistinctiveTerms(
  folder: string,
  targetDir: string,
  topN = 20
) {
  return getTopDistinctiveTerms(folder, poolManagerReadMergedPool(targetDir), topN);
}

// ── Correction recorder (unchanged) ──────────────────────

export function submitCorrection(
  filename: string,
  extension: string,
  aiGuess: string,
  aiConfidence: number,
  userChoice: string,
  targetDir?: string,
  contentHint?: string   // short content snippet (≤12 words) for few-shot injection
): void {
  // Record ALL classifications — both corrections AND confirmed-correct entries.
  //
  // WHY: ConsistencyService reads user_correction as ground truth so it needs
  // confirmed-correct entries too. A file the AI got right AND the user confirmed
  // is the STRONGEST evidence of a good classification pattern.
  // Previously only corrections were recorded, which meant ConsistencyService
  // had no data unless the AI was wrong — defeating the whole purpose.
  const wasCorrect = aiGuess.toLowerCase() === userChoice.toLowerCase();

  recordCorrection({
    filename,
    extension,
    ai_guess: aiGuess,
    ai_confidence: aiConfidence,
    user_correction: userChoice,
    timestamp: Date.now(),
    content_hint: contentHint,
  });

  // Track accuracy and confusion patterns for the quality monitor.
  recordClassification(aiGuess, aiConfidence, userChoice, wasCorrect);

  // Enrich the concept pool with terms from this correction.
  // Only fires if targetDir is provided — skips silently for legacy callers.
  if (targetDir) {
    enrichPoolFromCorrection(filename, userChoice, aiConfidence, targetDir);
  }
}

/**
 * Get confidence tier for a result — used by the UI to decide how to
 * present the classification (auto-sort vs notify vs suggest vs review).
 */
export function getResultConfidenceTier(confidence: number, folder?: string) {
  return getConfidenceTier(confidence, folder);
}

/**
 * Check if a file matches any auto-generated disambiguation rule.
 * Should be called in the pre-check pipeline before main classification.
 */
export function checkDisambiguationRules(filename: string, fileContent: string) {
  return applyDisambiguationRules(filename, fileContent);
}

/**
 * Step 3 of the 4-step disambiguation pipeline.
 *
 * Asks the AI to differentiate between two candidate folders and
 * identify which unique keywords in the file support each one.
 * Called when classifyFile returns confidence < 80% with two plausible categories.
 *
 * @param catA      Primary category (AI's top pick)
 * @param catB      Runner-up category
 * @param filename  Name of the file being classified
 * @param fileContent  Extracted text content of the file (will be trimmed to 800 chars)
 * @returns Object with keyword arrays for each category plus a reasoning string
 */
export async function disambiguateCategories(
  catA: string,
  catB: string,
  filename: string,
  fileContent: string
): Promise<{ catAKeywords: string[]; catBKeywords: string[]; reasoning: string }> {
  const snippet = (fileContent || "").slice(0, 800);
  const prompt = `You are a file organizer. A file named "${filename}" could belong to either the "${catA}" folder or the "${catB}" folder.

File content snippet:
---
${snippet}
---

Differentiate between the two folders:
- List keywords in this file that point specifically toward "${catA}"
- List keywords in this file that point specifically toward "${catB}"

Reply in EXACTLY this format (no extra text, no headers):
CAT_A_KEYWORDS: keyword1, keyword2, keyword3
CAT_B_KEYWORDS: keyword1, keyword2, keyword3
REASONING: one sentence explaining the key difference between the two folders for this file`;

  try {
    const raw = await callOllama("", prompt, { numCtx: 2048, timeout: 30000 });
    const catAMatch = raw.match(/CAT_A_KEYWORDS:\s*(.+)/i);
    const catBMatch = raw.match(/CAT_B_KEYWORDS:\s*(.+)/i);
    const reasonMatch = raw.match(/REASONING:\s*(.+)/i);

    const catAKeywords = catAMatch
      ? catAMatch[1].split(",").map((k) => k.trim()).filter(Boolean)
      : [];
    const catBKeywords = catBMatch
      ? catBMatch[1].split(",").map((k) => k.trim()).filter(Boolean)
      : [];
    const reasoning = reasonMatch ? reasonMatch[1].trim() : "No clear differentiator found.";

    return { catAKeywords, catBKeywords, reasoning };
  } catch (err) {
    console.error(`[ClassificationService] disambiguateCategories failed: ${err}`);
    return { catAKeywords: [], catBKeywords: [], reasoning: "Disambiguation unavailable." };
  }
}
