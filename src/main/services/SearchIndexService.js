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
var SearchIndexService_exports = {};
__export(SearchIndexService_exports, {
  bulkReindex: () => bulkReindex,
  getAllEntries: () => getAllEntries,
  getFolderSummary: () => getFolderSummary,
  getIndexSize: () => getIndexSize,
  indexFile: () => indexFile,
  needsFullTextUpgrade: () => needsFullTextUpgrade,
  searchFiles: () => searchFiles,
  searchFilesHybrid: () => searchFilesHybrid,
  upgradeIndexInBackground: () => upgradeIndexInBackground
});
module.exports = __toCommonJS(SearchIndexService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_electron = require("electron");
var import_EmbeddingService = require("./EmbeddingService");
const INDEX_FILE = "search_index.json";
const MAX_ENTRIES = 2e3;
const SNIPPET_LENGTH = 300;
const MAX_KEYWORDS = 20;
const CHUNK_WORDS = 500;
const CHUNK_OVERLAP = 50;
const MAX_EMBED_CHUNKS = 20;
const FULL_TEXT_VERSION = 2;
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
  "was",
  "are",
  "be",
  "been",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "my",
  "your",
  "our",
  "their",
  "his",
  "her",
  "we",
  "you",
  "they",
  "i",
  "me",
  "him",
  "us",
  "them",
  "what",
  "which",
  "who",
  "how",
  "when",
  "where",
  "why",
  "not",
  "no",
  "if",
  "as",
  "so",
  "up",
  "out",
  "about"
]);
function chunkText(text) {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= CHUNK_WORDS) return [text];
  const chunks = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + CHUNK_WORDS, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end === words.length) break;
    start += CHUNK_WORDS - CHUNK_OVERLAP;
  }
  return chunks;
}
function getIndexPath() {
  return import_path.default.join(import_electron.app.getPath("userData"), INDEX_FILE);
}
function loadIndex() {
  try {
    const filePath = getIndexPath();
    if (import_fs.default.existsSync(filePath)) {
      const raw = import_fs.default.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.entries)) {
        return data;
      }
    }
  } catch {
  }
  return { entries: [], lastUpdated: Date.now() };
}
function saveIndex(index) {
  try {
    import_fs.default.writeFileSync(getIndexPath(), JSON.stringify(index, null, 2), "utf-8");
  } catch (err) {
    console.error(`[SearchIndex] Failed to save: ${err}`);
  }
}
function extractKeywords(filename, fullText) {
  const nameTokens = import_path.default.basename(filename, import_path.default.extname(filename)).toLowerCase().split(/[\s\-_.,()[\]]+/).filter((t) => t.length >= 2 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
  const textTokens = fullText.toLowerCase().split(/\W+/).filter((t) => t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
  const freq = /* @__PURE__ */ new Map();
  for (const t of textTokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  const topWords = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_KEYWORDS - nameTokens.length).map(([t]) => t);
  return [.../* @__PURE__ */ new Set([...nameTokens, ...topWords])].slice(0, MAX_KEYWORDS);
}
async function indexFile(filePath, folder, textContent) {
  const index = loadIndex();
  const filename = import_path.default.basename(filePath);
  const fullText = textContent.replace(/\s+/g, " ").trim();
  const snippet = fullText.slice(0, SNIPPET_LENGTH);
  const keywords = extractKeywords(filename, fullText);
  const existing = index.entries.findIndex(
    (e) => e.fullPath === filePath || e.filename === filename
  );
  if (existing !== -1) {
    index.entries.splice(existing, 1);
  }
  let embedding;
  let embeddings;
  const wordCount = fullText.split(/\s+/).filter((w) => w.length > 0).length;
  if (wordCount > CHUNK_WORDS) {
    const chunks = chunkText(fullText).slice(0, MAX_EMBED_CHUNKS);
    const chunkEmbeds = await Promise.all(
      chunks.map((chunk) => (0, import_EmbeddingService.getEmbedding)(`${filename} ${folder} ${chunk}`))
    );
    const valid = chunkEmbeds.filter((e) => e !== null);
    if (valid.length > 0) {
      embeddings = valid;
      embedding = valid[0];
    }
  } else {
    embedding = await (0, import_EmbeddingService.getEmbedding)(`${filename} ${folder} ${fullText}`) ?? void 0;
  }
  index.entries.push({
    filename,
    folder,
    fullPath: filePath,
    snippet,
    fullText,
    keywords,
    timestamp: Date.now(),
    embedding,
    embeddings
  });
  if (index.entries.length > MAX_ENTRIES) {
    index.entries = index.entries.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_ENTRIES);
  }
  index.lastUpdated = Date.now();
  saveIndex(index);
  console.log(
    `[SearchIndex] Indexed: "${filename}" \u2192 "${folder}"${embedding ? " (+embedding)" : ""}`
  );
}
function searchFiles(query, limit = 8) {
  const index = loadIndex();
  if (index.entries.length === 0) return [];
  const queryTokens = query.toLowerCase().split(/\W+/).filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  if (queryTokens.length === 0) return [];
  const results = [];
  for (const entry of index.entries) {
    let score = 0;
    const reasons = [];
    const filenameLower = entry.filename.toLowerCase();
    const folderLower = entry.folder.toLowerCase();
    const contentLower = (entry.fullText || entry.snippet).toLowerCase();
    for (const token of queryTokens) {
      if (filenameLower.includes(token)) {
        score += 10;
        if (!reasons.includes("filename")) reasons.push("filename");
      }
      if (folderLower.includes(token)) {
        score += 8;
        if (!reasons.includes("folder")) reasons.push("folder");
      }
      if (entry.keywords.some((k) => k.includes(token) || token.includes(k))) {
        score += 5;
        if (!reasons.includes("keywords")) reasons.push("keywords");
      }
      if (contentLower.includes(token)) {
        score += 3;
        if (!reasons.includes("content")) reasons.push("content");
      }
    }
    if (score > 0) {
      results.push({
        entry,
        score,
        matchReason: reasons.join(", ")
      });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
async function searchFilesHybrid(query, limit = 8) {
  const index = loadIndex();
  if (index.entries.length === 0) return [];
  const queryTokens = query.toLowerCase().split(/\W+/).filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  const queryEmbedding = await (0, import_EmbeddingService.getEmbedding)(query);
  const rawScores = [];
  let maxTfidf = 0;
  for (const entry of index.entries) {
    let score = 0;
    const reasons = [];
    if (queryTokens.length > 0) {
      const filenameLower = entry.filename.toLowerCase();
      const folderLower = entry.folder.toLowerCase();
      const contentLower = (entry.fullText || entry.snippet).toLowerCase();
      for (const token of queryTokens) {
        if (filenameLower.includes(token)) {
          score += 10;
          if (!reasons.includes("filename")) reasons.push("filename");
        }
        if (folderLower.includes(token)) {
          score += 8;
          if (!reasons.includes("folder")) reasons.push("folder");
        }
        if (entry.keywords.some((k) => k.includes(token) || token.includes(k))) {
          score += 5;
          if (!reasons.includes("keywords")) reasons.push("keywords");
        }
        if (contentLower.includes(token)) {
          score += 3;
          if (!reasons.includes("content")) reasons.push("content");
        }
      }
    }
    rawScores.push({ entry, tfidf: score, reasons });
    if (score > maxTfidf) maxTfidf = score;
  }
  const results = [];
  for (const { entry, tfidf, reasons } of rawScores) {
    const matchReasonParts = [...reasons];
    let finalScore;
    if (queryEmbedding) {
      const normalizedTfidf = maxTfidf > 0 ? tfidf / maxTfidf : 0;
      if (entry.embeddings && entry.embeddings.length > 0) {
        let maxCosine = -1;
        for (const chunkEmbed of entry.embeddings) {
          const cosine = (0, import_EmbeddingService.cosineSimilarity)(queryEmbedding, chunkEmbed);
          if (cosine > maxCosine) maxCosine = cosine;
        }
        const normalizedCosine = (maxCosine + 1) / 2;
        finalScore = 0.4 * normalizedTfidf + 0.6 * normalizedCosine;
        if (maxCosine > 0.4) matchReasonParts.push("semantic");
      } else if (entry.embedding) {
        const cosine = (0, import_EmbeddingService.cosineSimilarity)(queryEmbedding, entry.embedding);
        const normalizedCosine = (cosine + 1) / 2;
        finalScore = 0.4 * normalizedTfidf + 0.6 * normalizedCosine;
        if (cosine > 0.4) matchReasonParts.push("semantic");
      } else {
        finalScore = normalizedTfidf;
      }
    } else {
      finalScore = tfidf;
    }
    if (finalScore > 0) {
      results.push({
        entry,
        score: finalScore,
        matchReason: matchReasonParts.join(", ") || "semantic"
      });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
function getAllEntries() {
  return loadIndex().entries;
}
function getFolderSummary() {
  const entries = getAllEntries();
  const summary = {};
  for (const entry of entries) {
    summary[entry.folder] = (summary[entry.folder] ?? 0) + 1;
  }
  return summary;
}
function getIndexSize() {
  return loadIndex().entries.length;
}
const TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".js",
  ".ts",
  ".py",
  ".html",
  ".htm",
  ".css",
  ".pdf",
  ".docx",
  ".doc",
  ".pptx",
  ".ppt",
  ".xlsx",
  ".xls",
  ".rtf",
  ".log",
  ".sh",
  ".bat"
]);
async function bulkReindex(rootDir, extractText, onProgress) {
  const progress = {
    scanned: 0,
    indexed: 0,
    skipped: 0,
    errors: 0,
    currentFile: "",
    done: false
  };
  if (!import_fs.default.existsSync(rootDir)) {
    progress.done = true;
    return progress;
  }
  const index = loadIndex();
  const allFiles = [];
  function walk(dir, folderName) {
    let entries;
    try {
      entries = import_fs.default.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = import_path.default.join(dir, entry.name);
      if (entry.isDirectory()) {
        const label = folderName || entry.name;
        walk(fullPath, label);
      } else if (entry.isFile()) {
        const ext = import_path.default.extname(entry.name).toLowerCase();
        if (TEXT_EXTENSIONS.has(ext)) {
          allFiles.push({ filePath: fullPath, folder: folderName || "Unsorted" });
        } else {
          progress.skipped++;
        }
      }
    }
  }
  walk(rootDir, "");
  progress.scanned = allFiles.length;
  for (const { filePath, folder } of allFiles) {
    progress.currentFile = import_path.default.basename(filePath);
    onProgress?.({ ...progress });
    try {
      const rawText = await extractText(filePath);
      const filename = import_path.default.basename(filePath);
      const fullText = (rawText || "").replace(/\s+/g, " ").trim();
      const snippet = fullText.slice(0, SNIPPET_LENGTH);
      const keywords = extractKeywords(filename, fullText);
      let embedding;
      let embeddings;
      const wordCount = fullText.split(/\s+/).filter((w) => w.length > 0).length;
      if (wordCount > CHUNK_WORDS) {
        const chunks = chunkText(fullText).slice(0, MAX_EMBED_CHUNKS);
        const chunkEmbeds = await Promise.all(
          chunks.map((chunk) => (0, import_EmbeddingService.getEmbedding)(`${filename} ${folder} ${chunk}`))
        );
        const valid = chunkEmbeds.filter((e) => e !== null);
        if (valid.length > 0) {
          embeddings = valid;
          embedding = valid[0];
        }
      } else {
        embedding = await (0, import_EmbeddingService.getEmbedding)(`${filename} ${folder} ${fullText}`) ?? void 0;
      }
      const existingIdx = index.entries.findIndex((e) => e.fullPath === filePath);
      if (existingIdx !== -1) index.entries.splice(existingIdx, 1);
      index.entries.push({
        filename,
        folder,
        fullPath: filePath,
        snippet,
        fullText,
        keywords,
        timestamp: Date.now(),
        embedding,
        embeddings
      });
      progress.indexed++;
    } catch {
      progress.errors++;
    }
  }
  if (index.entries.length > MAX_ENTRIES) {
    index.entries = index.entries.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_ENTRIES);
  }
  index.lastUpdated = Date.now();
  index.fullTextVersion = FULL_TEXT_VERSION;
  saveIndex(index);
  progress.done = true;
  progress.currentFile = "";
  onProgress?.({ ...progress });
  console.log(
    `[SearchIndex] Bulk reindex complete: ${progress.indexed} indexed, ${progress.skipped} skipped, ${progress.errors} errors`
  );
  return progress;
}
function needsFullTextUpgrade() {
  const index = loadIndex();
  if ((index.fullTextVersion ?? 0) >= FULL_TEXT_VERSION) return false;
  return index.entries.length > 0;
}
async function upgradeIndexInBackground(extractFn, onProgress) {
  const index = loadIndex();
  if ((index.fullTextVersion ?? 0) >= FULL_TEXT_VERSION) return;
  const toUpgrade = index.entries.filter((e) => !e.fullText);
  if (toUpgrade.length === 0) {
    index.fullTextVersion = FULL_TEXT_VERSION;
    saveIndex(index);
    return;
  }
  const total = toUpgrade.length;
  let done = 0;
  for (const entry of toUpgrade) {
    onProgress?.(`Upgrading search index...`, done, total);
    try {
      if (import_fs.default.existsSync(entry.fullPath)) {
        const rawText = await extractFn(entry.fullPath);
        const fullText = (rawText || "").replace(/\s+/g, " ").trim();
        entry.fullText = fullText;
        entry.keywords = extractKeywords(entry.filename, fullText);
        const wordCount = fullText.split(/\s+/).filter((w) => w.length > 0).length;
        if (wordCount > CHUNK_WORDS) {
          const chunks = chunkText(fullText).slice(0, MAX_EMBED_CHUNKS);
          const chunkEmbeds = await Promise.all(
            chunks.map((chunk) => (0, import_EmbeddingService.getEmbedding)(`${entry.filename} ${entry.folder} ${chunk}`))
          );
          const valid = chunkEmbeds.filter((e) => e !== null);
          if (valid.length > 0) {
            entry.embeddings = valid;
            entry.embedding = valid[0];
          }
        } else if (fullText) {
          const emb = await (0, import_EmbeddingService.getEmbedding)(`${entry.filename} ${entry.folder} ${fullText}`);
          if (emb) entry.embedding = emb;
        }
      } else {
        entry.fullText = entry.snippet;
      }
    } catch {
    }
    done++;
    onProgress?.(`Upgrading search index...`, done, total);
    if (done % 10 === 0) saveIndex(index);
    await new Promise((r) => setTimeout(r, 200));
  }
  index.fullTextVersion = FULL_TEXT_VERSION;
  saveIndex(index);
  onProgress?.(`Search index upgrade complete`, total, total);
  console.log(`[SearchIndex] Full-text upgrade complete: ${total} entries upgraded`);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  bulkReindex,
  getAllEntries,
  getFolderSummary,
  getIndexSize,
  indexFile,
  needsFullTextUpgrade,
  searchFiles,
  searchFilesHybrid,
  upgradeIndexInBackground
});
