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
var ChatService_exports = {};
__export(ChatService_exports, {
  handleChatMessage: () => handleChatMessage,
  quickSearch: () => quickSearch
});
module.exports = __toCommonJS(ChatService_exports);
var import_fs = __toESM(require("fs"));
var import_SearchIndexService = require("./SearchIndexService");
var import_TextExtractionService = require("./TextExtractionService");
var LlamaService = __toESM(require("./LlamaService"));
const MAX_CONTEXT_WORDS = 6e3;
async function readFullFileContent(entry) {
  try {
    if (!import_fs.default.existsSync(entry.fullPath)) {
      console.log(`[ChatService] File missing, using index: "${entry.filename}"`);
      return entry.fullText || entry.snippet || "";
    }
    const fullText = await (0, import_TextExtractionService.extractFullText)(entry.fullPath);
    if (fullText && fullText.length > 0) return fullText;
  } catch (err) {
    console.warn(`[ChatService] Full extraction failed for "${entry.filename}": ${err}`);
  }
  return entry.fullText || entry.snippet || "";
}
function chunkBySentences(text, targetWords) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const chunks = [];
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
function extractRelevantParagraphs(text, queryTokens, maxWords) {
  if (!text.trim()) return "";
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= maxWords) return text;
  const rawParas = text.split(/\n\n+/);
  const paragraphs = rawParas.length >= 3 ? rawParas : chunkBySentences(text, 100);
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
    const density = paraWords > 0 ? hits / Math.sqrt(paraWords) : 0;
    return { para, density, wordCount: paraWords };
  });
  const [first, ...rest] = scored;
  const ranked = [first, ...rest.sort((a, b) => b.density - a.density)];
  const selected = [];
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
async function getModel() {
  if (LlamaService.isReady()) return "ai-organizer-v2";
  return "ai-organizer-v2 (initializing...)";
  cachedModel = "llama3.2:1b";
  return cachedModel;
}
const FILE_LIST_PATTERNS = [
  /what\s+files?\s+(?:do\s+i\s+have|i\s+have)\s+(?:about|on|for|related\s+to)\s+(.+)/i,
  /(?:list|show(?:\s+me)?)\s+(?:all\s+|my\s+)?(?:files?|documents?)\s+(?:about|on|for|related\s+to)\s+(.+)/i,
  /do\s+i\s+have\s+(?:any\s+)?(?:files?|documents?)\s+(?:about|on|for|related\s+to)\s+(.+)/i,
  /(?:find|get)\s+(?:all\s+)?(?:my\s+)?(?:files?|documents?)\s+(?:about|on|for)\s+(.+)/i
];
function isFileListQuery(message) {
  return FILE_LIST_PATTERNS.some((re) => re.test(message.trim()));
}
function buildFileListResponse(files, query) {
  if (files.length === 0) {
    return `I searched your organized files and found **no files matching "${query}"**.

Try different keywords, or organize more files through the app.`;
  }
  const byFolder = /* @__PURE__ */ new Map();
  for (const { entry } of files) {
    const list = byFolder.get(entry.folder) ?? [];
    list.push(entry);
    byFolder.set(entry.folder, list);
  }
  const lines = [
    `I found **${files.length} file${files.length === 1 ? "" : "s"}** related to "${query}":
`
  ];
  for (const [folder, entries] of byFolder) {
    lines.push(`**${folder}/**`);
    for (const e of entries) {
      const kw = e.keywords.slice(0, 5).join(", ");
      const kwNote = kw ? ` \u2014 *${kw}*` : "";
      lines.push(`\u2022 ${e.filename}${kwNote}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
function buildSystemPrompt(relevantFiles, folderSummary, totalFiles, queryTokens = []) {
  if (totalFiles === 0) {
    return `You are a file assistant for System Janitor.
The search index is empty \u2014 no files have been organized yet.
Respond with EXACTLY this and nothing else:
"No files have been indexed yet. Organize some files through the app first \u2014 once you confirm moves, I can search and answer questions about them."`;
  }
  if (relevantFiles.length === 0) {
    return `You are a file assistant for System Janitor.
The user has ${totalFiles} organized files but none matched this query.
Respond with EXACTLY this and nothing else:
"I searched your ${totalFiles} organized files and found nothing matching that. Try different keywords, or organize more files through the app."`;
  }
  let wordsRemaining = MAX_CONTEXT_WORDS;
  const fileBlocks = [];
  for (const r of relevantFiles) {
    if (wordsRemaining <= 0) break;
    const raw = r.fullContent || r.entry.fullText || r.entry.snippet || "";
    if (!raw.trim()) {
      fileBlocks.push(`FILE: "${r.entry.filename}" (in ${r.entry.folder}/)
  Content: (no text extracted)`);
      continue;
    }
    const totalWords = raw.split(/\s+/).filter((w) => w.length > 0).length;
    let text;
    let truncNote = "";
    if (totalWords <= wordsRemaining) {
      text = raw;
      wordsRemaining -= totalWords;
    } else if (queryTokens.length > 0) {
      text = extractRelevantParagraphs(raw, queryTokens, wordsRemaining);
      const usedWords = text.split(/\s+/).filter((w) => w.length > 0).length;
      wordsRemaining -= usedWords;
      truncNote = ` [${totalWords} words total \u2014 showing most relevant sections]`;
    } else {
      const words = raw.split(/\s+/).filter((w) => w.length > 0);
      text = words.slice(0, wordsRemaining).join(" ");
      wordsRemaining -= Math.min(totalWords, wordsRemaining);
      truncNote = ` [truncated \u2014 ${totalWords} words total]`;
    }
    fileBlocks.push(
      `FILE: "${r.entry.filename}" (in ${r.entry.folder}/)
  Content: "${text}"${truncNote}`
    );
  }
  return `You are a file assistant for System Janitor. Answer the user's question by reading and synthesizing the actual file content below.

RULES \u2014 follow exactly:
1. Give a direct, useful answer using the real content from the files
2. Quote or reference specific details, facts, or text from the files
3. If multiple files are relevant, combine their content into one coherent answer
4. Do NOT list "Sources:" or filenames at the end \u2014 source citations are added automatically
5. Do NOT say "based on your files" or "according to the index" \u2014 just answer directly
6. Keep the answer focused and concise

FILE CONTENT FOR THIS QUERY:
${fileBlocks.join("\n\n")}`;
}
async function streamOllamaChat(messages, systemPrompt, window, eventPrefix) {
  if (!LlamaService.isReady()) {
    if (!window.isDestroyed()) {
      window.webContents.send(`${eventPrefix}:error`, "AI model is not loaded yet.");
      window.webContents.send(`${eventPrefix}:done`);
    }
    return;
  }
  try {
    const allMessages = [
      { role: "system", content: systemPrompt },
      ...messages
    ];
    await LlamaService.streamChat(allMessages, {
      temperature: 0.7,
      maxTokens: 1024,
      onToken: (token) => {
        if (!window.isDestroyed()) {
          window.webContents.send(`${eventPrefix}:token`, token);
        }
      },
      onDone: () => {
        if (!window.isDestroyed()) {
          window.webContents.send(`${eventPrefix}:done`);
        }
      }
    });
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (!window.isDestroyed()) {
      window.webContents.send(`${eventPrefix}:error`, msg);
      window.webContents.send(`${eventPrefix}:done`);
    }
  }
}
async function handleChatMessage(message, history, window) {
  const relevantFiles = await (0, import_SearchIndexService.searchFilesHybrid)(message, 8);
  const folderSummary = (0, import_SearchIndexService.getFolderSummary)();
  const totalFiles = (0, import_SearchIndexService.getIndexSize)();
  console.log(
    `[ChatService] Query: "${message.slice(0, 60)}" | Found ${relevantFiles.length} relevant files (hybrid) | Total indexed: ${totalFiles}`
  );
  if (isFileListQuery(message)) {
    const listText = buildFileListResponse(relevantFiles, message);
    if (!window.isDestroyed()) {
      window.webContents.send("chat:token", listText);
      window.webContents.send("chat:done");
    }
    if (relevantFiles.length > 0 && !window.isDestroyed()) {
      const sources = relevantFiles.map((r) => ({
        filename: r.entry.filename,
        folder: r.entry.folder,
        fullPath: r.entry.fullPath,
        snippet: r.entry.snippet
      }));
      window.webContents.send("chat:sources", sources, message);
    }
    return;
  }
  const enrichedFiles = [];
  const total = relevantFiles.length;
  for (let i = 0; i < total; i++) {
    const r = relevantFiles[i];
    if (!window.isDestroyed()) {
      window.webContents.send("chat:reading-files", {
        current: i + 1,
        total,
        filename: r.entry.filename
      });
    }
    const fullContent = await readFullFileContent(r.entry);
    enrichedFiles.push({ ...r, fullContent });
    const wordCount = fullContent.split(/\s+/).length;
    console.log(`[ChatService] Read full content: "${r.entry.filename}" \u2014 ${wordCount} words`);
  }
  const queryTokens = message.toLowerCase().split(/\W+/).filter((t) => t.length >= 3);
  const systemPrompt = buildSystemPrompt(enrichedFiles, folderSummary, totalFiles, queryTokens);
  const messages = [
    ...history,
    { role: "user", content: message }
  ];
  await streamOllamaChat(messages, systemPrompt, window, "chat");
  if (relevantFiles.length > 0 && !window.isDestroyed()) {
    const sources = relevantFiles.map((r) => ({
      filename: r.entry.filename,
      folder: r.entry.folder,
      fullPath: r.entry.fullPath,
      snippet: r.entry.snippet
      // Pass the query so the renderer knows what to highlight
    }));
    window.webContents.send("chat:sources", sources, message);
  }
}
function quickSearch(query) {
  return (0, import_SearchIndexService.searchFiles)(query, 5).map((r) => r.entry);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handleChatMessage,
  quickSearch
});
