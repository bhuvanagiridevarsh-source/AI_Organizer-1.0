/**
 * ChatService.ts — Conversational AI over organized files.
 *
 * Uses LlamaService (node-llama-cpp) to answer questions about organized files.
 * No Ollama required — the AI model runs directly inside the Electron process.
 *
 * Pipeline:
 *   1. Search the file index for files relevant to the user's message
 *   2. Build a context prompt with the top matching files + folder summary
 *   3. Stream the response token-by-token back to the renderer via IPC
 */

import fs from "fs";
import { BrowserWindow } from "electron";
import { searchFiles, searchFilesHybrid, getFolderSummary, getIndexSize, IndexEntry } from "./SearchIndexService";
import { extractFullText } from "./TextExtractionService";
import * as LlamaService from "./LlamaService";

/**
 * Maximum words of file content to feed into the LLM context per query.
 * With num_ctx = 8192 (~6K usable after system prompt + conversation),
 * ~6000 words fills the context more fully for richer answers.
 */
const MAX_CONTEXT_WORDS = 6000;

/**
 * Read the full text of a file for chat retrieval.
 * Fallback order: live file extraction → index fullText → snippet.
 */
async function readFullFileContent(entry: IndexEntry): Promise<string> {
  try {
    if (!fs.existsSync(entry.fullPath)) {
      console.log(`[ChatService] File missing, using index: "${entry.filename}"`);
      return entry.fullText || entry.snippet || "";
    }
    const fullText = await extractFullText(entry.fullPath);
    if (fullText && fullText.length > 0) return fullText;
  } catch (err) {
    console.warn(`[ChatService] Full extraction failed for "${entry.filename}": ${err}`);
  }
  return entry.fullText || entry.snippet || "";
}

/**
 * Split text into sentence-based windows of ~targetWords each.
 * Used as a fallback when the text has no double-newline paragraph breaks.
 */
function chunkBySentences(text: string, targetWords: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const chunks: string[] = [];
  let cur = "";
  let curWords = 0;
  for (const sent of sentences) {
    const sw = sent.split(/\s+/).length;
    if (curWords + sw > targetWords && cur) {
      chunks.push(cur.trim());
      cur = sent;
      curWords = sw;
    } else {
      cur += sent;
      curWords += sw;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length > 0 ? chunks : [text];
}

/**
 * Extract the most query-relevant paragraphs from a large file, up to maxWords.
 *
 * Strategy:
 *  1. Split into paragraphs (double-newline) or sentence windows if no breaks.
 *  2. Score each paragraph by query-term density (matches per √words).
 *  3. Always include the opening paragraph (sets context), then fill remaining
 *     budget with the highest-scoring paragraphs from anywhere in the document.
 *
 * This means a query like "interest rate on my lease" will surface paragraph 12
 * of a 40-page PDF rather than always showing the first page.
 */
function extractRelevantParagraphs(
  text: string,
  queryTokens: string[],
  maxWords: number
): string {
  if (!text.trim()) return "";
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= maxWords) return text;

  // Build paragraphs
  const rawParas = text.split(/\n\n+/);
  const paragraphs = rawParas.length >= 3 ? rawParas : chunkBySentences(text, 100);

  // Score paragraphs by query-term density
  const scored = paragraphs.map((para) => {
    const paraLower = para.toLowerCase();
    let hits = 0;
    for (const token of queryTokens) {
      let idx = 0;
      while ((idx = paraLower.indexOf(token, idx)) !== -1) {
        hits++;
        idx += token.length;
      }
    }
    const paraWords = para.split(/\s+/).filter((w) => w.length > 0).length;
    // Density = hits / √words — favours dense matches over long tangential ones
    const density = paraWords > 0 ? hits / Math.sqrt(paraWords) : 0;
    return { para, density, wordCount: paraWords };
  });

  // Always keep the first paragraph for context; sort the rest by relevance
  const [first, ...rest] = scored;
  const ranked = [first, ...rest.sort((a, b) => b.density - a.density)];

  const selected: string[] = [];
  let remaining = maxWords;

  for (const { para, wordCount } of ranked) {
    if (remaining <= 0) break;
    if (wordCount <= remaining) {
      selected.push(para);
      remaining -= wordCount;
    } else {
      selected.push(para.split(/\s+/).slice(0, remaining).join(" "));
      remaining = 0;
    }
  }

  const note = remaining === 0 ? " [most relevant sections shown]" : "";
  return selected.join("\n\n") + note;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// ── Model Resolution ───────────────────────────────────────────────────────
// (kept as a lightweight stub so callers don't break; LlamaService manages the model)

async function getModel(): Promise<string> {
  // LlamaService owns the loaded model — we just confirm it's ready
  if (LlamaService.isReady()) return "ai-organizer-v2";
  // Fall back label if not yet initialized
  return "ai-organizer-v2 (initializing...)";
  cachedModel = "llama3.2:1b";
  return cachedModel;
}

// ── File-list query detection ──────────────────────────────────────────────

/**
 * Patterns that indicate the user wants a structured list of matching files
 * rather than an AI-synthesized answer.  Examples:
 *   "what files do I have about photosynthesis"
 *   "list my documents on APUSH"
 *   "show me all files for pre-calc"
 *   "do I have any files about contracts"
 */
const FILE_LIST_PATTERNS = [
  /what\s+files?\s+(?:do\s+i\s+have|i\s+have)\s+(?:about|on|for|related\s+to)\s+(.+)/i,
  /(?:list|show(?:\s+me)?)\s+(?:all\s+|my\s+)?(?:files?|documents?)\s+(?:about|on|for|related\s+to)\s+(.+)/i,
  /do\s+i\s+have\s+(?:any\s+)?(?:files?|documents?)\s+(?:about|on|for|related\s+to)\s+(.+)/i,
  /(?:find|get)\s+(?:all\s+)?(?:my\s+)?(?:files?|documents?)\s+(?:about|on|for)\s+(.+)/i,
];

function isFileListQuery(message: string): boolean {
  return FILE_LIST_PATTERNS.some((re) => re.test(message.trim()));
}

/**
 * Build a structured markdown file-list response without calling the LLM.
 * Groups results by folder and shows filename + top keywords.
 */
function buildFileListResponse(
  files: { entry: IndexEntry; score: number }[],
  query: string
): string {
  if (files.length === 0) {
    return `I searched your organized files and found **no files matching "${query}"**.\n\nTry different keywords, or organize more files through the app.`;
  }

  // Group by folder
  const byFolder = new Map<string, IndexEntry[]>();
  for (const { entry } of files) {
    const list = byFolder.get(entry.folder) ?? [];
    list.push(entry);
    byFolder.set(entry.folder, list);
  }

  const lines: string[] = [
    `I found **${files.length} file${files.length === 1 ? "" : "s"}** related to "${query}":\n`,
  ];

  for (const [folder, entries] of byFolder) {
    lines.push(`**${folder}/**`);
    for (const e of entries) {
      // Show up to 5 keywords as a hint
      const kw = e.keywords.slice(0, 5).join(", ");
      const kwNote = kw ? ` — *${kw}*` : "";
      lines.push(`• ${e.filename}${kwNote}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Context Builder ────────────────────────────────────────────────────────

/**
 * Build the system prompt that tells the AI about the user's file workspace
 * and the specific files most relevant to their question.
 */
function buildSystemPrompt(
  relevantFiles: { entry: IndexEntry; score: number; matchReason: string; fullContent?: string }[],
  folderSummary: Record<string, number>,
  totalFiles: number,
  queryTokens: string[] = []
): string {
  // ── Empty index ───────────────────────────────────────────────────────
  if (totalFiles === 0) {
    return `You are a file assistant for System Janitor.
The search index is empty — no files have been organized yet.
Respond with EXACTLY this and nothing else:
"No files have been indexed yet. Organize some files through the app first — once you confirm moves, I can search and answer questions about them."`;
  }

  // ── No matches ────────────────────────────────────────────────────────
  if (relevantFiles.length === 0) {
    return `You are a file assistant for System Janitor.
The user has ${totalFiles} organized files but none matched this query.
Respond with EXACTLY this and nothing else:
"I searched your ${totalFiles} organized files and found nothing matching that. Try different keywords, or organize more files through the app."`;
  }

  // ── Files found: build rich content context with word budget ──────────
  let wordsRemaining = MAX_CONTEXT_WORDS;
  const fileBlocks: string[] = [];

  for (const r of relevantFiles) {
    if (wordsRemaining <= 0) break;

    const raw = r.fullContent || r.entry.fullText || r.entry.snippet || "";
    if (!raw.trim()) {
      fileBlocks.push(`FILE: "${r.entry.filename}" (in ${r.entry.folder}/)\n  Content: (no text extracted)`);
      continue;
    }

    const totalWords = raw.split(/\s+/).filter((w) => w.length > 0).length;
    let text: string;
    let truncNote = "";

    if (totalWords <= wordsRemaining) {
      // File fits entirely — use it all
      text = raw;
      wordsRemaining -= totalWords;
    } else if (queryTokens.length > 0) {
      // Use relevance-guided paragraph extraction — surfaces the answer even if
      // it's on page 12 of a long document rather than always taking the start
      text = extractRelevantParagraphs(raw, queryTokens, wordsRemaining);
      const usedWords = text.split(/\s+/).filter((w) => w.length > 0).length;
      wordsRemaining -= usedWords;
      truncNote = ` [${totalWords} words total — showing most relevant sections]`;
    } else {
      // No query tokens to guide extraction — fall back to first N words
      const words = raw.split(/\s+/).filter((w) => w.length > 0);
      text = words.slice(0, wordsRemaining).join(" ");
      wordsRemaining -= Math.min(totalWords, wordsRemaining);
      truncNote = ` [truncated — ${totalWords} words total]`;
    }

    fileBlocks.push(
      `FILE: "${r.entry.filename}" (in ${r.entry.folder}/)\n  Content: "${text}"${truncNote}`
    );
  }

  return `You are a file assistant for System Janitor. Answer the user's question by reading and synthesizing the actual file content below.

RULES — follow exactly:
1. Give a direct, useful answer using the real content from the files
2. Quote or reference specific details, facts, or text from the files
3. If multiple files are relevant, combine their content into one coherent answer
4. Do NOT list "Sources:" or filenames at the end — source citations are added automatically
5. Do NOT say "based on your files" or "according to the index" — just answer directly
6. Keep the answer focused and concise

FILE CONTENT FOR THIS QUERY:
${fileBlocks.join("\n\n")}`;
}

// ── Streaming Ollama Chat ──────────────────────────────────────────────────

/**
 * Stream a chat response from Ollama, sending tokens to the renderer
 * via IPC as they arrive. Sends a final "done" signal when complete.
 *
 * @param messages    Full conversation history (user + assistant turns)
 * @param systemPrompt  Context about the user's files
 * @param window      BrowserWindow to send tokens to
 * @param eventPrefix IPC event name prefix (tokens sent as `${eventPrefix}:token`)
 */
/**
 * Stream a chat response via LlamaService (node-llama-cpp).
 * Tokens are sent live to the renderer via IPC as they are generated.
 */
async function streamOllamaChat(
  messages: ChatMessage[],
  systemPrompt: string,
  window: BrowserWindow,
  eventPrefix: string
): Promise<void> {
  if (!LlamaService.isReady()) {
    if (!window.isDestroyed()) {
      window.webContents.send(`${eventPrefix}:error`, "AI model is not loaded yet.");
      window.webContents.send(`${eventPrefix}:done`);
    }
    return;
  }

  try {
    const allMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    await LlamaService.streamChat(allMessages, {
      temperature: 0.7,
      maxTokens:   1024,
      onToken: (token: string) => {
        if (!window.isDestroyed()) {
          window.webContents.send(`${eventPrefix}:token`, token);
        }
      },
      onDone: () => {
        if (!window.isDestroyed()) {
          window.webContents.send(`${eventPrefix}:done`);
        }
      },
    });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (!window.isDestroyed()) {
      window.webContents.send(`${eventPrefix}:error`, msg);
      window.webContents.send(`${eventPrefix}:done`);
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Handle a chat message: search the file index, build context,
 * and stream the AI response back to the renderer.
 *
 * @param message     The user's latest message
 * @param history     Previous conversation turns (for multi-turn context)
 * @param window      The BrowserWindow to stream tokens to
 */
export async function handleChatMessage(
  message: string,
  history: ChatMessage[],
  window: BrowserWindow
): Promise<void> {
  // Use hybrid semantic search (TF-IDF + cosine); falls back to keyword-only
  // if Ollama embeddings are unavailable — never crashes.
  const relevantFiles = await searchFilesHybrid(message, 8);
  const folderSummary = getFolderSummary();
  const totalFiles = getIndexSize();

  console.log(
    `[ChatService] Query: "${message.slice(0, 60)}" | ` +
      `Found ${relevantFiles.length} relevant files (hybrid) | ` +
      `Total indexed: ${totalFiles}`
  );

  // ── Structured file-list shortcut ──────────────────────────────────────
  // For "what files do I have about X" queries, skip the LLM and return a
  // formatted list directly.  Much faster and more precise than AI synthesis.
  if (isFileListQuery(message)) {
    const listText = buildFileListResponse(relevantFiles, message);
    // Stream the list as fake tokens so the existing renderer pipeline works
    if (!window.isDestroyed()) {
      window.webContents.send("chat:token", listText);
      window.webContents.send("chat:done");
    }
    // Still send sources so the renderer can render clickable chips
    if (relevantFiles.length > 0 && !window.isDestroyed()) {
      const sources = relevantFiles.map((r) => ({
        filename: r.entry.filename,
        folder: r.entry.folder,
        fullPath: r.entry.fullPath,
        snippet: r.entry.snippet,
      }));
      window.webContents.send("chat:sources", sources, message);
    }
    return;
  }

  // ── Read FULL file content for each match (not just the 800-char snippet) ──
  const enrichedFiles: { entry: IndexEntry; score: number; matchReason: string; fullContent?: string }[] = [];
  const total = relevantFiles.length;
  for (let i = 0; i < total; i++) {
    const r = relevantFiles[i];
    // Emit progress so the UI can show a loading bar
    if (!window.isDestroyed()) {
      window.webContents.send("chat:reading-files", {
        current: i + 1,
        total,
        filename: r.entry.filename,
      });
    }
    const fullContent = await readFullFileContent(r.entry);
    enrichedFiles.push({ ...r, fullContent });
    const wordCount = fullContent.split(/\s+/).length;
    console.log(`[ChatService] Read full content: "${r.entry.filename}" — ${wordCount} words`);
  }

  // Tokenize the query for relevance-guided paragraph extraction
  const queryTokens = message
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length >= 3);

  // Build the context-aware system prompt with full file content
  const systemPrompt = buildSystemPrompt(enrichedFiles, folderSummary, totalFiles, queryTokens);

  // Add the user's new message to history
  const messages: ChatMessage[] = [
    ...history,
    { role: "user", content: message },
  ];

  // Stream response tokens to renderer
  await streamOllamaChat(messages, systemPrompt, window, "chat");

  // After streaming is done, send source file data so the renderer
  // can render clickable source chips with highlighted text previews
  if (relevantFiles.length > 0 && !window.isDestroyed()) {
    const sources = relevantFiles.map((r) => ({
      filename: r.entry.filename,
      folder: r.entry.folder,
      fullPath: r.entry.fullPath,
      snippet: r.entry.snippet,
      // Pass the query so the renderer knows what to highlight
    }));
    window.webContents.send("chat:sources", sources, message);
  }
}

/**
 * Quick search without AI — returns raw file matches instantly.
 * Used for the search-as-you-type feature in the chat input.
 * Uses synchronous TF-IDF for immediate response (no async delay).
 */
export function quickSearch(query: string): IndexEntry[] {
  return searchFiles(query, 5).map((r) => r.entry);
}
