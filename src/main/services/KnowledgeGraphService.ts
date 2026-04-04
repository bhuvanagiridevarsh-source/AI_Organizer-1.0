/**
 * KnowledgeGraphService.ts — AI-powered domain vocabulary for organized folders.
 *
 * Builds a rich, domain-specific term list for every folder using a two-phase
 * Ollama strategy:
 *
 *   Phase 1 — Describe:  Ask the LLM what topic this folder covers, based on
 *                         a sample of its filenames.
 *   Phase 2 — Generate:  Ask the LLM for 40 specific search terms for that domain.
 *
 * Results are stored in <rootDir>/knowledge_graph.json and can be applied to
 * global_concepts.json so the classification pipeline benefits immediately.
 *
 * QUALITY GATE — isQualityTerm() is the central validator for every term added
 * anywhere in the system:
 *   • ≤3 characters → blocked
 *   • In the generic blocklist → blocked
 *   • Pure numbers or punctuation → blocked
 *   • Appears in >40% of all folder pools → blocked (cross-pool noise)
 *
 * Exported as a standalone function so PoolEnrichmentService and all other
 * term-addition paths can import and reuse the same gate.
 */

import fs from "fs";
import path from "path";
import * as LlamaService from "./LlamaService";

// ── Constants ──────────────────────────────────────────────────────────────

const KG_FILE           = "knowledge_graph.json";
const KG_REBUILT_FLAG   = "knowledge_graph_rebuilt.json";
const GLOBAL_CONCEPTS   = "global_concepts.json";

const GENERATE_TIMEOUT  = 60_000;   // 60 s per phase
const MAX_SAMPLE_FILES  = 12;       // filenames fed to Phase 1
const CROSS_POOL_LIMIT  = 0.40;     // term appearing in >40% of folders = generic

// ── Generic blocklist ──────────────────────────────────────────────────────

const GENERIC_BLOCKLIST = new Set([
  "notes", "note", "file", "files", "document", "documents", "folder", "folders",
  "study", "studies", "studying", "guide", "summary", "summaries", "overview",
  "introduction", "chapter", "chapters", "lecture", "lectures", "homework",
  "assignment", "assignments", "worksheet", "worksheets", "test", "tests",
  "exam", "exams", "quiz", "quizzes", "review", "reviews", "practice",
  "help", "information", "data", "project", "projects", "report", "reports",
  "essay", "essays", "paper", "papers", "book", "books", "page", "pages",
  "unit", "units", "lesson", "lessons", "class", "classes", "course", "courses",
  "school", "college", "university", "student", "students", "teacher", "teachers",
  "professor", "professors", "work", "example", "examples", "exercise", "exercises",
  "content", "material", "materials", "resource", "resources", "topic", "topics",
  "subject", "subjects", "area", "areas", "section", "sections", "part", "parts",
  "type", "types", "list", "lists", "set", "sets", "group", "groups",
  "general", "basic", "advanced", "complete", "final", "main", "key", "important",
  "using", "used", "use", "uses", "make", "making", "made", "new", "old",
  "good", "great", "best", "first", "last", "next", "other", "various",
]);

// ── Types ──────────────────────────────────────────────────────────────────

export interface FolderGraph {
  description: string;
  terms: string[];
  generated: number;
}

export interface KnowledgeGraph {
  version: number;
  generated: number;
  folders: Record<string, FolderGraph>;
}

export interface RebuildProgress {
  folder: string;
  status: "generating" | "done" | "skipped" | "error";
  termCount?: number;
  message?: string;
}

// ── File I/O ───────────────────────────────────────────────────────────────

export function getKGPath(rootDir: string): string {
  return path.join(rootDir, KG_FILE);
}

export function getKGFlagPath(rootDir: string): string {
  return path.join(rootDir, KG_REBUILT_FLAG);
}

export function loadKG(rootDir: string): KnowledgeGraph {
  try {
    const raw = fs.readFileSync(getKGPath(rootDir), "utf-8");
    const data = JSON.parse(raw);
    if (data?.folders) return data as KnowledgeGraph;
  } catch { /* first run */ }
  return { version: 1, generated: Date.now(), folders: {} };
}

function saveKG(rootDir: string, kg: KnowledgeGraph): void {
  try {
    fs.writeFileSync(getKGPath(rootDir), JSON.stringify(kg, null, 2), "utf-8");
    fs.writeFileSync(getKGFlagPath(rootDir), JSON.stringify({ ts: Date.now() }), "utf-8");
  } catch (err) {
    console.error(`[KnowledgeGraph] Failed to save: ${err}`);
  }
}

// ── Quality Gate ───────────────────────────────────────────────────────────

/**
 * Central validator for every term added to any pool or knowledge graph.
 *
 * Returns true (keep) / false (reject) for a candidate term.
 *
 * @param term          Candidate term (will be trimmed + lowercased internally)
 * @param allPools      Optional: map of folderName → terms array, for cross-pool check.
 *                      If omitted, the cross-pool check is skipped.
 */
export function isQualityTerm(
  term: string,
  allPools?: Record<string, string[]>
): boolean {
  const t = term.trim().toLowerCase();

  // Minimum length: 4 chars
  if (t.length <= 3) return false;

  // Pure numbers or punctuation
  if (/^[\d\s\W]+$/.test(t)) return false;

  // Single-word check against generic blocklist
  const words = t.split(/\s+/);
  if (words.length === 1 && GENERIC_BLOCKLIST.has(t)) return false;

  // Multi-word: all words in phrase are generic
  if (words.length > 1 && words.every((w) => GENERIC_BLOCKLIST.has(w))) return false;

  // Cross-pool noise: term appears in too many folder pools
  if (allPools) {
    const totalFolders = Object.keys(allPools).length;
    if (totalFolders > 0) {
      const foldersWithTerm = Object.values(allPools).filter((terms) =>
        terms.some((existing) => existing.toLowerCase() === t)
      ).length;
      if (foldersWithTerm / totalFolders > CROSS_POOL_LIMIT) return false;
    }
  }

  return true;
}

// ── Folder name similarity (for duplicate merging) ─────────────────────────

/**
 * Token-overlap similarity between two folder names.
 * Returns a value in [0, 1] where 1.0 = identical tokens.
 */
function folderSimilarity(a: string, b: string): number {
  const tokA = new Set(a.toLowerCase().split(/[\s_\-]+/).filter((t) => t.length > 1));
  const tokB = new Set(b.toLowerCase().split(/[\s_\-]+/).filter((t) => t.length > 1));
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokA) if (tokB.has(t)) overlap++;
  return overlap / Math.max(tokA.size, tokB.size);
}

/**
 * Find the best existing graph entry that is 80%+ similar to `folderName`.
 * Returns the matching folder name (key in the graph) or null.
 */
function findDuplicateFolder(
  folderName: string,
  graph: KnowledgeGraph
): string | null {
  for (const existing of Object.keys(graph.folders)) {
    if (folderSimilarity(existing, folderName) >= 0.8) return existing;
  }
  return null;
}

// ── LlamaService helpers ───────────────────────────────────────────────────

/** Generate text via the on-device model (no Ollama). */
async function ollamaGenerate(prompt: string, timeoutMs = GENERATE_TIMEOUT): Promise<string> {
  return LlamaService.generate(prompt, { maxTokens: 512, temperature: 0.2, timeoutMs });
}

/** Alias kept so callers using generateWithBestModel don't break. */
async function generateWithBestModel(prompt: string): Promise<string> {
  return LlamaService.generate(prompt, { maxTokens: 512, temperature: 0.2, timeoutMs: GENERATE_TIMEOUT });
}

// ── Two-phase folder graph builder ────────────────────────────────────────

/**
 * Run the two-phase Ollama prompt pipeline for a single folder.
 *
 * Phase 1: Describe what subject the folder covers (1 sentence).
 * Phase 2: Generate 40 domain-specific search terms.
 *
 * Returns null if Ollama is unavailable or no useful terms are produced.
 */
export async function buildFolderGraph(
  folderName: string,
  filenames: string[],
  allPools?: Record<string, string[]>
): Promise<FolderGraph | null> {
  const sampleFiles = filenames.slice(0, MAX_SAMPLE_FILES).join("\n");

  // ── Phase 1: Describe ────────────────────────────────────────────────────
  const phase1Prompt =
    `A folder named "${folderName}" contains these files:\n${sampleFiles}\n\n` +
    `In exactly ONE sentence, describe what academic subject or topic this folder is about. ` +
    `Do NOT use the words "folder", "files", or "documents". ` +
    `Just describe the domain (e.g. "Advanced Placement United States History course covering colonial period through modern era.").`;

  let description: string;
  try {
    const raw = await generateWithBestModel(phase1Prompt);
    description = raw.trim().split("\n")[0].trim();
    if (!description || description.length < 10) {
      description = `Files related to ${folderName}`;
    }
  } catch (err) {
    console.warn(`[KnowledgeGraph] Phase 1 failed for "${folderName}": ${err}`);
    return null;
  }

  // ── Phase 2: Generate terms ───────────────────────────────────────────────
  const phase2Prompt =
    `You are building a search index for content about: ${description}\n\n` +
    `Generate exactly 40 specific search terms that appear in this type of content.\n` +
    `Requirements:\n` +
    `- 2-5 words each (multi-word phrases strongly preferred)\n` +
    `- Domain-specific only — NO generic words like "notes", "study", "homework", "guide"\n` +
    `- Include: key concepts, technical vocabulary, proper nouns, theories, methods, events\n` +
    `- Each term on its own line, no numbering, no bullets, no explanations\n\n` +
    `Output ONLY the terms, one per line:`;

  let rawTerms: string;
  try {
    rawTerms = await generateWithBestModel(phase2Prompt);
  } catch (err) {
    console.warn(`[KnowledgeGraph] Phase 2 failed for "${folderName}": ${err}`);
    return null;
  }

  // Parse and validate terms
  const terms = rawTerms
    .split("\n")
    .map((line) => line.replace(/^[\d\.\-\*•]+\s*/, "").trim().toLowerCase())
    .filter((t) => t.length > 3 && isQualityTerm(t, allPools));

  if (terms.length === 0) {
    console.warn(`[KnowledgeGraph] No quality terms generated for "${folderName}"`);
    return null;
  }

  console.log(`[KnowledgeGraph] "${folderName}": ${terms.length} terms | ${description.slice(0, 60)}`);

  return {
    description,
    terms: [...new Set(terms)], // deduplicate
    generated: Date.now(),
  };
}

// ── Rebuild all folders ────────────────────────────────────────────────────

/**
 * Walk rootDir, generate a knowledge graph for every subfolder,
 * and save the result to knowledge_graph.json.
 *
 * Merges the generated terms into global_concepts.json automatically.
 *
 * @param rootDir     Organized files root (e.g. ~/Desktop/AI_SORTED_FILES)
 * @param onProgress  Optional callback for UI progress updates
 */
export async function rebuildAllFolders(
  rootDir: string,
  onProgress?: (p: RebuildProgress) => void
): Promise<KnowledgeGraph> {
  const kg = loadKG(rootDir);
  const before = JSON.parse(JSON.stringify(kg.folders)) as Record<string, FolderGraph>;

  // Read existing pools for the quality gate's cross-pool check
  const poolPath = path.join(rootDir, GLOBAL_CONCEPTS);
  let allPools: Record<string, string[]> = {};
  try {
    allPools = JSON.parse(fs.readFileSync(poolPath, "utf-8"));
  } catch { /* no pools yet */ }

  // Enumerate subfolders
  let subfolders: string[];
  try {
    subfolders = fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => !n.startsWith(".") && n !== "Needs Review");
  } catch (err) {
    console.error(`[KnowledgeGraph] Cannot read rootDir: ${err}`);
    return kg;
  }

  for (const folderName of subfolders) {
    onProgress?.({ folder: folderName, status: "generating" });

    // Duplicate merging: if a similar folder already has a graph, reuse it
    const duplicate = findDuplicateFolder(folderName, kg);
    if (duplicate && duplicate !== folderName && kg.folders[duplicate]) {
      kg.folders[folderName] = { ...kg.folders[duplicate], generated: Date.now() };
      onProgress?.({
        folder: folderName,
        status: "done",
        termCount: kg.folders[folderName].terms.length,
        message: `merged from "${duplicate}"`,
      });
      continue;
    }

    // Collect filenames in this subfolder
    const folderPath = path.join(rootDir, folderName);
    let filenames: string[];
    try {
      filenames = fs.readdirSync(folderPath)
        .filter((f) => !f.startsWith("."))
        .slice(0, MAX_SAMPLE_FILES);
    } catch {
      onProgress?.({ folder: folderName, status: "skipped", message: "unreadable" });
      continue;
    }

    if (filenames.length === 0) {
      onProgress?.({ folder: folderName, status: "skipped", message: "empty folder" });
      continue;
    }

    try {
      const graph = await buildFolderGraph(folderName, filenames, allPools);
      if (graph) {
        kg.folders[folderName] = graph;
        onProgress?.({ folder: folderName, status: "done", termCount: graph.terms.length });
      } else {
        onProgress?.({ folder: folderName, status: "error", message: "no terms generated" });
      }
    } catch (err) {
      console.error(`[KnowledgeGraph] Error on "${folderName}": ${err}`);
      onProgress?.({ folder: folderName, status: "error", message: String(err) });
    }
  }

  kg.generated = Date.now();
  saveKG(rootDir, kg);

  // Log before/after comparison
  const newFolders = Object.keys(kg.folders).filter((f) => !before[f]);
  const improved = Object.keys(kg.folders).filter(
    (f) => before[f] && kg.folders[f].terms.length > (before[f]?.terms.length ?? 0)
  );
  console.log(
    `[KnowledgeGraph] Rebuild complete. ` +
    `New: ${newFolders.length}, Improved: ${improved.length}, ` +
    `Total folders: ${Object.keys(kg.folders).length}`
  );

  // Apply to pool automatically
  applyGraphToPool(rootDir, kg);

  return kg;
}

// ── Apply graph to pool ────────────────────────────────────────────────────

/**
 * Merge knowledge graph terms into global_concepts.json so the classification
 * pipeline can use them immediately.
 *
 * Only adds terms that pass `isQualityTerm` and are not already in the pool.
 */
export function applyGraphToPool(rootDir: string, kg?: KnowledgeGraph): void {
  const poolPath = path.join(rootDir, GLOBAL_CONCEPTS);
  const usedKg = kg ?? loadKG(rootDir);

  let pools: Record<string, string[]> = {};
  try {
    pools = JSON.parse(fs.readFileSync(poolPath, "utf-8"));
  } catch { /* start fresh */ }

  let added = 0;

  for (const [folder, graph] of Object.entries(usedKg.folders)) {
    const existing = new Set((pools[folder] ?? []).map((t) => t.toLowerCase()));
    const newTerms: string[] = [];

    for (const term of graph.terms) {
      if (!existing.has(term) && isQualityTerm(term, pools)) {
        newTerms.push(term);
        existing.add(term);
      }
    }

    if (newTerms.length > 0) {
      pools[folder] = [...(pools[folder] ?? []), ...newTerms];
      added += newTerms.length;
    }
  }

  if (added > 0) {
    try {
      fs.writeFileSync(poolPath, JSON.stringify(pools, null, 2), "utf-8");
      console.log(`[KnowledgeGraph] Applied ${added} terms to global_concepts.json`);
    } catch (err) {
      console.error(`[KnowledgeGraph] Failed to write pool: ${err}`);
    }
  }
}

// ── Auto-bootstrap for new folders ────────────────────────────────────────

/**
 * Generate a knowledge graph entry for a single newly-created folder.
 * Called from ClassificationService when a new folder is first seen.
 * Fire-and-forget — does not block the classification pipeline.
 */
export async function bootstrapNewFolder(
  folderName: string,
  rootDir: string
): Promise<void> {
  const kg = loadKG(rootDir);

  // Already have a graph for this folder (or a duplicate)?
  if (kg.folders[folderName]) return;
  if (findDuplicateFolder(folderName, kg)) return;

  const folderPath = path.join(rootDir, folderName);
  if (!fs.existsSync(folderPath)) return;

  let filenames: string[];
  try {
    filenames = fs.readdirSync(folderPath)
      .filter((f) => !f.startsWith("."))
      .slice(0, MAX_SAMPLE_FILES);
  } catch {
    return;
  }

  if (filenames.length === 0) return;

  // Read existing pools for cross-pool check
  let allPools: Record<string, string[]> = {};
  try {
    allPools = JSON.parse(fs.readFileSync(path.join(rootDir, GLOBAL_CONCEPTS), "utf-8"));
  } catch { /* ok */ }

  try {
    const graph = await buildFolderGraph(folderName, filenames, allPools);
    if (graph) {
      kg.folders[folderName] = graph;
      saveKG(rootDir, kg);
      applyGraphToPool(rootDir, kg);
      console.log(`[KnowledgeGraph] Bootstrapped new folder: "${folderName}" (${graph.terms.length} terms)`);
    }
  } catch (err) {
    console.warn(`[KnowledgeGraph] Bootstrap failed for "${folderName}": ${err}`);
  }
}

// ── Startup validation ─────────────────────────────────────────────────────

/**
 * Called at app startup. If a rebuilt knowledge graph exists, apply it to
 * the pool so classification benefits from the latest domain terms.
 * Returns true if the graph was applied, false if not yet generated.
 */
export function validateAndApplyKGOnStartup(rootDir: string): boolean {
  const flagPath = getKGFlagPath(rootDir);
  if (!fs.existsSync(flagPath)) return false;

  const kg = loadKG(rootDir);
  if (Object.keys(kg.folders).length === 0) return false;

  applyGraphToPool(rootDir, kg);
  console.log(
    `[KnowledgeGraph] Startup: applied knowledge graph (${Object.keys(kg.folders).length} folders)`
  );
  return true;
}
