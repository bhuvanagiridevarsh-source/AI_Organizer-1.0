/**
 * ContextService.ts — Universal Folder Intelligence Engine.
 *
 * PRODUCTION-GRADE folder fingerprinting with:
 *
 *   1. SEMANTIC EXPANSION (Cold Start Fix)
 *      Empty folders don't stay empty — we query Ollama to generate
 *      10 keywords that DEFINE what belongs in that folder.
 *      Result: "Chemistry" folder immediately attracts "atoms", "periodic table".
 *
 *   2. ACRONYM AWARENESS
 *      2-letter UPPERCASE tokens are preserved: AP, HR, IT, UX, IP.
 *      Result: "AP Seminar" → ["AP", "Seminar"], not just ["Seminar"].
 *
 *   3. NOISE CANCELLATION (Junk Trap Fix)
 *      Folders like "Archives", "Old", "Misc" are SKIPPED entirely.
 *      They return empty fingerprints so the AI never matches to them.
 *      Result: Files go to real topic folders, not junk drawers.
 *
 *   4. TOPIC ALIASING
 *      User-defined alias_map.json provides authoritative semantic links.
 *      "APUSH" → "US History, Native Americans, Civil War..."
 *
 * The result is a Context Map that works on DAY ONE, even with empty folders.
 */

import fs from "fs";
import path from "path";
import http from "http";

// ── Configuration ──────────────────────────────────────────

const SAMPLE_FILES_PER_FOLDER = 3;
const WORDS_PER_SAMPLE = 500;
const TOP_KEYWORDS = 10;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_READ_BYTES = 8192;

const ALIAS_MAP_FILENAME = "alias_map.json";

// Ollama config for semantic expansion
const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const EXPANSION_TIMEOUT_MS = 30000;

// Prefer the larger model if installed; fall back to 1b
const EXPANSION_MODEL_PREFERENCE = ["llama3.2:3b", "llama3.2:1b", "llama3.2"];
let resolvedExpansionModel: string | null = null;

async function getExpansionModel(): Promise<string> {
  if (resolvedExpansionModel) return resolvedExpansionModel;
  try {
    const models = await new Promise<string[]>((resolve) => {
      const req = http.request(
        { hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: "/api/tags", method: "GET", timeout: 5000 },
        (res) => {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString()));
          res.on("end", () => {
            try { resolve((JSON.parse(body).models || []).map((m: { name: string }) => m.name)); }
            catch { resolve([]); }
          });
        }
      );
      req.on("error", () => resolve([]));
      req.on("timeout", () => { req.destroy(); resolve([]); });
      req.end();
    });
    for (const pref of EXPANSION_MODEL_PREFERENCE) {
      if (models.some((m) => m === pref || m.startsWith(pref.split(":")[0] + ":"))) {
        resolvedExpansionModel = models.find((m) => m === pref) || pref;
        return resolvedExpansionModel;
      }
    }
  } catch { /* fall through */ }
  resolvedExpansionModel = "llama3.2:1b";
  return resolvedExpansionModel;
}

// Synchronous fallback for non-async callers
const EXPANSION_MODEL = "llama3.2:1b";

// ── Noise Folders (NEVER fingerprint these) ────────────────

const NOISE_FOLDERS = new Set([
  // English
  "archives", "archive", "old", "misc", "miscellaneous", "temp", "temporary",
  "backup", "backups", "downloads", "download", "trash", "deleted",
  "unsorted", "random", "stuff", "other", "various", "general",
  "inbox", "incoming", "outbox", "sent", "drafts",
  // System
  "node_modules", ".git", ".svn", "__pycache__", ".cache", ".tmp",
  "$recycle.bin", "system volume information",
]);

// Text-readable extensions we can sample from
const READABLE_EXTENSIONS = new Set([
  ".txt", ".md", ".py", ".js", ".ts", ".jsx", ".tsx", ".json", ".csv",
  ".log", ".html", ".css", ".xml", ".yaml", ".yml", ".toml", ".ini",
  ".cfg", ".conf", ".sh", ".rb", ".php", ".java", ".c", ".cpp", ".h",
  ".go", ".rs", ".swift", ".kt", ".sql", ".vue", ".svelte", ".rtf",
]);

// Extensions where we can try CLI extraction
const EXTRACTABLE_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".odt"]);

// ── Stop words ─────────────────────────────────────────────

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
  // Code/markup noise
  "function", "return", "const", "let", "var", "import", "export",
  "class", "new", "null", "undefined", "true", "false", "string",
  "number", "void", "type", "interface", "public", "private",
  "static", "async", "await", "try", "catch", "throw", "else",
  "div", "span", "src", "href", "http", "https", "www", "com",
]);

// ── Types ──────────────────────────────────────────────────

export interface FolderFingerprint {
  keywords: string[];           // Auto-detected OR AI-expanded keywords
  coreTopics: string[];         // User-defined semantic aliases
  sampleCount: number;          // 0 = AI-expanded, >0 = file-sampled
  isAIExpanded: boolean;        // True if keywords came from Ollama
  isNoiseFolder: boolean;       // True if this folder is blacklisted
  updatedAt: number;
}

export type FolderContextMap = Record<string, FolderFingerprint>;

// Raw alias map from JSON file
export type AliasMap = Record<string, string>;

// ── Cache ──────────────────────────────────────────────────

let contextCache: FolderContextMap = {};
let aliasCache: AliasMap = {};
let cacheTargetDir = "";
let cacheTimestamp = 0;

// Expansion cache (persists across sessions via simple JSON file)
let expansionCache: Record<string, string[]> = {};
let expansionCacheLoaded = false;

// ── Expansion Cache Persistence ────────────────────────────

function getExpansionCachePath(targetDir: string): string {
  return path.join(targetDir, ".folder_expansions.json");
}

function loadExpansionCache(targetDir: string): void {
  if (expansionCacheLoaded) return;

  const cachePath = getExpansionCachePath(targetDir);
  try {
    if (fs.existsSync(cachePath)) {
      const raw = fs.readFileSync(cachePath, "utf-8");
      expansionCache = JSON.parse(raw);
      console.log(`[ContextService] Loaded ${Object.keys(expansionCache).length} cached expansions`);
    }
  } catch {
    expansionCache = {};
  }
  expansionCacheLoaded = true;
}

function saveExpansionCache(targetDir: string): void {
  const cachePath = getExpansionCachePath(targetDir);
  try {
    fs.writeFileSync(cachePath, JSON.stringify(expansionCache, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[ContextService] Failed to save expansion cache: ${err}`);
  }
}

// ── Alias Map Reader ───────────────────────────────────────

/** Normalize a folder name to a default-map lookup key: lowercase, strip hyphens/underscores/spaces/dots/plus-signs */
function normAliasKey(name: string): string {
  return name.toLowerCase().replace(/[-_\s+.]/g, "");
}

/** In-memory cache for the bundled default alias map (loaded once at startup) */
let defaultAliasMapCache: Record<string, string> | null = null;

/** Load the bundled default_alias_map.json (ships with the app in resources/).
 *  Keys in that file are normalised lowercase stems (e.g. "precalc", "apush"). */
function loadDefaultAliasMap(): Record<string, string> {
  if (defaultAliasMapCache !== null) return defaultAliasMapCache;

  try {
    const candidates = [
      process.resourcesPath
        ? path.join(process.resourcesPath, "default_alias_map.json")
        : "",
      path.join(__dirname, "../../../../resources/default_alias_map.json"),
      path.join(__dirname, "../../../resources/default_alias_map.json"),
      path.join(__dirname, "../../resources/default_alias_map.json"),
    ].filter(Boolean);

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, string>;
        delete parsed["_comment"];
        defaultAliasMapCache = parsed;
        console.log(
          `[ContextService] Loaded ${Object.keys(parsed).length} default subject aliases`
        );
        return parsed;
      }
    }
  } catch (err) {
    console.warn(`[ContextService] Could not load default_alias_map.json: ${err}`);
  }
  defaultAliasMapCache = {};
  return {};
}

/**
 * Resolve the best alias topics string for a folder name.
 * Priority:  user override (exact name) → default (normalised key match)
 */
export function resolveAlias(
  userAliases: AliasMap,
  folderName: string
): string {
  // Exact user override wins
  if (userAliases[folderName]) return userAliases[folderName];

  // Normalised default lookup ("Pre-Calc" → "precalc" key)
  const norm = normAliasKey(folderName);
  const defaults = loadDefaultAliasMap();
  return defaults[norm] || "";
}

function loadAliasMap(targetDir: string): AliasMap {
  const aliasPath = path.join(targetDir, ALIAS_MAP_FILENAME);

  try {
    if (!fs.existsSync(aliasPath)) {
      return {};
    }

    const raw = fs.readFileSync(aliasPath, "utf-8");
    const parsed = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null) {
      console.warn(`[ContextService] alias_map.json is not a valid object`);
      return {};
    }

    const result: AliasMap = {};
    for (const [folder, topics] of Object.entries(parsed)) {
      if (typeof topics === "string") {
        result[folder] = topics;
      }
    }

    const count = Object.keys(result).length;
    if (count > 0) {
      console.log(`[ContextService] Loaded ${count} user topic aliases from alias_map.json`);
    }

    return result;
  } catch (err) {
    console.warn(`[ContextService] Failed to read alias_map.json: ${err}`);
    return {};
  }
}

function parseTopics(topicString: string): string[] {
  return topicString
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// ── Semantic Expansion via Ollama ──────────────────────────

/**
 * Query Ollama to generate keywords for an empty folder.
 * This is the "Cold Start Fix" — empty folders get smart fingerprints.
 */
async function expandFolderSemantics(folderName: string): Promise<string[]> {
  // Check cache first
  if (expansionCache[folderName]) {
    return expansionCache[folderName];
  }

  const prompt = `You are a file categorization expert. Generate exactly 10 distinct keywords that define what files belong in a folder named "${folderName}".

Rules:
- Output ONLY a JSON array of 10 lowercase keywords
- Keywords should be specific, not generic (e.g., "molecule" not "file")
- Include synonyms and related concepts
- Think about what CONTENT would be inside files in this folder

Example for "Chemistry":
["molecule", "atom", "periodic", "element", "reaction", "compound", "formula", "bond", "acid", "solution"]

Example for "Litigation":
["lawsuit", "court", "plaintiff", "defendant", "legal", "attorney", "deposition", "verdict", "settlement", "damages"]

Now generate for "${folderName}":`;

  return getExpansionModel().then((expansionModel) => new Promise((resolve) => {
    const payload = JSON.stringify({
      model: expansionModel,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      options: { temperature: 0.3 },
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
        timeout: EXPANSION_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            const content = data.message?.content || "";

            // Extract JSON array from response
            const match = content.match(/\[[\s\S]*?\]/);
            if (match) {
              const keywords = JSON.parse(match[0])
                .filter((k: unknown) => typeof k === "string")
                .map((k: string) => k.toLowerCase().trim())
                .slice(0, 10);

              if (keywords.length >= 5) {
                expansionCache[folderName] = keywords;
                console.log(`[ContextService] AI-expanded "${folderName}": [${keywords.join(", ")}]`);
                resolve(keywords);
                return;
              }
            }
          } catch {
            // Parse failed
          }

          // Fallback: extract from folder name
          resolve(extractKeywordsFromName(folderName));
        });
        res.on("error", () => resolve(extractKeywordsFromName(folderName)));
      }
    );

    req.on("error", () => resolve(extractKeywordsFromName(folderName)));
    req.on("timeout", () => {
      req.destroy();
      resolve(extractKeywordsFromName(folderName));
    });

    req.write(payload);
    req.end();
  }));
}

/**
 * Fallback: extract keywords from the folder name itself.
 * Used when Ollama is unavailable.
 */
function extractKeywordsFromName(folderName: string): string[] {
  // Split on common separators
  const tokens = folderName
    .replace(/[-_]/g, " ")
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

  return tokens.length > 0 ? tokens : [folderName.toLowerCase()];
}

// ── Internal helpers ───────────────────────────────────────

/**
 * Check if a folder is a "noise" folder that should be skipped.
 */
function isNoiseFolder(folderName: string): boolean {
  return NOISE_FOLDERS.has(folderName.toLowerCase());
}

/**
 * Extract keywords with ACRONYM AWARENESS.
 *
 * Rule: Allow 2-letter words if they are UPPERCASE (AP, HR, IT, UX).
 * This fixes the "AP Seminar" → ["Seminar"] problem.
 */
function extractKeywords(text: string, topN: number): string[] {
  // First pass: split into tokens
  const rawTokens = text
    .replace(/[-_]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);

  // Process each token with acronym awareness
  const processedTokens: string[] = [];
  for (const token of rawTokens) {
    const lower = token.toLowerCase();

    // Skip pure stop words
    if (STOP_WORDS.has(lower)) continue;

    // ACRONYM RULE: Allow 2-char tokens if UPPERCASE
    if (token.length >= 2 && token === token.toUpperCase() && /^[A-Z]{2,}$/.test(token)) {
      processedTokens.push(token); // Keep original case for acronyms
      continue;
    }

    // Standard rule: 3+ characters, alphanumeric only
    const cleaned = lower.replace(/[^a-z]/g, "");
    if (cleaned.length >= 3 && !STOP_WORDS.has(cleaned)) {
      processedTokens.push(cleaned);
    }
  }

  // Count frequencies
  const freq: Record<string, number> = {};
  for (const w of processedTokens) {
    const key = w.toLowerCase();
    freq[key] = (freq[key] || 0) + 1;
  }

  // Return top N by frequency, preserving acronym case
  const sorted = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);

  // Restore acronym casing
  return sorted.map(([word]) => {
    const originalAcronym = processedTokens.find(
      (t) => t.toLowerCase() === word && t === t.toUpperCase() && t.length >= 2
    );
    return originalAcronym || word;
  });
}

function readSampleText(filePath: string): string {
  try {
    const ext = path.extname(filePath).toLowerCase();

    if (READABLE_EXTENSIONS.has(ext)) {
      const fd = fs.openSync(filePath, "r");
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, MAX_READ_BYTES, 0);
      fs.closeSync(fd);
      let text = buffer.slice(0, bytesRead).toString("utf-8");

      if ([".html", ".xml", ".vue", ".svelte"].includes(ext)) {
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&[a-z]+;/gi, " ");
      }

      return text;
    }

    if (EXTRACTABLE_EXTENSIONS.has(ext)) {
      const { execSync } = require("child_process");

      if (ext === ".pdf") {
        try {
          return execSync(`pdftotext -l 3 -enc UTF-8 "${filePath}" -`, {
            encoding: "utf-8",
            timeout: 5000,
            maxBuffer: 256 * 1024,
          });
        } catch { /* fallthrough */ }
      }

      if (ext === ".docx") {
        try {
          const raw = execSync(`unzip -p "${filePath}" "word/document.xml" 2>/dev/null`, {
            encoding: "utf-8",
            timeout: 5000,
            maxBuffer: 256 * 1024,
          });
          return raw.replace(/<[^>]+>/g, " ");
        } catch { /* fallthrough */ }
      }
    }
  } catch {
    // Unreadable
  }

  return "";
}

function sampleFiles(dirPath: string, count: number): string[] {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => path.join(dirPath, e.name));

    if (files.length === 0) return [];
    if (files.length <= count) return files;

    const shuffled = [...files];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, count);
  } catch {
    return [];
  }
}

function trimWords(text: string, max: number): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  return words.slice(0, max).join(" ");
}

// ── Public API ─────────────────────────────────────────────

/**
 * Build fingerprints for every subfolder in targetDir.
 *
 * PRODUCTION FEATURES:
 *   - Noise folders are skipped (Archives, Old, Misc, etc.)
 *   - Empty folders get AI-expanded keywords (Cold Start Fix)
 *   - Acronyms are preserved (AP, HR, IT, etc.)
 *   - User aliases override everything
 */
export async function buildFolderFingerprints(
  targetDir: string
): Promise<FolderContextMap> {
  // Return cache if still fresh
  if (
    targetDir === cacheTargetDir &&
    Date.now() - cacheTimestamp < CACHE_TTL_MS &&
    Object.keys(contextCache).length > 0
  ) {
    return contextCache;
  }

  // Load expansion cache and alias map
  loadExpansionCache(targetDir);
  const aliasMap = loadAliasMap(targetDir);
  aliasCache = aliasMap;

  const result: FolderContextMap = {};

  try {
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

      const folderName = entry.name;
      const folderPath = path.join(targetDir, folderName);

      // ── NOISE CANCELLATION ──
      if (isNoiseFolder(folderName)) {
        result[folderName] = {
          keywords: [],
          coreTopics: [],
          sampleCount: 0,
          isAIExpanded: false,
          isNoiseFolder: true,
          updatedAt: Date.now(),
        };
        console.log(`[ContextService] SKIPPED noise folder: "${folderName}"`);
        continue;
      }

      const files = sampleFiles(folderPath, SAMPLE_FILES_PER_FOLDER);
      let keywords: string[] = [];
      let isAIExpanded = false;

      // ── SEMANTIC EXPANSION (Cold Start Fix) ──
      if (files.length < SAMPLE_FILES_PER_FOLDER) {
        // Not enough files — use AI expansion
        keywords = await expandFolderSemantics(folderName);
        isAIExpanded = true;

        // Also extract from folder name (for acronyms)
        const nameKeywords = extractKeywords(folderName.replace(/[-_]/g, " "), 5);
        for (const kw of nameKeywords) {
          if (!keywords.includes(kw.toLowerCase()) && !keywords.includes(kw)) {
            keywords.push(kw);
          }
        }
      } else {
        // Enough files — sample content
        let combined = "";
        for (const filePath of files) {
          const text = readSampleText(filePath);
          combined += " " + trimWords(text, WORDS_PER_SAMPLE);
        }
        keywords = extractKeywords(combined, TOP_KEYWORDS);
      }

      // Get core topics: user alias override first, then bundled defaults
      const aliasString = resolveAlias(aliasMap, folderName);
      const coreTopics = aliasString ? parseTopics(aliasString) : [];

      result[folderName] = {
        keywords,
        coreTopics,
        sampleCount: files.length,
        isAIExpanded,
        isNoiseFolder: false,
        updatedAt: Date.now(),
      };

      // Detailed logging
      const status = isAIExpanded ? "AI-EXPANDED" : `${files.length} files`;
      const topicsLog = coreTopics.length > 0 ? ` | Core: [${coreTopics.join(", ")}]` : "";
      console.log(
        `[ContextService] "${folderName}" (${status}): [${keywords.slice(0, 5).join(", ")}]${topicsLog}`
      );
    }
  } catch (err) {
    console.error(`[ContextService] buildFolderFingerprints failed: ${err}`);
  }

  // Persist expansion cache
  saveExpansionCache(targetDir);

  // Update cache
  contextCache = result;
  cacheTargetDir = targetDir;
  cacheTimestamp = Date.now();

  return result;
}

/**
 * Get the folder context map (builds fingerprints if cache is stale).
 */
export async function getFolderContext(
  targetDir: string
): Promise<FolderContextMap> {
  return buildFolderFingerprints(targetDir);
}

/**
 * Get a rich context description for each folder, formatted for prompt injection.
 *
 * EXCLUDES noise folders from the prompt entirely.
 */
export async function getFolderContextForPrompt(
  targetDir: string
): Promise<Record<string, { autoKeywords: string; coreTopics: string; description: string; isNoiseFolder: boolean }>> {
  const fingerprints = await getFolderContext(targetDir);
  const result: Record<string, { autoKeywords: string; coreTopics: string; description: string; isNoiseFolder: boolean }> = {};

  for (const [folder, fp] of Object.entries(fingerprints)) {
    // Skip noise folders in prompt
    if (fp.isNoiseFolder) {
      result[folder] = {
        autoKeywords: "",
        coreTopics: "",
        description: "(noise folder - excluded from matching)",
        isNoiseFolder: true,
      };
      continue;
    }

    const autoKeywords = fp.keywords.length > 0
      ? fp.keywords.join(", ")
      : "(no keywords)";

    const coreTopics = fp.coreTopics.length > 0
      ? fp.coreTopics.join(", ")
      : "";

    // Build human-readable description
    const lines: string[] = [`Folder: ${folder}`];

    if (fp.isAIExpanded) {
      lines.push(`  Keywords (AI-generated): [${autoKeywords}]`);
    } else {
      lines.push(`  Keywords (from ${fp.sampleCount} files): [${autoKeywords}]`);
    }

    if (coreTopics) {
      lines.push(`  Core Topics (user-defined): ${coreTopics}`);
    }

    result[folder] = {
      autoKeywords,
      coreTopics,
      description: lines.join("\n"),
      isNoiseFolder: false,
    };
  }

  return result;
}

/**
 * Get a simplified flat map for backward compatibility.
 */
export async function getFolderContextFlat(
  targetDir: string
): Promise<Record<string, string>> {
  const fingerprints = await getFolderContext(targetDir);
  const result: Record<string, string> = {};

  for (const [folder, fp] of Object.entries(fingerprints)) {
    if (fp.isNoiseFolder) {
      result[folder] = "(noise folder)";
      continue;
    }

    const parts: string[] = [];

    if (fp.keywords.length > 0) {
      parts.push(fp.keywords.join(", "));
    }

    if (fp.coreTopics.length > 0) {
      parts.push(`Core Topics: ${fp.coreTopics.join(", ")}`);
    }

    result[folder] = parts.length > 0
      ? parts.join(" | ")
      : "(empty folder)";
  }

  return result;
}

/**
 * Check if a folder name is in the noise list.
 */
export function isNoiseFolderName(folderName: string): boolean {
  return isNoiseFolder(folderName);
}

/**
 * Get the noise folder list (for UI display).
 */
export function getNoiseFolders(): string[] {
  return Array.from(NOISE_FOLDERS);
}

/**
 * Force a cache refresh on the next call.
 */
export function invalidateCache(): void {
  cacheTimestamp = 0;
  contextCache = {};
  aliasCache = {};
  cacheTargetDir = "";
}

/**
 * Get raw fingerprint data (for settings/debug display).
 */
export function getCachedFingerprints(): FolderContextMap {
  return { ...contextCache };
}

/**
 * Get the current alias map (for settings/debug display).
 */
export function getCachedAliases(): AliasMap {
  return { ...aliasCache };
}

/**
 * Save an alias map to disk (for settings UI to update aliases).
 */
export function saveAliasMap(targetDir: string, aliases: AliasMap): void {
  const aliasPath = path.join(targetDir, ALIAS_MAP_FILENAME);

  try {
    fs.writeFileSync(aliasPath, JSON.stringify(aliases, null, 2), "utf-8");
    aliasCache = aliases;
    console.log(`[ContextService] Saved alias_map.json with ${Object.keys(aliases).length} entries`);

    // Invalidate fingerprint cache so next call picks up new aliases
    invalidateCache();
  } catch (err) {
    console.error(`[ContextService] Failed to save alias_map.json: ${err}`);
    throw err;
  }
}
