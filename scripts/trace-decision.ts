/**
 * trace-decision.ts — Decision Diary (Specificity Waterfall Edition)
 *
 * Runs the FULL Specificity Waterfall pipeline for a single file and
 * prints a step-by-step diagnostic showing every decision the engine makes.
 *
 * PIPELINE (mirrors ClassificationService.ts exactly):
 *   Step 0 — Archives Ban    (recent files can't land in noise folders)
 *   Step 1 — Context Loading  (fingerprints, aliases, expansion cache)
 *   Step 2 — Text Extraction  (native, PDF, OCR cascade)
 *   Step 3 — Bullseye Check   (zero-AI token match → 100% if hit)
 *   Step 4 — Learning Memory  (user corrections for prompt injection)
 *   Step 5 — Global Domain    (first Ollama call — Education / Finance / …)
 *   Step 6 — Specific Match   (second Ollama call — domain-aware CoT)
 *   Step 7 — Broad Fallback   (only if Step 6 confidence < 60%)
 *   Step 8 — Scorecard        (heuristic overlap + final verdict)
 *
 * Usage:
 *   npm run trace -- ./my-file.pdf
 *   npm run trace -- ./my-file.pdf --target ~/Desktop/AI_SORTED_FILES
 *   npx tsx scripts/trace-decision.ts ./my-file.pdf --target ~/Organized
 */

import fs from "fs";
import path from "path";
import http from "http";
import os from "os";

// ═══════════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════════

interface FolderFingerprint {
  keywords: string[];
  coreTopics: string[];
  sampleCount: number;
  isAIExpanded: boolean;
  isNoiseFolder: boolean;
  activityLabel: string;
  lastActivityMs: number;
}

interface ExtractionTrace {
  text: string;
  wordCount: number;
  strategy: string;
  ocrUsed: boolean;
  fileSizeBytes: number;
  fileModified: Date;
}

interface GlobalDomainResult {
  domain: string;
  subdomain: string;
  confidence: number;
}

interface ClassificationResult {
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
  match_level: "bullseye" | "specific" | "broad" | "fallback";
}

// ═══════════════════════════════════════════════════════════════
//  ANSI COLORS & OUTPUT HELPERS
// ═══════════════════════════════════════════════════════════════

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgRed: "\x1b[41m",
};

const HR = C.dim + "─".repeat(62) + C.reset;

function header() {
  console.log();
  console.log(
    `${C.bold}${C.bgBlue}${C.white} DECISION DIARY — Specificity Waterfall Trace ${C.reset}`
  );
  console.log(HR);
}

function step(num: number | string, title: string) {
  console.log();
  console.log(`${C.bold}${C.cyan}STEP ${num}: ${title}${C.reset}`);
  console.log(HR);
}

function ok(msg: string) {
  console.log(`  ${C.green}\u2713${C.reset} ${msg}`);
}
function warn(msg: string) {
  console.log(`  ${C.yellow}\u26A0${C.reset} ${msg}`);
}
function info(msg: string) {
  console.log(`  ${C.cyan}\u2192${C.reset} ${msg}`);
}
function field(key: string, val: string) {
  console.log(`  ${C.dim}${key}:${C.reset} ${val}`);
}
function indent(msg: string) {
  console.log(`    ${msg}`);
}

// ═══════════════════════════════════════════════════════════════
//  CONFIGURATION (mirrors ClassificationService.ts exactly)
// ═══════════════════════════════════════════════════════════════

const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const MODEL_NAME = "llama3.2:1b";
const REQUEST_TIMEOUT_MS = 90_000;

const REVIEW_THRESHOLD = 60;
const NOISE_FOLDER_PENALTY = 30;
const DOMAIN_CONFIDENCE_THRESHOLD = 60;
const DOMAIN_CLASSIFIER_WORDS = 1000;
const BULLSEYE_CONTENT_WORDS = 100;
const HEADER_ZONE_CHARS = 500;
const RECENCY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 3 months

const SAMPLE_FILES_PER_FOLDER = 3;
const WORDS_PER_SAMPLE = 500;
const TOP_KEYWORDS = 10;
const TARGET_WORDS = 2000;
const MAX_READ_BYTES = 32768;
const OCR_THRESHOLD = 50;

// ── Global Domains (mirrors ClassificationService) ────────────

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
};

// ── Noise Folders ─────────────────────────────────────────────

const NOISE_FOLDERS = new Set([
  "archives", "archive", "old", "misc", "miscellaneous", "temp", "temporary",
  "backup", "backups", "downloads", "download", "trash", "deleted",
  "unsorted", "random", "stuff", "other", "various", "general",
  "inbox", "incoming", "outbox", "sent", "drafts",
  "node_modules", ".git", ".svn", "__pycache__", ".cache", ".tmp",
  "$recycle.bin", "system volume information",
]);

const SYSTEM_FOLDERS = new Set([
  ".ds_store", ".spotlight-v100", ".trashes", ".fseventsd",
  "$recycle.bin", "system volume information", "thumbs.db",
  ".git", ".svn", "node_modules", "__pycache__", ".idea", ".vscode",
]);

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "its", "that", "this", "was",
  "are", "be", "has", "had", "have", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "can", "not", "no",
  "if", "as", "so", "up", "out", "all", "about", "into", "over",
  "after", "before", "between", "under", "above", "below", "than",
  "then", "when", "where", "while", "which", "who", "whom", "what",
  "how", "there", "here", "each", "every", "both", "few", "more",
  "most", "other", "some", "such", "only", "just", "also", "very",
  "even", "still", "well", "back", "been", "being", "much", "any",
  "these", "those", "own", "same", "because", "through", "during",
  "function", "return", "const", "let", "var", "import", "export",
  "class", "new", "null", "undefined", "true", "false", "string",
  "number", "void", "type", "interface", "public", "private",
  "static", "async", "await", "try", "catch", "throw", "else",
  "div", "span", "src", "href", "http", "https", "www", "com",
]);

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".py", ".js", ".ts", ".jsx", ".tsx", ".json", ".csv",
  ".log", ".html", ".css", ".scss", ".xml", ".yaml", ".yml", ".toml",
  ".ini", ".cfg", ".conf", ".sh", ".bash", ".zsh", ".fish", ".bat",
  ".ps1", ".rb", ".php", ".java", ".c", ".cpp", ".h", ".hpp", ".go",
  ".rs", ".swift", ".kt", ".scala", ".r", ".m", ".sql", ".graphql",
  ".vue", ".svelte", ".astro", ".env", ".gitignore", ".dockerfile",
]);

const PDF_EXTENSIONS = new Set([".pdf"]);
const DOCX_EXTENSIONS = new Set([".docx", ".doc"]);
const OFFICE_EXTENSIONS = new Set([
  ".pptx", ".ppt", ".xlsx", ".xls", ".odt", ".odp", ".ods", ".rtf",
]);
const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp", ".webp", ".gif",
]);

const READABLE_EXTENSIONS = new Set([
  ".txt", ".md", ".py", ".js", ".ts", ".jsx", ".tsx", ".json", ".csv",
  ".log", ".html", ".css", ".xml", ".yaml", ".yml", ".toml", ".ini",
  ".cfg", ".conf", ".sh", ".rb", ".php", ".java", ".c", ".cpp", ".h",
  ".go", ".rs", ".swift", ".kt", ".sql", ".vue", ".svelte", ".rtf",
]);

// ═══════════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function isNoiseFolderName(name: string): boolean {
  return NOISE_FOLDERS.has(name.toLowerCase());
}

function isFileRecent(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    const created = stat.birthtimeMs || stat.mtimeMs;
    return Date.now() - created < RECENCY_WINDOW_MS;
  } catch {
    return false;
  }
}

function trimWords(text: string, max: number): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  return words.slice(0, max).join(" ");
}

function stripTags(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanOutput(raw: string): string {
  if (!raw || raw.trim().length < 5) return "";
  return trimWords(raw.replace(/\s+/g, " ").trim(), TARGET_WORDS);
}

function wordCount(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Tokeniser — mirrors ClassificationService.tokenize() exactly.
 *
 *   "ap20-seminar-task-1.pdf"
 *   → Set { "ap", "ap20", "seminar", "task" }
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
    // "20th" → also emit "th" (usually too short, filtered by length)
    const alphaSuffix = word.match(/\d([a-z]{2,})$/);
    if (alphaSuffix) {
      tokens.add(alphaSuffix[1]);
    }
  }

  return tokens;
}

/**
 * Fuzzy token-to-word match — mirrors ClassificationService.tokenMatchesWord().
 */
function tokenMatchesWord(token: string, word: string): boolean {
  if (token === word) return true;
  const shorter = token.length <= word.length ? token : word;
  const longer = token.length > word.length ? token : word;
  if (shorter.length < 2) return false;
  return longer.startsWith(shorter) && shorter.length / longer.length >= 0.6;
}

/**
 * Keyword extraction with ACRONYM AWARENESS.
 * Mirrors ContextService.extractKeywords exactly.
 */
function extractKeywords(text: string, topN: number): string[] {
  const rawTokens = text.replace(/[-_]/g, " ").split(/\s+/).filter((w) => w.length > 0);
  const processed: string[] = [];

  for (const token of rawTokens) {
    const lower = token.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    if (token.length === 2 && token === token.toUpperCase() && /^[A-Z]{2}$/.test(token)) {
      processed.push(token);
      continue;
    }
    const cleaned = lower.replace(/[^a-z]/g, "");
    if (cleaned.length >= 3 && !STOP_WORDS.has(cleaned)) {
      processed.push(cleaned);
    }
  }

  const freq: Record<string, number> = {};
  for (const w of processed) {
    const key = w.toLowerCase();
    freq[key] = (freq[key] || 0) + 1;
  }

  const sorted = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);

  return sorted.map(([word]) => {
    const acronym = processed.find(
      (t) => t.toLowerCase() === word && t === t.toUpperCase() && t.length === 2
    );
    return acronym || word;
  });
}

/**
 * Sort folders most-specific-first.
 * Mirrors ClassificationService.sortBySpecificity().
 */
function sortBySpecificity(
  folders: string[],
  fingerprints: Record<string, FolderFingerprint>
): string[] {
  return [...folders].sort((a, b) => {
    const fpA = fingerprints[a];
    const fpB = fingerprints[b];

    const topicsA = fpA?.coreTopics?.length || 0;
    const topicsB = fpB?.coreTopics?.length || 0;
    if (topicsA !== topicsB) return topicsB - topicsA;

    const wordsA = a.split(/[\s_-]+/).length;
    const wordsB = b.split(/[\s_-]+/).length;
    if (wordsA !== wordsB) return wordsB - wordsA;

    return b.length - a.length;
  });
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
  if (!globalDomain?.domain) return sanitizeFolderName(aiSuggestedName);

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

function safeRequire(mod: string): any {
  try {
    return require(mod);
  } catch {
    return null;
  }
}

function getFolderActivity(
  folderPath: string
): { lastMs: number; label: string } {
  try {
    const entries = fs
      .readdirSync(folderPath, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith("."));

    if (entries.length === 0) return { lastMs: 0, label: "Empty folder" };

    let maxMtime = 0;
    for (const entry of entries.slice(0, 20)) {
      try {
        const stat = fs.statSync(path.join(folderPath, entry.name));
        if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs;
      } catch {
        continue;
      }
    }

    if (maxMtime === 0) return { lastMs: 0, label: "Unknown" };

    const hours = (Date.now() - maxMtime) / (1000 * 60 * 60);
    const days = hours / 24;

    let label: string;
    if (hours < 24) label = `Active Today (${Math.round(hours)}h ago)`;
    else if (days < 7) label = `Active This Week (${Math.round(days)}d ago)`;
    else if (days < 30) label = `Active This Month (${Math.round(days)}d ago)`;
    else label = `Dormant (${Math.round(days)}d ago)`;

    return { lastMs: maxMtime, label };
  } catch {
    return { lastMs: 0, label: "Unreadable" };
  }
}

function getUserDataPath(): string {
  const appName = "system-janitor";
  switch (process.platform) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", appName);
    case "win32":
      return path.join(
        process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
        appName
      );
    default:
      return path.join(os.homedir(), ".config", appName);
  }
}

// ═══════════════════════════════════════════════════════════════
//  OLLAMA CLIENT
// ═══════════════════════════════════════════════════════════════

function callOllama(
  systemPrompt: string,
  userMessage: string,
  opts?: { temperature?: number; numCtx?: number; timeout?: number }
): Promise<{ content: string; timeMs: number }> {
  const temperature = opts?.temperature ?? 0.1;
  const numCtx = opts?.numCtx ?? 4096;
  const timeout = opts?.timeout ?? REQUEST_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const start = Date.now();
    const messages: { role: string; content: string }[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: userMessage });

    const payload = JSON.stringify({
      model: MODEL_NAME,
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
            resolve({
              content: data.message?.content || "",
              timeMs: Date.now() - start,
            });
          } catch {
            reject(new Error("Failed to parse Ollama response"));
          }
        });
        res.on("error", reject);
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Ollama request timed out after ${timeout}ms`));
    });
    req.write(payload);
    req.end();
  });
}

async function checkOllamaHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: "/",
        method: "GET",
        timeout: 5000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
//  STEP 0: ARCHIVES BAN
// ═══════════════════════════════════════════════════════════════

function stepArchivesBan(
  filePath: string,
  userFolders: string[]
): { activeFolders: string[]; fileRecent: boolean; banned: number } {
  step(0, "ARCHIVES BAN");

  const fileRecent = isFileRecent(filePath);
  const stat = fs.statSync(filePath);
  const created = stat.birthtimeMs || stat.mtimeMs;
  const ageDays = (Date.now() - created) / (1000 * 60 * 60 * 24);

  field("File age", `${Math.round(ageDays)} days`);
  field("Recency window", `${RECENCY_WINDOW_MS / (1000 * 60 * 60 * 24)} days (3 months)`);
  field("File is recent", fileRecent ? `${C.green}YES${C.reset}` : `${C.dim}NO${C.reset}`);

  if (!fileRecent) {
    info("File is older than 3 months — noise folders are allowed.");
    return { activeFolders: userFolders, fileRecent, banned: 0 };
  }

  const activeFolders = userFolders.filter((f) => !isNoiseFolderName(f));
  const banned = userFolders.length - activeFolders.length;

  if (banned > 0) {
    const bannedNames = userFolders.filter((f) => isNoiseFolderName(f));
    warn(
      `${C.bold}${banned} noise folder(s) DISQUALIFIED:${C.reset} ${bannedNames.join(", ")}`
    );
    info("These folders will NOT appear in matching or AI prompts.");
  } else {
    ok("No noise folders to disqualify.");
  }

  return { activeFolders, fileRecent, banned };
}

// ═══════════════════════════════════════════════════════════════
//  STEP 1: CONTEXT LOADING
// ═══════════════════════════════════════════════════════════════

async function stepContextLoading(
  targetDir: string,
  ollamaOk: boolean
): Promise<{ fingerprints: Record<string, FolderFingerprint>; userFolders: string[] }> {
  step(1, "CONTEXT LOADING");
  field("Target directory", targetDir);

  // ── Scan subfolders ──
  let userFolders: string[] = [];
  try {
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    userFolders = entries
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith(".") &&
          !SYSTEM_FOLDERS.has(e.name.toLowerCase())
      )
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  } catch (err) {
    warn(`Failed to scan: ${err}`);
  }

  if (userFolders.length === 0) {
    userFolders = ["Documents", "Images", "Financial"];
    warn("No subfolders found — using defaults: " + userFolders.join(", "));
  } else {
    ok(`Found ${userFolders.length} subfolders`);
  }

  // ── Load alias map ──
  const aliasPath = path.join(targetDir, "alias_map.json");
  let aliasMap: Record<string, string> = {};
  try {
    if (fs.existsSync(aliasPath)) {
      aliasMap = JSON.parse(fs.readFileSync(aliasPath, "utf-8"));
      ok(`Loaded alias_map.json (${Object.keys(aliasMap).length} entries)`);
    } else {
      info("No alias_map.json found");
    }
  } catch {
    warn("alias_map.json exists but is unreadable");
  }

  // ── Load expansion cache ──
  const expansionCachePath = path.join(targetDir, ".folder_expansions.json");
  let expansionCache: Record<string, string[]> = {};
  try {
    if (fs.existsSync(expansionCachePath)) {
      expansionCache = JSON.parse(
        fs.readFileSync(expansionCachePath, "utf-8")
      );
      ok(`Loaded expansion cache (${Object.keys(expansionCache).length} folders cached)`);
    }
  } catch {
    /* no cache */
  }

  // ── Build fingerprints ──
  console.log();
  info("Building folder fingerprints...");
  console.log();

  const fingerprints: Record<string, FolderFingerprint> = {};
  let topicCount = 0;
  let noiseCount = 0;

  for (const folderName of userFolders) {
    const folderPath = path.join(targetDir, folderName);

    // Noise check
    if (isNoiseFolderName(folderName)) {
      noiseCount++;
      fingerprints[folderName] = {
        keywords: [],
        coreTopics: [],
        sampleCount: 0,
        isAIExpanded: false,
        isNoiseFolder: true,
        activityLabel: "N/A",
        lastActivityMs: 0,
      };
      console.log(
        `  ${C.red}\u{1F6AB} ${folderName}${C.reset} ${C.dim}— NOISE FOLDER (excluded from AI matching)${C.reset}`
      );
      continue;
    }

    topicCount++;
    const activity = getFolderActivity(folderPath);

    // Sample files
    let files: string[] = [];
    try {
      const entries = fs.readdirSync(folderPath, { withFileTypes: true });
      files = entries
        .filter((e) => e.isFile() && !e.name.startsWith("."))
        .map((e) => path.join(folderPath, e.name));
    } catch {
      /* empty */
    }

    let keywords: string[] = [];
    let isAIExpanded = false;
    let source = "";

    if (files.length < SAMPLE_FILES_PER_FOLDER) {
      isAIExpanded = true;

      if (expansionCache[folderName]) {
        keywords = expansionCache[folderName];
        source = `AI-expanded (cached, ${files.length} files in folder)`;
      } else if (ollamaOk) {
        try {
          const prompt = `You are a file categorization expert. Generate exactly 10 distinct keywords that define what files belong in a folder named "${folderName}".\n\nRules:\n- Output ONLY a JSON array of 10 lowercase keywords\n- Keywords should be specific, not generic\n- Include synonyms and related concepts\n\nNow generate for "${folderName}":`;
          const { content } = await callOllama("", prompt, {
            temperature: 0.3,
            timeout: 30_000,
          });
          const match = content.match(/\[[\s\S]*?\]/);
          if (match) {
            keywords = JSON.parse(match[0])
              .filter((k: unknown) => typeof k === "string")
              .map((k: string) => k.toLowerCase().trim())
              .slice(0, 10);
          }
          source = `AI-expanded (live Ollama query, ${files.length} files in folder)`;
        } catch {
          source = `Name-derived fallback (Ollama expansion failed, ${files.length} files)`;
        }
      } else {
        source = `Name-derived fallback (Ollama unavailable, ${files.length} files)`;
      }

      if (keywords.length === 0) {
        keywords = folderName
          .replace(/[-_]/g, " ")
          .split(/\s+/)
          .map((t) => t.toLowerCase())
          .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
      } else {
        const nameKw = extractKeywords(folderName.replace(/[-_]/g, " "), 5);
        for (const kw of nameKw) {
          if (!keywords.includes(kw.toLowerCase()) && !keywords.includes(kw)) {
            keywords.push(kw);
          }
        }
      }
    } else {
      const sampled = files.slice(0, SAMPLE_FILES_PER_FOLDER);
      let combined = "";
      for (const fp of sampled) {
        try {
          const ext = path.extname(fp).toLowerCase();
          if (READABLE_EXTENSIONS.has(ext)) {
            const fd = fs.openSync(fp, "r");
            const buffer = Buffer.alloc(MAX_READ_BYTES);
            const bytesRead = fs.readSync(fd, buffer, 0, MAX_READ_BYTES, 0);
            fs.closeSync(fd);
            combined += " " + trimWords(buffer.slice(0, bytesRead).toString("utf-8"), WORDS_PER_SAMPLE);
          }
        } catch {
          /* unreadable */
        }
      }
      keywords = extractKeywords(combined, TOP_KEYWORDS);
      source = `File-sampled (${sampled.length} files read)`;
    }

    const coreTopics = aliasMap[folderName]
      ? aliasMap[folderName].split(",").map((t) => t.trim()).filter((t) => t.length > 0)
      : [];

    fingerprints[folderName] = {
      keywords,
      coreTopics,
      sampleCount: files.length,
      isAIExpanded,
      isNoiseFolder: false,
      activityLabel: activity.label,
      lastActivityMs: activity.lastMs,
    };

    const themeStr = coreTopics.length > 0
      ? `${coreTopics.join(", ")} (${activity.label})`
      : activity.label;

    console.log(`  ${C.bold}\u{1F4C1} ${folderName}${C.reset}`);
    indent(`${C.dim}Source:${C.reset} ${source}`);
    indent(
      `${C.dim}Keywords:${C.reset} [${keywords.slice(0, 8).join(", ")}${keywords.length > 8 ? ", ..." : ""}]`
    );
    if (coreTopics.length > 0) {
      indent(`${C.yellow}\u2B50 Core Topics:${C.reset} ${coreTopics.join(", ")}`);
    }
    indent(`${C.dim}Activity:${C.reset} ${activity.label}`);
    if (coreTopics.length > 0) {
      ok(`Loaded '${folderName}' -> Theme: '${themeStr}'`);
    }
    console.log();
  }

  // ── Specificity sort preview ──
  const topicFolders = userFolders.filter((f) => !isNoiseFolderName(f));
  const sorted = sortBySpecificity(topicFolders, fingerprints);
  info(`${C.bold}Specificity order (most specific first):${C.reset}`);
  for (let i = 0; i < Math.min(sorted.length, 10); i++) {
    const f = sorted[i];
    const fp = fingerprints[f];
    const topics = fp?.coreTopics?.length || 0;
    const nameWords = f.split(/[\s_-]+/).length;
    indent(
      `${C.dim}${i + 1}.${C.reset} ${f} ${C.dim}(${nameWords} word${nameWords > 1 ? "s" : ""}, ${topics} topic${topics > 1 ? "s" : ""})${C.reset}`
    );
  }
  if (sorted.length > 10) indent(`${C.dim}... and ${sorted.length - 10} more${C.reset}`);

  console.log();
  console.log(
    `  ${C.bold}Summary:${C.reset} ${topicCount} topic folder${topicCount !== 1 ? "s" : ""} loaded, ${noiseCount} noise folder${noiseCount !== 1 ? "s" : ""} excluded`
  );

  return { fingerprints, userFolders };
}

// ═══════════════════════════════════════════════════════════════
//  STEP 2: TEXT EXTRACTION
// ═══════════════════════════════════════════════════════════════

async function stepTextExtraction(filePath: string): Promise<ExtractionTrace> {
  step(2, "TEXT EXTRACTION");

  const filename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);

  field("File", filename);
  field("Extension", ext || "(none)");
  field("Size", `${(stat.size / 1024).toFixed(1)} KB (${stat.size.toLocaleString()} bytes)`);
  field("Modified", stat.mtime.toISOString().replace("T", " ").slice(0, 19));

  const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
  const ageDays = ageHours / 24;
  let ageLabel: string;
  if (ageHours < 24) ageLabel = `${Math.round(ageHours)}h ago (today)`;
  else if (ageDays < 7) ageLabel = `${Math.round(ageDays)}d ago (this week)`;
  else ageLabel = `${Math.round(ageDays)}d ago`;
  field("File Age", ageLabel);

  console.log();

  let text = "";
  let strategy = "unknown";
  let ocrUsed = false;

  // ── Image → direct OCR ──
  if (IMAGE_EXTENSIONS.has(ext)) {
    strategy = "image-ocr";
    ocrUsed = true;
    info("Image file detected — using Tesseract.js OCR");
    const tesseract = safeRequire("tesseract.js");
    if (tesseract) {
      try {
        const worker = await tesseract.createWorker("eng", undefined, {
          logger: () => {},
        });
        const result = await worker.recognize(filePath);
        text = result.data.text || "";
        await worker.terminate();
        ok(`OCR extracted ${wordCount(text)} words`);
      } catch (err: any) {
        warn(`Tesseract.js failed: ${err.message || err}`);
      }
    } else {
      warn("tesseract.js not installed — cannot OCR images");
    }
  }

  // ── Native text files ──
  else if (TEXT_EXTENSIONS.has(ext)) {
    strategy = "native-text";
    info("Text file — direct UTF-8 read");
    try {
      const fd = fs.openSync(filePath, "r");
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, MAX_READ_BYTES, 0);
      fs.closeSync(fd);
      let raw = buffer.slice(0, bytesRead).toString("utf-8");
      if ([".html", ".htm", ".xml", ".svg", ".vue", ".svelte"].includes(ext)) {
        raw = stripTags(raw);
      }
      text = raw;
      ok(`Read ${wordCount(text)} words (${bytesRead} bytes)`);
    } catch (err: any) {
      warn(`Read failed: ${err.message || err}`);
    }
  }

  // ── PDF cascade ──
  else if (PDF_EXTENSIONS.has(ext)) {
    info("PDF file — running extraction cascade");

    const pdfParse = safeRequire("pdf-parse");
    if (pdfParse) {
      try {
        info("Trying pdf-parse (native digital extraction)...");
        const buffer = fs.readFileSync(filePath);
        const data = await pdfParse(buffer, { max: 10 });
        text = data.text || "";
        strategy = "pdf-parse";
        ok(`pdf-parse extracted ${wordCount(text)} words`);
      } catch (err: any) {
        warn(`pdf-parse failed: ${err.message || err}`);
      }
    } else {
      warn("pdf-parse not installed");
    }

    if (text.trim().length < OCR_THRESHOLD) {
      info(`Native gave <${OCR_THRESHOLD} chars (got ${text.trim().length}) — triggering OCR fallback`);
      ocrUsed = true;
      strategy = "pdf-ocr";

      const pdf2img = safeRequire("pdf-img-convert");
      const tesseract = safeRequire("tesseract.js");

      if (pdf2img && tesseract) {
        try {
          info("Converting PDF page 1 to image (pdf-img-convert)...");
          const images = await pdf2img.convert(filePath, {
            page_numbers: [1],
            base64: true,
            scale: 2.0,
          });

          if (images.length > 0) {
            info("Running Tesseract.js OCR on page image...");
            const worker = await tesseract.createWorker("eng", undefined, {
              logger: () => {},
            });
            const result = await worker.recognize(
              Buffer.from(images[0] as string, "base64")
            );
            const ocrText = result.data.text || "";
            await worker.terminate();

            if (ocrText.trim().length > text.trim().length) {
              text = ocrText;
              ok(`OCR extracted ${wordCount(ocrText)} words`);
            } else {
              warn("OCR gave less text than native — keeping native result");
            }
          }
        } catch (err: any) {
          warn(`OCR cascade failed: ${err.message || err}`);
        }
      } else {
        if (!pdf2img) warn("pdf-img-convert not installed");
        if (!tesseract) warn("tesseract.js not installed");
      }

      if (text.trim().length < OCR_THRESHOLD) {
        info("Attempting raw binary string extraction (last resort)...");
        strategy = "pdf-raw-grep";
        try {
          const raw = fs.readFileSync(filePath, "latin1").slice(0, 200_000);
          const matches: string[] = [];
          const re = /\(([^)]{2,})\)/g;
          let m;
          while ((m = re.exec(raw)) !== null) {
            const c = m[1]
              .replace(/\\n/g, " ")
              .replace(/\\r/g, "")
              .replace(/\\\(/g, "(")
              .replace(/\\\)/g, ")");
            if (/[a-zA-Z]/.test(c) && c.length > 3) matches.push(c);
          }
          const rawText = matches.join(" ");
          if (rawText.length > text.trim().length) {
            text = rawText;
            ok(`Raw grep extracted ${wordCount(rawText)} words`);
          }
        } catch {
          warn("Raw binary extraction failed");
        }
      }
    }
  }

  // ── DOCX ──
  else if (DOCX_EXTENSIONS.has(ext)) {
    info("DOCX file — trying mammoth");
    const mammoth = safeRequire("mammoth");
    if (mammoth) {
      try {
        const result = await mammoth.extractRawText({ path: filePath });
        text = result.value || "";
        strategy = "mammoth";
        ok(`mammoth extracted ${wordCount(text)} words`);
      } catch (err: any) {
        warn(`mammoth failed: ${err.message || err}`);
      }
    }
    if (!text) {
      info("Falling back to adm-zip XML extraction");
      const AdmZip = safeRequire("adm-zip");
      if (AdmZip) {
        try {
          const zip = new AdmZip(filePath);
          const entry = zip.getEntry("word/document.xml");
          if (entry) {
            text = stripTags(entry.getData().toString("utf-8"));
            strategy = "zip-docx";
            ok(`ZIP fallback extracted ${wordCount(text)} words`);
          }
        } catch {
          warn("ZIP extraction failed");
        }
      }
    }
  }

  // ── Other Office ──
  else if (OFFICE_EXTENSIONS.has(ext)) {
    strategy = "zip-office";
    info(`Office file (${ext}) — ZIP-based extraction`);
    const AdmZip = safeRequire("adm-zip");
    if (AdmZip) {
      try {
        const zip = new AdmZip(filePath);
        if (ext === ".pptx" || ext === ".ppt") {
          const slideTexts: string[] = [];
          for (const entry of zip.getEntries()) {
            if (entry.entryName.match(/^ppt\/slides\/slide\d+\.xml$/)) {
              slideTexts.push(stripTags(entry.getData().toString("utf-8")));
            }
          }
          text = slideTexts.join(" ");
        } else if (ext === ".xlsx" || ext === ".xls") {
          const entry = zip.getEntry("xl/sharedStrings.xml");
          if (entry) text = stripTags(entry.getData().toString("utf-8"));
        } else if ([".odt", ".odp", ".ods"].includes(ext)) {
          const entry = zip.getEntry("content.xml");
          if (entry) text = stripTags(entry.getData().toString("utf-8"));
        }
        if (text) ok(`Extracted ${wordCount(text)} words`);
      } catch {
        warn("ZIP extraction failed");
      }
    }
  }

  // ── Unknown ──
  else {
    warn(`Unknown extension "${ext}" — no extraction strategy available`);
  }

  text = cleanOutput(text);
  const wc = wordCount(text);

  console.log();
  field("Extraction Strategy", strategy);
  field("Universal OCR Fallback Used", ocrUsed ? `${C.yellow}Yes${C.reset}` : "No");
  field("Words Extracted", `${wc}`);

  if (wc > 0) {
    console.log();
    info("First 80 words:");
    const preview = text.split(/\s+/).slice(0, 80).join(" ");
    console.log(`    ${C.dim}"${preview}..."${C.reset}`);
  } else {
    warn("No text could be extracted — AI will classify by filename only");
  }

  return {
    text,
    wordCount: wc,
    strategy,
    ocrUsed,
    fileSizeBytes: stat.size,
    fileModified: stat.mtime,
  };
}

// ═══════════════════════════════════════════════════════════════
//  RAW VISION — Forensic text extraction analysis
// ═══════════════════════════════════════════════════════════════

/**
 * Print a forensic dump of the raw extracted text so the user can
 * see exactly what the engine is working with — whitespace, ordering,
 * garbled characters, footer-before-header problems, etc.
 */
function stepRawVision(
  fileContent: string,
  fingerprints: Record<string, FolderFingerprint>,
  activeFolders: string[]
): void {
  step("X", "RAW VISION — Forensic Text Analysis");

  const RAW_VISION_CHARS = 1000;

  // ── 1. Raw Header Dump ──────────────────────────────────────

  info(`${C.bold}1. Raw Extracted Text (first ${RAW_VISION_CHARS} chars)${C.reset}`);
  console.log();

  if (!fileContent || fileContent.trim().length === 0) {
    warn("NO TEXT EXTRACTED. The file produced zero readable content.");
    warn("Header Authority and Bullseye will both fail — classification falls through to AI.");
    return;
  }

  const rawSlice = fileContent.slice(0, RAW_VISION_CHARS);

  // Make whitespace visible
  const visible = rawSlice
    .replace(/\r\n/g, `${C.red}[CRLF]${C.reset}\n`)
    .replace(/\r/g, `${C.red}[CR]${C.reset}\n`)
    .replace(/\n/g, `${C.yellow}[NEWLINE]${C.reset}\n`)
    .replace(/\t/g, `${C.cyan}[TAB]${C.reset}`)
    .replace(/\f/g, `${C.red}[FORMFEED]${C.reset}`);

  // Print with a left gutter showing character offsets
  const visibleLines = visible.split("\n");
  let charOffset = 0;
  for (const line of visibleLines) {
    // Strip ANSI to count real chars for offset
    const plainLine = line.replace(/\x1b\[[0-9;]*m/g, "");
    const offsetStr = String(charOffset).padStart(5);
    console.log(`  ${C.dim}${offsetStr}|${C.reset} ${line}`);
    // +1 for the newline that was consumed by split
    charOffset += plainLine.length + 1;
  }

  if (fileContent.length > RAW_VISION_CHARS) {
    console.log(`  ${C.dim}  ...${C.reset} (${fileContent.length - RAW_VISION_CHARS} more chars)`);
  }

  field("Total extracted length", `${fileContent.length} chars / ${wordCount(fileContent)} words`);

  // ── 2. Header Zone Token Stream ─────────────────────────────

  console.log();
  info(`${C.bold}2. Header Zone Token Stream (first ${HEADER_ZONE_CHARS} chars → tokenize())${C.reset}`);
  console.log();

  const headerZone = fileContent.slice(0, HEADER_ZONE_CHARS);
  const headerTokens = tokenize(headerZone);
  const tokenArr = [...headerTokens];

  // Print all tokens, not just a truncated preview
  const tokenLine = tokenArr.map((t) => `"${t}"`).join(", ");
  console.log(`  ${C.cyan}[${tokenLine}]${C.reset}`);
  field("Token count", `${tokenArr.length}`);

  // ── 3. Hit Locations — folder name search in raw text ───────

  console.log();
  info(`${C.bold}3. Folder Name Hit Locations (substring search in raw text)${C.reset}`);
  console.log();

  const nonNoiseFolders = activeFolders.filter(
    (f) => !fingerprints[f]?.isNoiseFolder
  );

  let anyHit = false;

  for (const folder of nonNoiseFolders) {
    const fp = fingerprints[folder];
    if (!fp) continue;

    // Gather all search terms: the folder name itself + its core topics
    const searchTerms: string[] = [folder];
    for (const topic of fp.coreTopics) {
      searchTerms.push(topic);
    }

    for (const term of searchTerms) {
      const lowerContent = fileContent.toLowerCase();
      const lowerTerm = term.toLowerCase();

      // Find ALL occurrences
      const positions: number[] = [];
      let pos = lowerContent.indexOf(lowerTerm);
      while (pos !== -1) {
        positions.push(pos);
        pos = lowerContent.indexOf(lowerTerm, pos + 1);
      }

      if (positions.length > 0) {
        anyHit = true;
        const inHeader = positions.some((p) => p < HEADER_ZONE_CHARS);
        const zone = inHeader
          ? `${C.green}HEADER ZONE${C.reset}`
          : `${C.yellow}BODY ONLY${C.reset}`;

        // Show context around each hit
        for (const p of positions) {
          const contextStart = Math.max(0, p - 20);
          const contextEnd = Math.min(fileContent.length, p + term.length + 20);
          const before = fileContent.slice(contextStart, p).replace(/\n/g, " ");
          const match = fileContent.slice(p, p + term.length);
          const after = fileContent
            .slice(p + term.length, contextEnd)
            .replace(/\n/g, " ");

          const isLabel = term === folder ? "FOLDER" : "TOPIC";
          const zoneLabel = p < HEADER_ZONE_CHARS ? "header" : "body";

          indent(
            `${C.green}\u2713${C.reset} ${isLabel} "${C.bold}${term}${C.reset}" ` +
            `found at char ${C.bold}${p}${C.reset} (${zoneLabel}) ` +
            `${zone}`
          );
          indent(
            `  ${C.dim}...${before}${C.reset}${C.bgYellow}${C.bold}${match}${C.reset}${C.dim}${after}...${C.reset}`
          );
        }
      }
    }
  }

  if (!anyHit) {
    warn(
      "NO folder names or Core Topics found anywhere in the extracted text."
    );
    warn(
      "This means Bullseye and Header Authority will BOTH miss. " +
      "Check if the PDF parser is garbling the text."
    );
  }

  // ── 4. Quick diagnostic checks ──────────────────────────────

  console.log();
  info(`${C.bold}4. Diagnostic Checks${C.reset}`);

  // Check for common PDF garbling patterns
  const firstLine = fileContent.split(/\n/)[0] || "";
  field("First line", `"${firstLine.slice(0, 120)}${firstLine.length > 120 ? "..." : ""}"`);

  // Check if first line looks like a footer/page number
  const footerPatterns = /^(page\s*\d|^\d+$|\d+\s*of\s*\d+|©|copyright)/i;
  if (footerPatterns.test(firstLine.trim())) {
    warn(
      `${C.red}FOOTER DETECTED AT TOP:${C.reset} The first line looks like a page footer/number. ` +
      `The PDF parser may be reading footer text before header text.`
    );
  }

  // Check for dots/periods breaking acronyms: "A.P." vs "AP"
  const dotAcronyms = fileContent.slice(0, HEADER_ZONE_CHARS).match(/[A-Z]\.[A-Z]\.?/g);
  if (dotAcronyms && dotAcronyms.length > 0) {
    warn(
      `${C.yellow}DOTTED ACRONYMS DETECTED:${C.reset} [${dotAcronyms.join(", ")}] — ` +
      `these will NOT match "AP", "US", etc. in the tokenizer.`
    );
  }

  // Check for excessive special characters (garbled extraction)
  const headerSlice = fileContent.slice(0, 500);
  const specialCount = (headerSlice.match(/[^\w\s.,;:!?'"()\-\/]/g) || []).length;
  const specialPct = Math.round((specialCount / Math.max(headerSlice.length, 1)) * 100);
  if (specialPct > 15) {
    warn(
      `${C.red}GARBLED TEXT LIKELY:${C.reset} ${specialPct}% of header chars are special/non-printable. ` +
      `Text extraction may have failed.`
    );
  } else {
    ok(`Header text quality: ${specialPct}% special chars (looks clean)`);
  }

  // Check ordering: is the content we'd expect at the top actually at the top?
  const headerLower = headerSlice.toLowerCase();
  const bodyLower = fileContent.slice(500).toLowerCase();
  const folderInHeader = nonNoiseFolders.filter((f) =>
    headerLower.includes(f.toLowerCase())
  );
  const folderInBodyOnly = nonNoiseFolders.filter(
    (f) =>
      bodyLower.includes(f.toLowerCase()) &&
      !headerLower.includes(f.toLowerCase())
  );

  if (folderInHeader.length > 0) {
    ok(`Folders in header zone: ${folderInHeader.join(", ")}`);
  }
  if (folderInBodyOnly.length > 0) {
    info(`Folders in body only (not header): ${folderInBodyOnly.join(", ")}`);
  }
  if (folderInHeader.length === 0 && folderInBodyOnly.length > 0) {
    warn(
      `${C.yellow}ORDERING PROBLEM:${C.reset} Folder names appear in the body but NOT in the header. ` +
      `The PDF parser may be reordering text blocks.`
    );
  }
}

// ═══════════════════════════════════════════════════════════════
//  STEP 3: BULLSEYE CHECK (zero AI, 100% confidence)
// ═══════════════════════════════════════════════════════════════

function stepBullseyeCheck(
  filename: string,
  fileContent: string,
  fingerprints: Record<string, FolderFingerprint>,
  activeFolders: string[]
): ClassificationResult | null {
  step(3, "BULLSEYE CHECK (Header Authority + Token Match)");

  interface Hit {
    folder: string;
    matched: number;
    total: number;
    via: string;
  }

  const nonNoiseFolders = activeFolders.filter(
    (f) => !fingerprints[f]?.isNoiseFolder
  );

  // Shared: scan a token set against all active folders
  function collectHits(tokens: Set<string>, viaPrefix: string): Hit[] {
    const found: Hit[] = [];
    for (const folder of nonNoiseFolders) {
      const fp = fingerprints[folder];
      if (!fp) continue;

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
          continue;
        }
      }

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

  function pickBest(hits: Hit[]): Hit {
    hits.sort((a, b) => {
      if (a.matched !== b.matched) return b.matched - a.matched;
      return b.folder.length - a.folder.length;
    });
    return hits[0];
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase A — HEADER AUTHORITY (first 500 chars)
  // ═══════════════════════════════════════════════════════════

  const headerZone = fileContent
    ? fileContent.slice(0, HEADER_ZONE_CHARS)
    : "";

  info(`${C.bold}Phase A — HEADER AUTHORITY${C.reset} (first ${HEADER_ZONE_CHARS} chars)`);

  if (headerZone) {
    const headerTokens = tokenize(headerZone);
    field(
      "Header tokens",
      `[${[...headerTokens].slice(0, 12).join(", ")}${headerTokens.size > 12 ? ", ..." : ""}]`
    );

    const headerHits = collectHits(headerTokens, "HEADER ");

    for (const h of headerHits) {
      indent(
        `${C.green}\u2713 ${h.folder}${C.reset} — matched in header via ${h.via}`
      );
    }

    if (headerHits.length > 0) {
      const best = pickBest(headerHits);
      const reasoning =
        `HEADER AUTHORITY: "${best.folder}" matched via ${best.via} ` +
        `(${best.matched}/${best.total} words). Header overrides body.`;

      console.log();
      ok(
        `${C.bold}${C.bgGreen}${C.white} HEADER AUTHORITY HIT ${C.reset} → ` +
        `"${C.bold}${best.folder}${C.reset}" at ${C.green}100%${C.reset} confidence`
      );
      info("Header match wins — body content is irrelevant.");

      if (headerHits.length > 1) {
        console.log();
        info("Other header hits (not used):");
        for (const h of headerHits.slice(1)) {
          indent(`${C.dim}${h.folder} via ${h.via}${C.reset}`);
        }
      }

      return {
        category: best.folder,
        confidence: 100,
        reasoning,
        isNewFolder: false,
        detected_concepts: [],
        concept_abstraction: `Header Zone match — ${best.via}`,
        requires_review: false,
        was_noise_penalized: false,
        global_domain: "",
        global_subdomain: "",
        suggested_path: "",
        match_level: "bullseye",
      };
    }

    info("No folder name found in header zone.");
  } else {
    info("No file content available — skipping header check.");
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase B — STANDARD BULLSEYE (filename + first 100 words)
  // ═══════════════════════════════════════════════════════════

  console.log();
  info(`${C.bold}Phase B — STANDARD BULLSEYE${C.reset} (filename + first ${BULLSEYE_CONTENT_WORDS} words)`);

  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent
    ? fileContent.split(/\s+/).slice(0, BULLSEYE_CONTENT_WORDS).join(" ")
    : "";
  const tokens = tokenize(nameNoExt + " " + contentHead);

  field("Filename (no ext)", nameNoExt);
  field(
    "Token set",
    `[${[...tokens].slice(0, 15).join(", ")}${tokens.size > 15 ? ", ..." : ""}]`
  );
  field("Token count", `${tokens.size}`);

  console.log();

  const hits = collectHits(tokens, "");

  for (const h of hits) {
    indent(
      `${C.green}\u2713 ${h.folder}${C.reset} — ${h.via}`
    );
  }

  console.log();

  if (hits.length === 0) {
    warn("No Bullseye hit. Proceeding to AI classification...");
    return null;
  }

  const best = pickBest(hits);
  const reasoning =
    `BULLSEYE: "${best.folder}" matched via ${best.via} ` +
    `(${best.matched}/${best.total} words).`;

  ok(
    `${C.bold}${C.bgGreen}${C.white} BULLSEYE HIT ${C.reset} → ` +
    `"${C.bold}${best.folder}${C.reset}" at ${C.green}100%${C.reset} confidence`
  );
  info(`Via: ${best.via}`);

  if (hits.length > 1) {
    console.log();
    info("Other potential hits (not used):");
    for (const h of hits.slice(1)) {
      indent(`${C.dim}${h.folder} via ${h.via} (${h.matched}/${h.total})${C.reset}`);
    }
  }

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

// ═══════════════════════════════════════════════════════════════
//  STEP 4: LEARNING MEMORY
// ═══════════════════════════════════════════════════════════════

interface Correction {
  filename: string;
  extension: string;
  ai_guess: string;
  ai_confidence: number;
  user_correction: string;
  timestamp: number;
}

function stepLearningMemory(fileExt: string): string {
  step(4, "LEARNING MEMORY");

  const memoryPath = path.join(getUserDataPath(), "user_memory.json");
  field("Memory file", memoryPath);

  let corrections: Correction[] = [];
  try {
    if (fs.existsSync(memoryPath)) {
      const raw = JSON.parse(fs.readFileSync(memoryPath, "utf-8"));
      corrections = raw.correction_history || [];
      ok(`Loaded ${corrections.length} past corrections`);
    } else {
      info("No user_memory.json found — no learning history yet");
      return "";
    }
  } catch {
    warn("user_memory.json unreadable");
    return "";
  }

  if (corrections.length === 0) {
    info("Correction history is empty");
    return "";
  }

  const MAX_PROMPT_EXAMPLES = 10;
  const extMatches: Correction[] = [];
  const general: Correction[] = [];

  for (let i = corrections.length - 1; i >= 0; i--) {
    const c = corrections[i];
    if (fileExt && c.extension?.toLowerCase() === fileExt.toLowerCase()) {
      extMatches.push(c);
    } else {
      general.push(c);
    }
  }

  const halfMax = Math.ceil(MAX_PROMPT_EXAMPLES / 2);
  const selected = extMatches.slice(0, halfMax);
  const remaining = MAX_PROMPT_EXAMPLES - selected.length;
  selected.push(...general.slice(0, remaining));

  field("Extension-matched corrections", `${extMatches.length} (${fileExt})`);
  field("Injected into prompt", `${selected.length}`);

  if (selected.length > 0) {
    console.log();
    info("Injected examples:");
    for (const c of selected.slice(0, 5)) {
      indent(
        `${C.dim}-${C.reset} "${c.filename}" \u2192 "${C.green}${c.user_correction}${C.reset}" ${C.dim}(AI guessed "${c.ai_guess}")${C.reset}`
      );
    }
    if (selected.length > 5) {
      indent(`${C.dim}... and ${selected.length - 5} more${C.reset}`);
    }
  }

  const lines = [
    "Here are examples of how this user likes their files organized:",
  ];
  for (const c of selected) {
    lines.push(
      `  - "${c.filename}" should go to "${c.user_correction}" (AI guessed "${c.ai_guess}" \u2014 user corrected it)`
    );
  }
  lines.push("");
  lines.push(
    "Learn from these corrections. The user's preference overrides your default logic."
  );

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════
//  STEP 5: GLOBAL DOMAIN CLASSIFICATION
// ═══════════════════════════════════════════════════════════════

async function stepGlobalDomain(
  filename: string,
  extension: string,
  fileContent: string
): Promise<GlobalDomainResult | null> {
  step(5, "GLOBAL DOMAIN CLASSIFICATION");

  const domainList = Object.entries(GLOBAL_DOMAINS)
    .map(([name, cfg]) => `- ${name}: ${cfg.examples}`)
    .join("\n");

  const contentPreview = fileContent
    ? fileContent.split(/\s+/).slice(0, DOMAIN_CLASSIFIER_WORDS).join(" ")
    : "";

  info(`Classifying into one of ${Object.keys(GLOBAL_DOMAINS).length} global domains...`);
  field("Domains", Object.keys(GLOBAL_DOMAINS).join(", "));
  field("Content preview", `${contentPreview ? wordCount(contentPreview) + " words" : "none (filename only)"}`);

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

  console.log();
  info(`${C.bold}Calling Ollama${C.reset} (Global Domain classifier)...`);

  try {
    const { content: raw, timeMs } = await callOllama("", prompt, {
      numCtx: 2048,
      timeout: 30_000,
    });

    ok(`Response in ${(timeMs / 1000).toFixed(1)}s`);

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
      console.log();
      field("Domain", `${C.bold}${domain}${C.reset}`);
      field("Subdomain", `${C.bold}${subdomain}${C.reset}`);
      field("Confidence", `${confidence}%`);

      const isActive = confidence >= DOMAIN_CONFIDENCE_THRESHOLD;
      field(
        "Domain-aware mode",
        isActive
          ? `${C.green}ACTIVE${C.reset} (${confidence}% >= ${DOMAIN_CONFIDENCE_THRESHOLD}%)`
          : `${C.dim}INACTIVE${C.reset} (${confidence}% < ${DOMAIN_CONFIDENCE_THRESHOLD}%)`
      );

      return { domain, subdomain, confidence };
    }

    warn(`Unrecognised domain "${rawDomain}" — domain routing disabled`);
    return null;
  } catch (err) {
    warn(`Global domain call failed: ${err}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  STEP 6: SPECIFIC MATCH (domain-aware AI chain-of-thought)
// ═══════════════════════════════════════════════════════════════

function buildDomainAwareSystemPrompt(
  fingerprints: Record<string, FolderFingerprint>,
  learningBlock: string,
  globalDomain: GlobalDomainResult | null,
  activeFolders: string[]
): string {
  const domainActive =
    globalDomain !== null &&
    globalDomain.confidence >= DOMAIN_CONFIDENCE_THRESHOLD;

  // Sort by specificity for the folder list
  const sorted = sortBySpecificity(activeFolders, fingerprints);

  const folderDescriptions: string[] = [];
  let folderCount = 0;

  for (const folderName of sorted) {
    const fp = fingerprints[folderName];
    if (!fp || fp.isNoiseFolder) continue;

    folderCount++;
    const lines: string[] = [`  \u{1F4C1} ${folderName}`];
    lines.push(`     Keywords: [${fp.keywords.join(", ")}]`);
    if (fp.coreTopics.length > 0) {
      lines.push(`     \u2B50 Core Topics: ${fp.coreTopics.join(", ")}`);
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
      '- When isNewFolder is true, also provide suggested_path in "Parent/Child" format',
      '  (e.g., "School/APUSH", "Finance/Taxes", "Work/Reports").',
      "──────────────────────────────────────────────────────────────",
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
    "  \u2B50 Core Topics take PRIORITY — if a folder has Core Topics that match, it wins.",
    "  Look for SEMANTIC PROXIMITY, not just exact word matches.",
    "  CHECK THE MOST SPECIFIC FOLDERS FIRST — a precise match beats a vague one.",
    "",
    "STEP 4 — MATCH:",
    "  Pick the SINGLE folder whose domain best matches the document.",
    "  If NO existing folder covers this domain, suggest a new folder name (1-2 words).",
  );

  if (domainActive) {
    parts.push(
      "",
      "STEP 5 — HIERARCHY (only when isNewFolder is true):",
      '  Suggest a hierarchical path in "Parent/Child" format.',
      "  If an existing folder could serve as the parent, USE IT.",
      '  Otherwise suggest a logical parent (e.g., "School", "Finance", "Work").',
    );
  }

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
    '- suggested_path: When isNewFolder is true, provide "Parent/Child" path. Otherwise "".',
    "- User's past corrections ALWAYS override your analysis.",
    "- Prefer EXISTING folders. Only suggest new ones for genuinely novel domains.",
    "- \u2B50 Core Topics are AUTHORITATIVE — trust them over auto-detected keywords.",
  );

  return parts.join("\n");
}

function buildUserMessage(
  filename: string,
  ext: string,
  fileContent: string
): string {
  const lines: string[] = ["Classify this file.", "", `Filename: ${filename}`];
  if (ext) lines.push(`Type: ${ext}`);

  if (fileContent) {
    const wc = wordCount(fileContent);
    lines.push("", `FILE CONTENT (${wc} words):`, fileContent);
  } else {
    lines.push(
      "",
      "No readable content available. Classify based on the filename, file type,",
      "and the folder fingerprints only."
    );
  }

  return lines.join("\n");
}

async function stepSpecificMatch(
  filePath: string,
  extraction: ExtractionTrace,
  fingerprints: Record<string, FolderFingerprint>,
  activeFolders: string[],
  learningBlock: string,
  globalDomain: GlobalDomainResult | null
): Promise<{
  result: ClassificationResult;
  rawResponse: string;
  responseTimeMs: number;
  systemPrompt: string;
  userMessage: string;
  parsedJSON: any;
}> {
  step(6, "SPECIFIC MATCH (Domain-Aware AI)");

  const filename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const domainActive =
    globalDomain !== null &&
    globalDomain.confidence >= DOMAIN_CONFIDENCE_THRESHOLD;

  const systemPrompt = buildDomainAwareSystemPrompt(
    fingerprints,
    learningBlock,
    globalDomain,
    activeFolders
  );
  const userMessage = buildUserMessage(filename, ext, extraction.text);

  field("System prompt length", `${systemPrompt.length} chars`);
  field("User message length", `${userMessage.length} chars`);
  field("Domain-aware mode", domainActive ? `${C.green}ACTIVE${C.reset}` : `${C.dim}INACTIVE${C.reset}`);
  field(
    "Total prompt",
    `~${Math.round((systemPrompt.length + userMessage.length) / 4)} tokens (est.)`
  );

  console.log();
  info(`${C.bold}Calling Ollama${C.reset} (${MODEL_NAME} — Specific Match)...`);

  let rawResponse = "";
  let responseTimeMs = 0;

  try {
    const resp = await callOllama(systemPrompt, userMessage);
    rawResponse = resp.content;
    responseTimeMs = resp.timeMs;
    ok(`Response received in ${(responseTimeMs / 1000).toFixed(1)}s`);
  } catch (err: any) {
    warn(`Ollama call FAILED: ${err.message || err}`);
    return {
      result: {
        category: "Documents",
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
      },
      rawResponse: "",
      responseTimeMs: 0,
      systemPrompt,
      userMessage,
      parsedJSON: null,
    };
  }

  // ── Print raw Chain of Thought ──
  console.log();
  info(`${C.bold}Raw AI Chain-of-Thought:${C.reset}`);
  console.log(`${C.dim}${"- ".repeat(31)}${C.reset}`);
  console.log(`${C.cyan}${rawResponse}${C.reset}`);
  console.log(`${C.dim}${"- ".repeat(31)}${C.reset}`);

  // ── Parse response (mirrors ClassificationService.parseResponse) ──
  const sortedFolders = sortBySpecificity(activeFolders, fingerprints);
  let parsed: any = null;

  let cleaned = rawResponse.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) cleaned = jsonMatch[0];

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    warn("Could not parse AI response as JSON");
  }

  const gd = globalDomain?.domain || "";
  const gs = globalDomain?.subdomain || "";

  let result: ClassificationResult;

  if (parsed) {
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

    const folderName = String(parsed.best_fit_folder || parsed.category || "").trim();

    // ── Display parsed fields ──
    console.log();
    info(`${C.bold}Concept Abstraction:${C.reset}`);
    indent(
      conceptAbstraction
        ? `"${C.magenta}${conceptAbstraction}${C.reset}"`
        : `${C.dim}(none provided)${C.reset}`
    );

    console.log();
    info(`${C.bold}Detected Concepts:${C.reset}`);
    for (const concept of detectedConcepts) {
      indent(`${C.yellow}\u2022${C.reset} ${concept}`);
    }
    if (detectedConcepts.length === 0) indent(`${C.dim}(none)${C.reset}`);

    console.log();
    info(`${C.bold}AI Pick:${C.reset} "${folderName}" (confidence: ${confidence}%)`);

    // ── Domain-aware noise rejection ──
    if (folderName && isNoiseFolderName(folderName) && domainActive) {
      const sugName = globalDomain!.subdomain || folderName;
      const sugPath = aiSuggestedPath || buildSuggestedPath(globalDomain, sortedFolders, sugName);
      const leaf = sugPath.includes("/")
        ? sanitizeFolderName(sugPath.split("/").pop()!)
        : sanitizeFolderName(sugName);

      warn(
        `${C.bold}DOMAIN OVERRIDE:${C.reset} "${folderName}" is a noise folder → rejected`
      );
      info(`Redirected to: "${sugPath}" (leaf: "${leaf}")`);

      result = {
        category: leaf,
        confidence: Math.max(confidence - NOISE_FOLDER_PENALTY, 0),
        reasoning: reasoning + ` [Domain router overrode noise folder "${folderName}"]`,
        isNewFolder: true,
        detected_concepts: detectedConcepts,
        concept_abstraction: conceptAbstraction,
        requires_review: true,
        was_noise_penalized: true,
        global_domain: gd,
        global_subdomain: gs,
        suggested_path: sugPath,
        match_level: "specific",
      };
    }
    // ── Legacy noise penalty ──
    else if (folderName && isNoiseFolderName(folderName)) {
      confidence = Math.max(0, confidence - NOISE_FOLDER_PENALTY);
      wasNoisePenalized = true;
      warn(`NOISE PENALTY: "${folderName}" -${NOISE_FOLDER_PENALTY}%`);

      result = {
        category: folderName,
        confidence,
        reasoning,
        isNewFolder,
        detected_concepts: detectedConcepts,
        concept_abstraction: conceptAbstraction,
        requires_review: confidence < REVIEW_THRESHOLD,
        was_noise_penalized: true,
        global_domain: gd,
        global_subdomain: gs,
        suggested_path: aiSuggestedPath,
        match_level: "specific",
      };
    }
    // ── New folder suggestion ──
    else if (isNewFolder) {
      const sugPath = aiSuggestedPath ||
        (domainActive ? buildSuggestedPath(globalDomain, sortedFolders, folderName) : "");
      const leaf = sugPath.includes("/")
        ? sanitizeFolderName(sugPath.split("/").pop()!)
        : sanitizeFolderName(folderName);

      info(`New folder suggested: "${leaf}" (path: "${sugPath}")`);

      result = {
        category: leaf || "Miscellaneous",
        confidence,
        reasoning,
        isNewFolder: true,
        detected_concepts: detectedConcepts,
        concept_abstraction: conceptAbstraction,
        requires_review: confidence < REVIEW_THRESHOLD,
        was_noise_penalized: false,
        global_domain: gd,
        global_subdomain: gs,
        suggested_path: sugPath,
        match_level: "specific",
      };
    }
    // ── Folder matching ──
    else {
      let matchedCategory = folderName;
      let matchType = "exact";

      if (folderName && !sortedFolders.includes(folderName)) {
        const lower = folderName.toLowerCase();
        const ciMatch = sortedFolders.find((f) => f.toLowerCase() === lower);

        if (ciMatch) {
          matchedCategory = ciMatch;
          matchType = "case-insensitive";

          if (isNoiseFolderName(ciMatch) && domainActive) {
            const sugName = globalDomain!.subdomain || folderName;
            const sugPath = buildSuggestedPath(globalDomain, sortedFolders, sugName);
            const leaf = sugPath.includes("/")
              ? sanitizeFolderName(sugPath.split("/").pop()!)
              : sanitizeFolderName(sugName);

            result = {
              category: leaf,
              confidence: Math.max(0, confidence - NOISE_FOLDER_PENALTY),
              reasoning: reasoning + ` [Domain router overrode "${ciMatch}"]`,
              isNewFolder: true,
              detected_concepts: detectedConcepts,
              concept_abstraction: conceptAbstraction,
              requires_review: true,
              was_noise_penalized: true,
              global_domain: gd,
              global_subdomain: gs,
              suggested_path: sugPath,
              match_level: "specific",
            };

            // Jump to return
            return {
              result,
              rawResponse,
              responseTimeMs,
              systemPrompt,
              userMessage,
              parsedJSON: parsed,
            };
          }

          if (isNoiseFolderName(ciMatch)) {
            confidence = Math.max(0, confidence - NOISE_FOLDER_PENALTY);
            wasNoisePenalized = true;
          }
        } else {
          // Partial match (specificity-sorted)
          const partial = sortedFolders.find(
            (f) =>
              f.toLowerCase().includes(lower) ||
              lower.includes(f.toLowerCase())
          );

          if (partial) {
            matchedCategory = partial;
            matchType = "partial";
            confidence = Math.max(confidence - 10, 0);

            if (isNoiseFolderName(partial) && domainActive) {
              const sugName = globalDomain!.subdomain || folderName;
              const sugPath = buildSuggestedPath(globalDomain, sortedFolders, sugName);
              const leaf = sugPath.includes("/")
                ? sanitizeFolderName(sugPath.split("/").pop()!)
                : sanitizeFolderName(sugName);

              result = {
                category: leaf,
                confidence: Math.max(0, confidence - NOISE_FOLDER_PENALTY),
                reasoning: reasoning + ` [Domain router overrode "${partial}"]`,
                isNewFolder: true,
                detected_concepts: detectedConcepts,
                concept_abstraction: conceptAbstraction,
                requires_review: true,
                was_noise_penalized: true,
                global_domain: gd,
                global_subdomain: gs,
                suggested_path: sugPath,
                match_level: "specific",
              };

              return {
                result,
                rawResponse,
                responseTimeMs,
                systemPrompt,
                userMessage,
                parsedJSON: parsed,
              };
            }

            if (isNoiseFolderName(partial)) {
              confidence = Math.max(0, confidence - NOISE_FOLDER_PENALTY);
              wasNoisePenalized = true;
            }
          } else {
            matchType = "unmatched";
            confidence = Math.max(confidence - 20, 0);

            const sugPath = domainActive
              ? buildSuggestedPath(globalDomain, sortedFolders, folderName)
              : "";
            const leaf = sugPath.includes("/")
              ? sanitizeFolderName(sugPath.split("/").pop()!)
              : sanitizeFolderName(folderName);

            result = {
              category: leaf || "Documents",
              confidence,
              reasoning,
              isNewFolder: true,
              detected_concepts: detectedConcepts,
              concept_abstraction: conceptAbstraction,
              requires_review: true,
              was_noise_penalized: false,
              global_domain: gd,
              global_subdomain: gs,
              suggested_path: sugPath,
              match_level: "specific",
            };

            return {
              result,
              rawResponse,
              responseTimeMs,
              systemPrompt,
              userMessage,
              parsedJSON: parsed,
            };
          }
        }
      }

      info(`Folder match type: ${C.bold}${matchType}${C.reset}`);

      result = {
        category: matchedCategory || folderName || "Documents",
        confidence,
        reasoning,
        isNewFolder: false,
        detected_concepts: detectedConcepts,
        concept_abstraction: conceptAbstraction,
        requires_review: confidence < REVIEW_THRESHOLD,
        was_noise_penalized: wasNoisePenalized,
        global_domain: gd,
        global_subdomain: gs,
        suggested_path: "",
        match_level: "specific",
      };
    }
  } else {
    // ── Fallback: scan for folder names in raw text ──
    let found = false;
    for (const folder of sortedFolders) {
      if (rawResponse.toLowerCase().includes(folder.toLowerCase())) {
        if (isNoiseFolderName(folder) && domainActive) {
          const sugName = globalDomain!.subdomain || "Misc";
          const sugPath = buildSuggestedPath(globalDomain, sortedFolders, sugName);

          result = {
            category: sanitizeFolderName(sugName),
            confidence: 10,
            reasoning: `Domain router rejected noise folder "${folder}" from unparseable response`,
            isNewFolder: true,
            detected_concepts: [],
            concept_abstraction: "",
            requires_review: true,
            was_noise_penalized: true,
            global_domain: gd,
            global_subdomain: gs,
            suggested_path: sugPath,
            match_level: "fallback",
          };
        } else {
          let conf = 25;
          let penalized = false;
          if (isNoiseFolderName(folder)) {
            conf = Math.max(0, conf - NOISE_FOLDER_PENALTY);
            penalized = true;
          }
          result = {
            category: folder,
            confidence: conf,
            reasoning: "Extracted from unparseable AI response",
            isNewFolder: false,
            detected_concepts: [],
            concept_abstraction: "",
            requires_review: true,
            was_noise_penalized: penalized,
            global_domain: gd,
            global_subdomain: gs,
            suggested_path: "",
            match_level: "fallback",
          };
        }
        found = true;
        break;
      }
    }

    if (!found) {
      if (domainActive) {
        const sugName = globalDomain!.subdomain || globalDomain!.domain;
        const sugPath = buildSuggestedPath(globalDomain, sortedFolders, sugName);
        result = {
          category: sanitizeFolderName(sugName),
          confidence: 20,
          reasoning: `Fallback — could not parse AI response. Domain: ${gd} / ${gs}.`,
          isNewFolder: true,
          detected_concepts: [],
          concept_abstraction: "",
          requires_review: true,
          was_noise_penalized: false,
          global_domain: gd,
          global_subdomain: gs,
          suggested_path: sugPath,
          match_level: "fallback",
        };
      } else {
        result = {
          category: "Documents",
          confidence: 5,
          reasoning: "Fallback — could not parse AI response",
          isNewFolder: sortedFolders.length === 0,
          detected_concepts: [],
          concept_abstraction: "",
          requires_review: true,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: "fallback",
        };
      }
    }
  }

  return {
    result: result!,
    rawResponse,
    responseTimeMs,
    systemPrompt,
    userMessage,
    parsedJSON: parsed,
  };
}

// ═══════════════════════════════════════════════════════════════
//  STEP 7: BROAD FALLBACK
// ═══════════════════════════════════════════════════════════════

function stepBroadFallback(
  specificResult: ClassificationResult,
  globalDomain: GlobalDomainResult | null,
  activeFolders: string[]
): ClassificationResult {
  step(7, "BROAD FALLBACK");

  if (specificResult.confidence >= REVIEW_THRESHOLD) {
    ok(
      `Specific match confidence (${specificResult.confidence}%) >= threshold (${REVIEW_THRESHOLD}%) — no fallback needed`
    );
    specificResult.match_level = "specific";
    return specificResult;
  }

  warn(
    `Specific match confidence (${specificResult.confidence}%) < threshold (${REVIEW_THRESHOLD}%)`
  );

  if (
    globalDomain &&
    globalDomain.confidence >= DOMAIN_CONFIDENCE_THRESHOLD
  ) {
    info("Using Global Domain to suggest a hierarchical path...");

    const sugPath = buildSuggestedPath(
      globalDomain,
      activeFolders,
      globalDomain.subdomain
    );
    const leaf = sugPath.includes("/")
      ? sanitizeFolderName(sugPath.split("/").pop()!)
      : sanitizeFolderName(globalDomain.subdomain || globalDomain.domain);

    field("Suggested path", sugPath);
    field("Leaf folder", leaf);

    const broad: ClassificationResult = {
      ...specificResult,
      category: leaf || specificResult.category,
      confidence: Math.max(specificResult.confidence, 50),
      reasoning:
        specificResult.reasoning +
        ` [Broad fallback via domain ${globalDomain.domain}/${globalDomain.subdomain}]`,
      isNewFolder: true,
      suggested_path: sugPath,
      match_level: "broad",
    };

    ok(
      `Broad fallback → "${broad.category}" (${broad.confidence}%) via ${globalDomain.domain}/${globalDomain.subdomain}`
    );
    return broad;
  }

  warn("No strong domain available — returning raw specific match result");
  specificResult.match_level = "fallback";
  return specificResult;
}

// ═══════════════════════════════════════════════════════════════
//  STEP 8: THE SCORECARD
// ═══════════════════════════════════════════════════════════════

function stepScorecard(
  result: ClassificationResult,
  fingerprints: Record<string, FolderFingerprint>,
  fileText: string,
  activeFolders: string[]
): void {
  step(8, "THE SCORECARD");

  const fileKeywords = extractKeywords(fileText, 20);
  const fileLower = fileText.toLowerCase();

  interface FolderScore {
    folder: string;
    score: number;
    matchedTerms: string[];
    isAIPick: boolean;
    noisePenalty: boolean;
  }

  const scores: FolderScore[] = [];

  for (const folder of activeFolders) {
    const fp = fingerprints[folder];
    if (!fp || fp.isNoiseFolder) continue;

    let score = 0;
    const matched: string[] = [];

    for (const kw of fp.keywords) {
      if (fileLower.includes(kw.toLowerCase()) && kw.length > 2) {
        score += 50 / Math.max(fp.keywords.length, 1);
        matched.push(kw);
      }
    }

    for (const topic of fp.coreTopics) {
      const topicWords = topic.toLowerCase().split(/\s+/);
      for (const tw of topicWords) {
        if (fileLower.includes(tw) && tw.length > 3) {
          score += 40 / Math.max(fp.coreTopics.length * 2, 1);
          if (!matched.includes(topic)) matched.push(`[Core] ${topic}`);
        }
      }
    }

    if (fileLower.includes(folder.toLowerCase()) && folder.length > 2) {
      score += 10;
      matched.push(`[Name] ${folder}`);
    }

    scores.push({
      folder,
      score: Math.round(Math.min(100, score)),
      matchedTerms: matched,
      isAIPick: folder === result.category,
      noisePenalty: false,
    });
  }

  scores.sort((a, b) => b.score - a.score);

  const aiInScores = scores.find((s) => s.isAIPick);
  if (!aiInScores && result.category) {
    scores.unshift({
      folder: result.category,
      score: result.confidence,
      matchedTerms: ["(AI primary pick)"],
      isAIPick: true,
      noisePenalty: result.was_noise_penalized,
    });
  }

  // ── Match level badge ──
  console.log();
  const levelColor =
    result.match_level === "bullseye" ? C.green :
    result.match_level === "specific" ? C.cyan :
    result.match_level === "broad" ? C.yellow : C.red;
  field(
    "Waterfall step",
    `${levelColor}${C.bold}${result.match_level.toUpperCase()}${C.reset}`
  );

  // ── Scorecard table ──
  console.log();
  console.log(
    `  ${C.bold}${C.dim}RANK  FOLDER                CONFIDENCE  NOTES${C.reset}`
  );
  console.log(
    `  ${C.dim}\u2500\u2500\u2500\u2500\u2500 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 \u2500\u2500\u2500\u2500\u2500\u2500${C.reset}`
  );

  const top3 = scores.slice(0, 3);
  for (let i = 0; i < top3.length; i++) {
    const s = top3[i];
    const rank = `#${i + 1}`;
    const folderPad = s.folder.padEnd(20).slice(0, 20);
    const isAI = s.isAIPick;

    let confStr: string;
    if (isAI) {
      confStr = `${result.confidence}%`;
      if (result.was_noise_penalized) confStr += ` ${C.red}(penalized)${C.reset}`;
    } else {
      confStr = `${s.score}%${C.dim} (heuristic)${C.reset}`;
    }

    const notes = s.matchedTerms.slice(0, 3).join(", ");
    const marker = isAI ? `${C.green}\u2190 AI pick${C.reset}` : "";

    console.log(
      `  ${C.bold}${rank.padEnd(5)}${C.reset} ${folderPad} ${confStr.padEnd(25)} ${notes} ${marker}`
    );
  }

  if (scores.length === 0) {
    indent(`${C.dim}(no scored folders)${C.reset}`);
  }

  // ── Status flags ──
  console.log();
  if (result.was_noise_penalized) {
    warn(
      `${C.bold}Noise Penalty Applied:${C.reset} ${C.red}YES${C.reset} — "${result.category}" is a noise folder, confidence reduced by ${NOISE_FOLDER_PENALTY}%`
    );
  } else {
    ok(`Noise Penalty Applied: No`);
  }

  if (result.requires_review) {
    warn(
      `Requires Review: ${C.yellow}YES${C.reset} (${result.confidence}% < ${REVIEW_THRESHOLD}% threshold)`
    );
  } else {
    ok(`Requires Review: No (${result.confidence}% >= ${REVIEW_THRESHOLD}% threshold)`);
  }

  if (result.isNewFolder) {
    info(`New Folder Suggested: ${C.yellow}YES${C.reset} — "${result.category}"`);
    if (result.suggested_path) {
      field("Suggested path", result.suggested_path);
    }
  } else {
    field("New Folder Suggested", "No");
  }

  if (result.global_domain) {
    field("Global Domain", `${result.global_domain} / ${result.global_subdomain}`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  VERDICT
// ═══════════════════════════════════════════════════════════════

function printVerdict(
  result: ClassificationResult,
  fingerprints: Record<string, FolderFingerprint>
): void {
  console.log();
  console.log(C.bold + "=".repeat(62) + C.reset);

  const confColor =
    result.confidence >= 80
      ? C.green
      : result.confidence >= 60
        ? C.yellow
        : C.red;

  const levelColor =
    result.match_level === "bullseye" ? C.green :
    result.match_level === "specific" ? C.cyan :
    result.match_level === "broad" ? C.yellow : C.red;

  console.log(
    `  ${C.bold}VERDICT:${C.reset} "${C.bold}${result.category}${C.reset}" ` +
    `(${confColor}${result.confidence}% confidence${C.reset}) ` +
    `[${levelColor}${result.match_level.toUpperCase()}${C.reset}]`
  );

  console.log();
  console.log(`  ${C.bold}WHY:${C.reset}`);

  const reasons: string[] = [];

  if (result.reasoning) {
    reasons.push(result.reasoning);
  }

  const fp = fingerprints[result.category];
  if (fp) {
    if (fp.coreTopics.length > 0) {
      reasons.push(`Matched Core Topics: ${fp.coreTopics.join(", ")}`);
    }
    if (fp.activityLabel) {
      reasons.push(`Folder status: ${fp.activityLabel}`);
    }
  }

  if (result.was_noise_penalized) {
    reasons.push(
      `Note: confidence was reduced by ${NOISE_FOLDER_PENALTY}% (noise folder penalty)`
    );
  }

  if (result.suggested_path) {
    reasons.push(`Suggested path: ${result.suggested_path}`);
  }

  for (const reason of reasons) {
    indent(`${C.cyan}\u2192${C.reset} ${reason}`);
  }

  console.log();
  console.log(C.bold + "=".repeat(62) + C.reset);
  console.log();
}

// ═══════════════════════════════════════════════════════════════
//  ARGUMENT PARSING & AUTO-DETECTION
// ═══════════════════════════════════════════════════════════════

function parseArgs(): { filePath: string; targetDir: string } {
  const args = process.argv.slice(2);
  let filePath = "";
  let targetDir = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target" && i + 1 < args.length) {
      targetDir = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
${C.bold}trace-decision.ts${C.reset} — Specificity Waterfall Decision Diary

${C.bold}Usage:${C.reset}
  npm run trace -- <file-path> [--target <organized-folder>]
  npx tsx scripts/trace-decision.ts <file-path> [--target <dir>]

${C.bold}Waterfall Pipeline:${C.reset}
  Step 0 — Archives Ban    (filter noise folders for recent files)
  Step 1 — Context Loading  (fingerprints, aliases, expansions)
  Step 2 — Text Extraction  (native / PDF / OCR cascade)
  Step 3 — Bullseye Check   (token match → 100%, zero AI)
  Step 4 — Learning Memory  (user corrections)
  Step 5 — Global Domain    (Education / Finance / … classifier)
  Step 6 — Specific Match   (domain-aware AI chain-of-thought)
  Step 7 — Broad Fallback   (only if Step 6 < 60%)
  Step 8 — Scorecard        (final verdict)

${C.bold}Arguments:${C.reset}
  <file-path>      Path to the file to classify
  --target <dir>   The organized folder root (where subfolders live)
                   Auto-detected from app config if omitted

${C.bold}Examples:${C.reset}
  npm run trace -- ./my-report.pdf
  npm run trace -- ~/Downloads/essay.docx --target ~/Desktop/AI_SORTED_FILES
`);
      process.exit(0);
    } else if (!filePath) {
      filePath = args[i];
    } else if (!targetDir) {
      targetDir = args[i];
    }
  }

  if (!filePath) {
    console.error(
      `${C.red}Error: No file path provided.${C.reset}\n` +
        `Usage: npm run trace -- <file-path> [--target <organized-folder>]`
    );
    process.exit(1);
  }

  filePath = path.resolve(filePath);

  if (!fs.existsSync(filePath)) {
    console.error(`${C.red}Error: File not found: ${filePath}${C.reset}`);
    process.exit(1);
  }

  if (!targetDir) {
    targetDir = autoDetectTargetDir();
  } else {
    targetDir = path.resolve(targetDir);
  }

  if (!targetDir || !fs.existsSync(targetDir)) {
    console.error(
      `${C.red}Error: Target directory not found.${C.reset}\n` +
        `Provide it with: npm run trace -- <file> --target <organized-folder>\n` +
        `This should be the root folder where your organized subfolders live.`
    );
    process.exit(1);
  }

  return { filePath, targetDir };
}

function autoDetectTargetDir(): string {
  const configPath = path.join(getUserDataPath(), "config.json");
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      for (const [key, value] of Object.entries(config)) {
        if (
          typeof value === "string" &&
          (key.toLowerCase().includes("target") ||
            key.toLowerCase().includes("dest") ||
            key.toLowerCase().includes("output") ||
            key.toLowerCase().includes("folder"))
        ) {
          if (fs.existsSync(value as string)) {
            info(`Auto-detected target from app config: ${value}`);
            return value as string;
          }
        }
      }
    }
  } catch {
    /* no config */
  }

  const candidates = [
    path.join(os.homedir(), "Desktop", "AI_SORTED_FILES"),
    path.join(os.homedir(), "Desktop", "Organized"),
    path.join(os.homedir(), "Desktop", "Sorted"),
    path.join(os.homedir(), "Documents", "Organized"),
    path.join(os.homedir(), "Documents", "AI_SORTED_FILES"),
  ];

  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const subfolders = entries.filter(
          (e) => e.isDirectory() && !e.name.startsWith(".")
        );
        if (subfolders.length > 0) {
          info(`Auto-detected target directory: ${dir}`);
          return dir;
        }
      }
    } catch {
      continue;
    }
  }

  return "";
}

// ═══════════════════════════════════════════════════════════════
//  MAIN — Specificity Waterfall
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  header();

  const { filePath, targetDir } = parseArgs();
  const filename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  field("File", filePath);
  field("Target", targetDir);

  // Check Ollama connectivity
  console.log();
  info("Checking Ollama connectivity...");
  const ollamaOk = await checkOllamaHealth();
  if (ollamaOk) {
    ok(`Ollama is running (${MODEL_NAME} @ ${OLLAMA_HOST}:${OLLAMA_PORT})`);
  } else {
    warn(
      `Ollama is NOT reachable at ${OLLAMA_HOST}:${OLLAMA_PORT}. AI features will be limited.`
    );
  }

  // ── Step 1: Context Loading ──
  const { fingerprints, userFolders } = await stepContextLoading(targetDir, ollamaOk);

  // ── Step 0: Archives Ban ──
  const { activeFolders, fileRecent, banned } = stepArchivesBan(filePath, userFolders);

  // ── Step 2: Text Extraction ──
  const extraction = await stepTextExtraction(filePath);

  // ── RAW VISION: Forensic Analysis ──
  stepRawVision(extraction.text, fingerprints, activeFolders);

  // ── Step 3: Bullseye Check ──
  const bullseye = stepBullseyeCheck(
    filename,
    extraction.text,
    fingerprints,
    activeFolders
  );

  if (bullseye) {
    // Bullseye hit — skip AI entirely
    stepScorecard(bullseye, fingerprints, extraction.text, activeFolders);
    printVerdict(bullseye, fingerprints);
    return;
  }

  // ── Step 4: Learning Memory ──
  const learningBlock = stepLearningMemory(ext);

  // ── Step 5: Global Domain Classification ──
  if (!ollamaOk) {
    step(5, "GLOBAL DOMAIN CLASSIFICATION");
    warn("SKIPPED — Ollama is not running.");
    step(6, "SPECIFIC MATCH (Domain-Aware AI)");
    warn("SKIPPED — Ollama is not running. Start Ollama and try again.");
    step(7, "BROAD FALLBACK");
    warn("SKIPPED — No AI response to evaluate.");
    step(8, "THE SCORECARD");
    warn("SKIPPED — No classification result.");
    console.log();
    return;
  }

  const globalDomain = await stepGlobalDomain(filename, ext, extraction.text);

  // ── Step 6: Specific Match ──
  const specificResult = await stepSpecificMatch(
    filePath,
    extraction,
    fingerprints,
    activeFolders,
    learningBlock,
    globalDomain
  );

  // ── Step 7: Broad Fallback ──
  const finalResult = stepBroadFallback(
    specificResult.result,
    globalDomain,
    activeFolders
  );

  // ── Step 8: Scorecard ──
  stepScorecard(finalResult, fingerprints, extraction.text, activeFolders);

  // ── Verdict ──
  printVerdict(finalResult, fingerprints);
}

main().catch((err) => {
  console.error(`${C.red}Fatal error: ${err.message || err}${C.reset}`);
  process.exit(1);
});
