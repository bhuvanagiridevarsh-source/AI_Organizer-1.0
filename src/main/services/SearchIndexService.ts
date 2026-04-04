/**
 * SearchIndexService.ts — Local file search index with hybrid semantic search.
 *
 * Maintains a JSON index of every file that has been organized by System Janitor.
 * Enables instant keyword search across all organized files without any external
 * service, API key, or new model download.
 *
 * Each entry stores: filename, folder, full path, text snippet, keywords, timestamp,
 * and an optional 768-dim embedding vector (nomic-embed-text via Ollama).
 *
 * SEARCH MODES:
 *   - searchFiles()       — synchronous TF-IDF keyword search (always works)
 *   - searchFilesHybrid() — async hybrid: 0.4×TF-IDF + 0.6×cosine similarity
 *                           Falls back to pure TF-IDF if Ollama is unavailable.
 *
 * TF-IDF weights:
 *   - Filename match: +10
 *   - Folder match: +8
 *   - Keyword overlap: +5
 *   - Snippet content match: +3
 */

import fs from "fs";
import path from "path";
import { app } from "electron";
import { getEmbedding, cosineSimilarity } from "./EmbeddingService";

// ── Types ──────────────────────────────────────────────────────────────────

export interface IndexEntry {
  filename: string;
  folder: string;
  fullPath: string;
  snippet: string;         // First 300 chars for display only
  fullText?: string;       // Complete extracted text (populated from v2+)
  keywords: string[];      // Tokens from filename + top words from fullText
  timestamp: number;
  embedding?: number[];    // 768-dim legacy single embedding (backward compat)
  embeddings?: number[][]; // Per-chunk embeddings for long documents
}

interface SearchIndex {
  entries: IndexEntry[];
  lastUpdated: number;
  fullTextVersion?: number; // 0/undefined = legacy; 2 = has fullText + chunk embeddings
}

export interface SearchResult {
  entry: IndexEntry;
  score: number;
  matchReason: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const INDEX_FILE = "search_index.json";
const MAX_ENTRIES = 2000;
const SNIPPET_LENGTH = 300;    // display only — fullText holds the complete content
const MAX_KEYWORDS = 20;
const CHUNK_WORDS = 500;       // words per embedding chunk
const CHUNK_OVERLAP = 50;      // overlapping words between consecutive chunks
const MAX_EMBED_CHUNKS = 20;   // cap per file to bound embedding cost
const FULL_TEXT_VERSION = 2;   // increment to trigger a one-time background re-index

// ── Noise words to strip when building keywords ─────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "was", "are", "be", "been", "have",
  "has", "had", "do", "does", "did", "will", "would", "could", "should",
  "may", "might", "shall", "can", "this", "that", "these", "those", "it",
  "its", "my", "your", "our", "their", "his", "her", "we", "you", "they",
  "i", "me", "him", "us", "them", "what", "which", "who", "how", "when",
  "where", "why", "not", "no", "if", "as", "so", "up", "out", "about",
]);

// ── Chunking ───────────────────────────────────────────────────────────────

/**
 * Split `text` into overlapping chunks for embedding long documents.
 * Short documents (≤ CHUNK_WORDS) are returned as a single-element array.
 */
function chunkText(text: string): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= CHUNK_WORDS) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + CHUNK_WORDS, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end === words.length) break;
    start += CHUNK_WORDS - CHUNK_OVERLAP;
  }

  return chunks;
}

// ── File I/O ───────────────────────────────────────────────────────────────

function getIndexPath(): string {
  return path.join(app.getPath("userData"), INDEX_FILE);
}

function loadIndex(): SearchIndex {
  try {
    const filePath = getIndexPath();
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.entries)) {
        return data as SearchIndex;
      }
    }
  } catch {
    // Corrupted — start fresh
  }
  return { entries: [], lastUpdated: Date.now() };
}

function saveIndex(index: SearchIndex): void {
  try {
    fs.writeFileSync(getIndexPath(), JSON.stringify(index, null, 2), "utf-8");
  } catch (err) {
    console.error(`[SearchIndex] Failed to save: ${err}`);
  }
}

// ── Keyword Extraction ─────────────────────────────────────────────────────

/**
 * Extract meaningful keywords from a filename and the full document text.
 * Strips extension, numbers-only tokens, and stop words.
 * Using fullText (not just a snippet) catches terms on any page of the document.
 */
function extractKeywords(filename: string, fullText: string): string[] {
  const nameTokens = path
    .basename(filename, path.extname(filename))
    .toLowerCase()
    .split(/[\s\-_.,()[\]]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));

  const textTokens = fullText
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));

  // Count token frequency across the whole document
  const freq = new Map<string, number>();
  for (const t of textTokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }

  // Top words by frequency (TF-style)
  const topWords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_KEYWORDS - nameTokens.length)
    .map(([t]) => t);

  return [...new Set([...nameTokens, ...topWords])].slice(0, MAX_KEYWORDS);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Add or update a file in the search index.
 * Called whenever a file is classified and organized.
 *
 * Async: also generates a semantic embedding via Ollama (nomic-embed-text).
 * If Ollama is unavailable the entry is saved without an embedding — keyword
 * search still works normally.
 */
export async function indexFile(
  filePath: string,
  folder: string,
  textContent: string
): Promise<void> {
  const index = loadIndex();
  const filename = path.basename(filePath);
  const fullText = textContent.replace(/\s+/g, " ").trim();
  const snippet = fullText.slice(0, SNIPPET_LENGTH);
  const keywords = extractKeywords(filename, fullText);

  // Remove existing entry for this path (de-duplicate on reclassify)
  const existing = index.entries.findIndex(
    (e) => e.fullPath === filePath || e.filename === filename
  );
  if (existing !== -1) {
    index.entries.splice(existing, 1);
  }

  // Generate embeddings — null when Ollama unavailable (graceful degradation)
  let embedding: number[] | undefined;
  let embeddings: number[][] | undefined;

  const wordCount = fullText.split(/\s+/).filter((w) => w.length > 0).length;
  if (wordCount > CHUNK_WORDS) {
    // Long document: embed each chunk so any part of the file can match a query
    const chunks = chunkText(fullText).slice(0, MAX_EMBED_CHUNKS);
    const chunkEmbeds = await Promise.all(
      chunks.map((chunk) => getEmbedding(`${filename} ${folder} ${chunk}`))
    );
    const valid = chunkEmbeds.filter((e): e is number[] => e !== null);
    if (valid.length > 0) {
      embeddings = valid;
      embedding = valid[0]; // keep single embedding for backward compat
    }
  } else {
    embedding = (await getEmbedding(`${filename} ${folder} ${fullText}`)) ?? undefined;
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
    embeddings,
  });

  // Keep within cap, removing oldest entries first
  if (index.entries.length > MAX_ENTRIES) {
    index.entries = index.entries
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_ENTRIES);
  }

  index.lastUpdated = Date.now();
  saveIndex(index);

  console.log(
    `[SearchIndex] Indexed: "${filename}" → "${folder}"${embedding ? " (+embedding)" : ""}`
  );
}

/**
 * Search the index for files matching a natural language query.
 * Returns up to `limit` results ranked by relevance score.
 */
export function searchFiles(query: string, limit = 8): SearchResult[] {
  const index = loadIndex();
  if (index.entries.length === 0) return [];

  // Tokenize query
  const queryTokens = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

  if (queryTokens.length === 0) return [];

  const results: SearchResult[] = [];

  for (const entry of index.entries) {
    let score = 0;
    const reasons: string[] = [];

    const filenameLower = entry.filename.toLowerCase();
    const folderLower = entry.folder.toLowerCase();
    const contentLower = (entry.fullText || entry.snippet).toLowerCase();

    for (const token of queryTokens) {
      // Filename exact substring match — highest value
      if (filenameLower.includes(token)) {
        score += 10;
        if (!reasons.includes("filename")) reasons.push("filename");
      }

      // Folder match — high value
      if (folderLower.includes(token)) {
        score += 8;
        if (!reasons.includes("folder")) reasons.push("folder");
      }

      // Keyword match — medium value
      if (entry.keywords.some((k) => k.includes(token) || token.includes(k))) {
        score += 5;
        if (!reasons.includes("keywords")) reasons.push("keywords");
      }

      // Full text content match — base value
      if (contentLower.includes(token)) {
        score += 3;
        if (!reasons.includes("content")) reasons.push("content");
      }
    }

    if (score > 0) {
      results.push({
        entry,
        score,
        matchReason: reasons.join(", "),
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Hybrid semantic search: 0.4 × TF-IDF + 0.6 × cosine similarity.
 *
 * Embeds the query via Ollama (nomic-embed-text) and blends keyword scores
 * with vector similarity. Falls back to pure TF-IDF when embeddings are
 * unavailable — never crashes.
 *
 * In hybrid mode all entries are considered (not just keyword-matching ones),
 * so semantically related files surface even with zero token overlap.
 */
export async function searchFilesHybrid(query: string, limit = 8): Promise<SearchResult[]> {
  const index = loadIndex();
  if (index.entries.length === 0) return [];

  // Tokenize query for TF-IDF component
  const queryTokens = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

  // Attempt to embed the query for semantic component (null = Ollama unavailable)
  const queryEmbedding = await getEmbedding(query);

  // ── Step 1: compute raw TF-IDF scores ─────────────────────────────────────
  type RawScore = { entry: IndexEntry; tfidf: number; reasons: string[] };
  const rawScores: RawScore[] = [];
  let maxTfidf = 0;

  for (const entry of index.entries) {
    let score = 0;
    const reasons: string[] = [];

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

  // ── Step 2: blend TF-IDF + cosine ─────────────────────────────────────────
  const results: SearchResult[] = [];

  for (const { entry, tfidf, reasons } of rawScores) {
    const matchReasonParts = [...reasons];
    let finalScore: number;

    if (queryEmbedding) {
      // Normalize TF-IDF to [0,1]
      const normalizedTfidf = maxTfidf > 0 ? tfidf / maxTfidf : 0;

      if (entry.embeddings && entry.embeddings.length > 0) {
        // Multi-chunk: take the best cosine score across all chunks
        // A query matches if ANY part of the document is relevant
        let maxCosine = -1;
        for (const chunkEmbed of entry.embeddings) {
          const cosine = cosineSimilarity(queryEmbedding, chunkEmbed);
          if (cosine > maxCosine) maxCosine = cosine;
        }
        const normalizedCosine = (maxCosine + 1) / 2;
        finalScore = 0.4 * normalizedTfidf + 0.6 * normalizedCosine;
        if (maxCosine > 0.4) matchReasonParts.push("semantic");
      } else if (entry.embedding) {
        // Legacy single embedding
        const cosine = cosineSimilarity(queryEmbedding, entry.embedding);
        const normalizedCosine = (cosine + 1) / 2;
        finalScore = 0.4 * normalizedTfidf + 0.6 * normalizedCosine;
        if (cosine > 0.4) matchReasonParts.push("semantic");
      } else {
        // Query embedded but entry has no embedding — normalized TF-IDF only
        finalScore = normalizedTfidf;
      }
    } else {
      // Embeddings unavailable — raw TF-IDF (same as searchFiles())
      finalScore = tfidf;
    }

    if (finalScore > 0) {
      results.push({
        entry,
        score: finalScore,
        matchReason: matchReasonParts.join(", ") || "semantic",
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Get all indexed entries — used to give the AI full context
 * about what folders exist and what files have been organized.
 */
export function getAllEntries(): IndexEntry[] {
  return loadIndex().entries;
}

/**
 * Get a summary of organized files grouped by folder.
 * Used to give the AI a high-level picture of the workspace.
 */
export function getFolderSummary(): Record<string, number> {
  const entries = getAllEntries();
  const summary: Record<string, number> = {};
  for (const entry of entries) {
    summary[entry.folder] = (summary[entry.folder] ?? 0) + 1;
  }
  return summary;
}

/**
 * Get the total number of indexed files.
 */
export function getIndexSize(): number {
  return loadIndex().entries.length;
}

// ── Bulk Reindex ───────────────────────────────────────────────────────────

// File extensions we know how to extract text from (or at least name-index)
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml",
  ".js", ".ts", ".py", ".html", ".htm", ".css",
  ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls",
  ".rtf", ".log", ".sh", ".bat",
]);

export interface ReindexProgress {
  scanned: number;
  indexed: number;
  skipped: number;
  errors: number;
  currentFile: string;
  done: boolean;
}

/**
 * Walk `rootDir`, extract text for each file (via the caller-supplied
 * extractText function), and upsert every file into the search index.
 *
 * `onProgress` is called after each file so the UI can show a progress bar.
 * Files already in the index are re-indexed (content may have changed).
 *
 * @param rootDir       The organized-files root (e.g. ~/Desktop/AI_SORTED_FILES)
 * @param extractText   Async function that returns extracted text for a file path
 * @param onProgress    Optional progress callback
 */
export async function bulkReindex(
  rootDir: string,
  extractText: (filePath: string) => Promise<string>,
  onProgress?: (p: ReindexProgress) => void
): Promise<ReindexProgress> {
  const progress: ReindexProgress = {
    scanned: 0, indexed: 0, skipped: 0, errors: 0,
    currentFile: "", done: false,
  };

  if (!fs.existsSync(rootDir)) {
    progress.done = true;
    return progress;
  }

  // Load index once up front — we'll batch-save at the end
  const index = loadIndex();

  // Collect all files recursively
  const allFiles: { filePath: string; folder: string }[] = [];

  function walk(dir: string, folderName: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Use the immediate child of rootDir as the "folder" label
        const label = folderName || entry.name;
        walk(fullPath, label);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
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
    progress.currentFile = path.basename(filePath);
    onProgress?.({ ...progress });

    try {
      const rawText = await extractText(filePath);
      const filename = path.basename(filePath);
      const fullText = (rawText || "").replace(/\s+/g, " ").trim();
      const snippet = fullText.slice(0, SNIPPET_LENGTH);
      const keywords = extractKeywords(filename, fullText);

      // Generate embeddings (null if Ollama unavailable)
      let embedding: number[] | undefined;
      let embeddings: number[][] | undefined;
      const wordCount = fullText.split(/\s+/).filter((w) => w.length > 0).length;
      if (wordCount > CHUNK_WORDS) {
        const chunks = chunkText(fullText).slice(0, MAX_EMBED_CHUNKS);
        const chunkEmbeds = await Promise.all(
          chunks.map((chunk) => getEmbedding(`${filename} ${folder} ${chunk}`))
        );
        const valid = chunkEmbeds.filter((e): e is number[] => e !== null);
        if (valid.length > 0) { embeddings = valid; embedding = valid[0]; }
      } else {
        embedding = (await getEmbedding(`${filename} ${folder} ${fullText}`)) ?? undefined;
      }

      // Remove any existing entry for this exact path
      const existingIdx = index.entries.findIndex((e) => e.fullPath === filePath);
      if (existingIdx !== -1) index.entries.splice(existingIdx, 1);

      index.entries.push({
        filename, folder, fullPath: filePath, snippet, fullText, keywords,
        timestamp: Date.now(), embedding, embeddings,
      });
      progress.indexed++;
    } catch {
      progress.errors++;
    }
  }

  // Trim to cap and save
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
    `[SearchIndex] Bulk reindex complete: ${progress.indexed} indexed, ` +
    `${progress.skipped} skipped, ${progress.errors} errors`
  );
  return progress;
}

// ── Background full-text upgrade ───────────────────────────────────────────

/**
 * Returns true if the index has entries that are missing the fullText field
 * (i.e. indexed with an older version of the app).
 */
export function needsFullTextUpgrade(): boolean {
  const index = loadIndex();
  if ((index.fullTextVersion ?? 0) >= FULL_TEXT_VERSION) return false;
  return index.entries.length > 0;
}

/**
 * Silently upgrade existing index entries to include fullText and chunk embeddings.
 *
 * Processes one file at a time with a 200ms gap to avoid UI freezing.
 * Calls onProgress(message, done, total) after each file.
 * Saves a version flag when complete so it never runs again unnecessarily.
 */
export async function upgradeIndexInBackground(
  extractFn: (filePath: string) => Promise<string>,
  onProgress?: (msg: string, done: number, total: number) => void
): Promise<void> {
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
      if (fs.existsSync(entry.fullPath)) {
        const rawText = await extractFn(entry.fullPath);
        const fullText = (rawText || "").replace(/\s+/g, " ").trim();
        entry.fullText = fullText;
        entry.keywords = extractKeywords(entry.filename, fullText);

        // Generate chunk embeddings
        const wordCount = fullText.split(/\s+/).filter((w) => w.length > 0).length;
        if (wordCount > CHUNK_WORDS) {
          const chunks = chunkText(fullText).slice(0, MAX_EMBED_CHUNKS);
          const chunkEmbeds = await Promise.all(
            chunks.map((chunk) => getEmbedding(`${entry.filename} ${entry.folder} ${chunk}`))
          );
          const valid = chunkEmbeds.filter((e): e is number[] => e !== null);
          if (valid.length > 0) { entry.embeddings = valid; entry.embedding = valid[0]; }
        } else if (fullText) {
          const emb = await getEmbedding(`${entry.filename} ${entry.folder} ${fullText}`);
          if (emb) entry.embedding = emb;
        }
      } else {
        // File was deleted — keep existing entry but mark fullText as empty string
        entry.fullText = entry.snippet;
      }
    } catch {
      // Non-fatal — keep the existing entry unchanged
    }

    done++;
    onProgress?.(`Upgrading search index...`, done, total);

    // Save every 10 files to avoid losing progress
    if (done % 10 === 0) saveIndex(index);

    // Yield to event loop — prevents UI freezing
    await new Promise((r) => setTimeout(r, 200));
  }

  index.fullTextVersion = FULL_TEXT_VERSION;
  saveIndex(index);
  onProgress?.(`Search index upgrade complete`, total, total);
  console.log(`[SearchIndex] Full-text upgrade complete: ${total} entries upgraded`);
}
