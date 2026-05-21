var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var ContextService_exports = {};
__export(ContextService_exports, {
  buildFolderFingerprints: () => buildFolderFingerprints,
  getCachedAliases: () => getCachedAliases,
  getCachedFingerprints: () => getCachedFingerprints,
  getFolderContext: () => getFolderContext,
  getFolderContextFlat: () => getFolderContextFlat,
  getFolderContextForPrompt: () => getFolderContextForPrompt,
  getNoiseFolders: () => getNoiseFolders,
  invalidateCache: () => invalidateCache,
  isNoiseFolderName: () => isNoiseFolderName,
  resolveAlias: () => resolveAlias,
  saveAliasMap: () => saveAliasMap
});
module.exports = __toCommonJS(ContextService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_http = __toESM(require("http"));
const SAMPLE_FILES_PER_FOLDER = 3;
const WORDS_PER_SAMPLE = 500;
const TOP_KEYWORDS = 10;
const CACHE_TTL_MS = 5 * 60 * 1e3;
const MAX_READ_BYTES = 8192;
const ALIAS_MAP_FILENAME = "alias_map.json";
const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const EXPANSION_TIMEOUT_MS = 3e4;
const EXPANSION_MODEL_PREFERENCE = ["llama3.2:3b", "llama3.2:1b", "llama3.2"];
let resolvedExpansionModel = null;
async function getExpansionModel() {
  if (resolvedExpansionModel) return resolvedExpansionModel;
  try {
    const models = await new Promise((resolve) => {
      const req = import_http.default.request(
        { hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: "/api/tags", method: "GET", timeout: 5e3 },
        (res) => {
          let body = "";
          res.on("data", (c) => body += c.toString());
          res.on("end", () => {
            try {
              resolve((JSON.parse(body).models || []).map((m) => m.name));
            } catch {
              resolve([]);
            }
          });
        }
      );
      req.on("error", () => resolve([]));
      req.on("timeout", () => {
        req.destroy();
        resolve([]);
      });
      req.end();
    });
    for (const pref of EXPANSION_MODEL_PREFERENCE) {
      if (models.some((m) => m === pref || m.startsWith(pref.split(":")[0] + ":"))) {
        resolvedExpansionModel = models.find((m) => m === pref) || pref;
        return resolvedExpansionModel;
      }
    }
  } catch {
  }
  resolvedExpansionModel = "llama3.2:1b";
  return resolvedExpansionModel;
}
const EXPANSION_MODEL = "llama3.2:1b";
const NOISE_FOLDERS = /* @__PURE__ */ new Set([
  // English
  "archives",
  "archive",
  "old",
  "misc",
  "miscellaneous",
  "temp",
  "temporary",
  "backup",
  "backups",
  "downloads",
  "download",
  "trash",
  "deleted",
  "unsorted",
  "random",
  "stuff",
  "other",
  "various",
  "general",
  "inbox",
  "incoming",
  "outbox",
  "sent",
  "drafts",
  // System
  "node_modules",
  ".git",
  ".svn",
  "__pycache__",
  ".cache",
  ".tmp",
  "$recycle.bin",
  "system volume information"
]);
const READABLE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".txt",
  ".md",
  ".py",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".json",
  ".csv",
  ".log",
  ".html",
  ".css",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".sh",
  ".rb",
  ".php",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".go",
  ".rs",
  ".swift",
  ".kt",
  ".sql",
  ".vue",
  ".svelte",
  ".rtf"
]);
const EXTRACTABLE_EXTENSIONS = /* @__PURE__ */ new Set([".pdf", ".docx", ".pptx", ".odt"]);
const STOP_WORDS = /* @__PURE__ */ new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "it",
  "its",
  "that",
  "this",
  "was",
  "are",
  "be",
  "has",
  "had",
  "have",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "not",
  "no",
  "if",
  "as",
  "so",
  "up",
  "out",
  "all",
  "about",
  "into",
  "over",
  "after",
  "before",
  "between",
  "under",
  "above",
  "below",
  "than",
  "then",
  "when",
  "where",
  "while",
  "which",
  "who",
  "whom",
  "what",
  "how",
  "there",
  "here",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "only",
  "just",
  "also",
  "very",
  "even",
  "still",
  "well",
  "back",
  "been",
  "being",
  "much",
  "any",
  "these",
  "those",
  "own",
  "same",
  "because",
  "through",
  "during",
  // Code/markup noise
  "function",
  "return",
  "const",
  "let",
  "var",
  "import",
  "export",
  "class",
  "new",
  "null",
  "undefined",
  "true",
  "false",
  "string",
  "number",
  "void",
  "type",
  "interface",
  "public",
  "private",
  "static",
  "async",
  "await",
  "try",
  "catch",
  "throw",
  "else",
  "div",
  "span",
  "src",
  "href",
  "http",
  "https",
  "www",
  "com"
]);
let contextCache = {};
let aliasCache = {};
let cacheTargetDir = "";
let cacheTimestamp = 0;
let expansionCache = {};
let expansionCacheLoaded = false;
function getExpansionCachePath(targetDir) {
  return import_path.default.join(targetDir, ".folder_expansions.json");
}
function loadExpansionCache(targetDir) {
  if (expansionCacheLoaded) return;
  const cachePath = getExpansionCachePath(targetDir);
  try {
    if (import_fs.default.existsSync(cachePath)) {
      const raw = import_fs.default.readFileSync(cachePath, "utf-8");
      expansionCache = JSON.parse(raw);
      console.log(`[ContextService] Loaded ${Object.keys(expansionCache).length} cached expansions`);
    }
  } catch {
    expansionCache = {};
  }
  expansionCacheLoaded = true;
}
function saveExpansionCache(targetDir) {
  const cachePath = getExpansionCachePath(targetDir);
  try {
    import_fs.default.writeFileSync(cachePath, JSON.stringify(expansionCache, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[ContextService] Failed to save expansion cache: ${err}`);
  }
}
function normAliasKey(name) {
  return name.toLowerCase().replace(/[-_\s+.]/g, "");
}
let defaultAliasMapCache = null;
function loadDefaultAliasMap() {
  if (defaultAliasMapCache !== null) return defaultAliasMapCache;
  try {
    const candidates = [
      process.resourcesPath ? import_path.default.join(process.resourcesPath, "default_alias_map.json") : "",
      import_path.default.join(__dirname, "../../../../resources/default_alias_map.json"),
      import_path.default.join(__dirname, "../../../resources/default_alias_map.json"),
      import_path.default.join(__dirname, "../../resources/default_alias_map.json")
    ].filter(Boolean);
    for (const p of candidates) {
      if (import_fs.default.existsSync(p)) {
        const raw = import_fs.default.readFileSync(p, "utf-8");
        const parsed = JSON.parse(raw);
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
function resolveAlias(userAliases, folderName) {
  if (userAliases[folderName]) return userAliases[folderName];
  const norm = normAliasKey(folderName);
  const defaults = loadDefaultAliasMap();
  return defaults[norm] || "";
}
function loadAliasMap(targetDir) {
  const aliasPath = import_path.default.join(targetDir, ALIAS_MAP_FILENAME);
  try {
    if (!import_fs.default.existsSync(aliasPath)) {
      return {};
    }
    const raw = import_fs.default.readFileSync(aliasPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      console.warn(`[ContextService] alias_map.json is not a valid object`);
      return {};
    }
    const result = {};
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
function parseTopics(topicString) {
  return topicString.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
}
async function expandFolderSemantics(folderName) {
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
      options: { temperature: 0.3 }
    });
    const req = import_http.default.request(
      {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: "/api/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout: EXPANSION_TIMEOUT_MS
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => body += chunk.toString());
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            const content = data.message?.content || "";
            const match = content.match(/\[[\s\S]*?\]/);
            if (match) {
              const keywords = JSON.parse(match[0]).filter((k) => typeof k === "string").map((k) => k.toLowerCase().trim()).slice(0, 10);
              if (keywords.length >= 5) {
                expansionCache[folderName] = keywords;
                console.log(`[ContextService] AI-expanded "${folderName}": [${keywords.join(", ")}]`);
                resolve(keywords);
                return;
              }
            }
          } catch {
          }
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
function extractKeywordsFromName(folderName) {
  const tokens = folderName.replace(/[-_]/g, " ").split(/\s+/).map((t) => t.toLowerCase()).filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  return tokens.length > 0 ? tokens : [folderName.toLowerCase()];
}
function isNoiseFolder(folderName) {
  return NOISE_FOLDERS.has(folderName.toLowerCase());
}
function extractKeywords(text, topN) {
  const rawTokens = text.replace(/[-_]/g, " ").split(/\s+/).filter((w) => w.length > 0);
  const processedTokens = [];
  for (const token of rawTokens) {
    const lower = token.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    if (token.length >= 2 && token === token.toUpperCase() && /^[A-Z]{2,}$/.test(token)) {
      processedTokens.push(token);
      continue;
    }
    const cleaned = lower.replace(/[^a-z]/g, "");
    if (cleaned.length >= 3 && !STOP_WORDS.has(cleaned)) {
      processedTokens.push(cleaned);
    }
  }
  const freq = {};
  for (const w of processedTokens) {
    const key = w.toLowerCase();
    freq[key] = (freq[key] || 0) + 1;
  }
  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, topN);
  return sorted.map(([word]) => {
    const originalAcronym = processedTokens.find(
      (t) => t.toLowerCase() === word && t === t.toUpperCase() && t.length >= 2
    );
    return originalAcronym || word;
  });
}
function readSampleText(filePath) {
  try {
    const ext = import_path.default.extname(filePath).toLowerCase();
    if (READABLE_EXTENSIONS.has(ext)) {
      const fd = import_fs.default.openSync(filePath, "r");
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      const bytesRead = import_fs.default.readSync(fd, buffer, 0, MAX_READ_BYTES, 0);
      import_fs.default.closeSync(fd);
      let text = buffer.slice(0, bytesRead).toString("utf-8");
      if ([".html", ".xml", ".vue", ".svelte"].includes(ext)) {
        text = text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ");
      }
      return text;
    }
    if (EXTRACTABLE_EXTENSIONS.has(ext)) {
      const { execSync } = require("child_process");
      if (ext === ".pdf") {
        try {
          return execSync(`pdftotext -l 3 -enc UTF-8 "${filePath}" -`, {
            encoding: "utf-8",
            timeout: 5e3,
            maxBuffer: 256 * 1024
          });
        } catch {
        }
      }
      if (ext === ".docx") {
        try {
          const raw = execSync(`unzip -p "${filePath}" "word/document.xml" 2>/dev/null`, {
            encoding: "utf-8",
            timeout: 5e3,
            maxBuffer: 256 * 1024
          });
          return raw.replace(/<[^>]+>/g, " ");
        } catch {
        }
      }
    }
  } catch {
  }
  return "";
}
function sampleFiles(dirPath, count) {
  try {
    const entries = import_fs.default.readdirSync(dirPath, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => import_path.default.join(dirPath, e.name));
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
function trimWords(text, max) {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  return words.slice(0, max).join(" ");
}
async function buildFolderFingerprints(targetDir) {
  if (targetDir === cacheTargetDir && Date.now() - cacheTimestamp < CACHE_TTL_MS && Object.keys(contextCache).length > 0) {
    return contextCache;
  }
  loadExpansionCache(targetDir);
  const aliasMap = loadAliasMap(targetDir);
  aliasCache = aliasMap;
  const result = {};
  try {
    const entries = import_fs.default.readdirSync(targetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const folderName = entry.name;
      const folderPath = import_path.default.join(targetDir, folderName);
      if (isNoiseFolder(folderName)) {
        result[folderName] = {
          keywords: [],
          coreTopics: [],
          sampleCount: 0,
          isAIExpanded: false,
          isNoiseFolder: true,
          updatedAt: Date.now()
        };
        console.log(`[ContextService] SKIPPED noise folder: "${folderName}"`);
        continue;
      }
      const files = sampleFiles(folderPath, SAMPLE_FILES_PER_FOLDER);
      let keywords = [];
      let isAIExpanded = false;
      if (files.length < SAMPLE_FILES_PER_FOLDER) {
        keywords = await expandFolderSemantics(folderName);
        isAIExpanded = true;
        const nameKeywords = extractKeywords(folderName.replace(/[-_]/g, " "), 5);
        for (const kw of nameKeywords) {
          if (!keywords.includes(kw.toLowerCase()) && !keywords.includes(kw)) {
            keywords.push(kw);
          }
        }
      } else {
        let combined = "";
        for (const filePath of files) {
          const text = readSampleText(filePath);
          combined += " " + trimWords(text, WORDS_PER_SAMPLE);
        }
        keywords = extractKeywords(combined, TOP_KEYWORDS);
      }
      const aliasString = resolveAlias(aliasMap, folderName);
      const coreTopics = aliasString ? parseTopics(aliasString) : [];
      result[folderName] = {
        keywords,
        coreTopics,
        sampleCount: files.length,
        isAIExpanded,
        isNoiseFolder: false,
        updatedAt: Date.now()
      };
      const status = isAIExpanded ? "AI-EXPANDED" : `${files.length} files`;
      const topicsLog = coreTopics.length > 0 ? ` | Core: [${coreTopics.join(", ")}]` : "";
      console.log(
        `[ContextService] "${folderName}" (${status}): [${keywords.slice(0, 5).join(", ")}]${topicsLog}`
      );
    }
  } catch (err) {
    console.error(`[ContextService] buildFolderFingerprints failed: ${err}`);
  }
  saveExpansionCache(targetDir);
  contextCache = result;
  cacheTargetDir = targetDir;
  cacheTimestamp = Date.now();
  return result;
}
async function getFolderContext(targetDir) {
  return buildFolderFingerprints(targetDir);
}
async function getFolderContextForPrompt(targetDir) {
  const fingerprints = await getFolderContext(targetDir);
  const result = {};
  for (const [folder, fp] of Object.entries(fingerprints)) {
    if (fp.isNoiseFolder) {
      result[folder] = {
        autoKeywords: "",
        coreTopics: "",
        description: "(noise folder - excluded from matching)",
        isNoiseFolder: true
      };
      continue;
    }
    const autoKeywords = fp.keywords.length > 0 ? fp.keywords.join(", ") : "(no keywords)";
    const coreTopics = fp.coreTopics.length > 0 ? fp.coreTopics.join(", ") : "";
    const lines = [`Folder: ${folder}`];
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
      isNoiseFolder: false
    };
  }
  return result;
}
async function getFolderContextFlat(targetDir) {
  const fingerprints = await getFolderContext(targetDir);
  const result = {};
  for (const [folder, fp] of Object.entries(fingerprints)) {
    if (fp.isNoiseFolder) {
      result[folder] = "(noise folder)";
      continue;
    }
    const parts = [];
    if (fp.keywords.length > 0) {
      parts.push(fp.keywords.join(", "));
    }
    if (fp.coreTopics.length > 0) {
      parts.push(`Core Topics: ${fp.coreTopics.join(", ")}`);
    }
    result[folder] = parts.length > 0 ? parts.join(" | ") : "(empty folder)";
  }
  return result;
}
function isNoiseFolderName(folderName) {
  return isNoiseFolder(folderName);
}
function getNoiseFolders() {
  return Array.from(NOISE_FOLDERS);
}
function invalidateCache() {
  cacheTimestamp = 0;
  contextCache = {};
  aliasCache = {};
  cacheTargetDir = "";
}
function getCachedFingerprints() {
  return { ...contextCache };
}
function getCachedAliases() {
  return { ...aliasCache };
}
function saveAliasMap(targetDir, aliases) {
  const aliasPath = import_path.default.join(targetDir, ALIAS_MAP_FILENAME);
  try {
    import_fs.default.writeFileSync(aliasPath, JSON.stringify(aliases, null, 2), "utf-8");
    aliasCache = aliases;
    console.log(`[ContextService] Saved alias_map.json with ${Object.keys(aliases).length} entries`);
    invalidateCache();
  } catch (err) {
    console.error(`[ContextService] Failed to save alias_map.json: ${err}`);
    throw err;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildFolderFingerprints,
  getCachedAliases,
  getCachedFingerprints,
  getFolderContext,
  getFolderContextFlat,
  getFolderContextForPrompt,
  getNoiseFolders,
  invalidateCache,
  isNoiseFolderName,
  resolveAlias,
  saveAliasMap
});
