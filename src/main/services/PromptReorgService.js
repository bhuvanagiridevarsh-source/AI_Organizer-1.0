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
var PromptReorgService_exports = {};
__export(PromptReorgService_exports, {
  analyzeWithAI: () => analyzeWithAI,
  buildPreview: () => buildPreview,
  buildPreviewLean: () => buildPreviewLean,
  executePreview: () => executePreview,
  getHistory: () => getHistory,
  runFullPipeline: () => runFullPipeline,
  scanDirectory: () => scanDirectory,
  scanLean: () => scanLean,
  undoOperation: () => undoOperation
});
module.exports = __toCommonJS(PromptReorgService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_electron = require("electron");
var import_ScanCacheService = require("./ScanCacheService");
var import_UndoLogService = require("./UndoLogService");
const fsp = import_fs.default.promises;
const SKIP_NAMES = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "__macosx",
  ".ds_store",
  ".spotlight-v100",
  ".trashes",
  ".fseventsd",
  "$recycle.bin",
  "system volume information",
  "thumbs.db",
  ".svn",
  "__pycache__",
  ".idea",
  ".vscode"
]);
const MAX_FILES = 500;
const BATCH_SIZE = 200;
const MAX_DEPTH = 2;
const AI_TIMEOUT_MS = 6e4;
const LOW_CONFIDENCE_THRESHOLD = 0.6;
function historyPath() {
  return import_path.default.join(import_electron.app.getPath("userData"), "prompt_reorg_history.json");
}
async function loadHistory() {
  try {
    const raw = await fsp.readFile(historyPath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { operations: [] };
  }
}
async function saveHistory(h) {
  await fsp.writeFile(historyPath(), JSON.stringify(h, null, 2), "utf-8");
}
function sendProgress(progress) {
  const wins = import_electron.BrowserWindow.getAllWindows();
  const win = wins.find((w) => !w.isDestroyed());
  if (win) win.webContents.send("prompt-reorg:progress", progress);
}
async function scanDirectory(targetDir, maxDepth = MAX_DEPTH) {
  const files = [];
  async function walk(dir, depth) {
    if (depth > maxDepth || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.name.startsWith(".")) continue;
      if (SKIP_NAMES.has(entry.name.toLowerCase())) continue;
      const fullPath = import_path.default.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(fullPath);
          files.push({
            currentPath: fullPath,
            fileName: entry.name,
            extension: import_path.default.extname(entry.name).toLowerCase() || "(none)",
            sizeBytes: stat.size,
            createdAt: stat.birthtime.toISOString(),
            modifiedAt: stat.mtime.toISOString(),
            parentFolder: import_path.default.basename(dir)
          });
        } catch {
        }
      }
    }
  }
  await walk(targetDir, 1);
  return {
    files,
    totalCount: files.length,
    scannedAt: (/* @__PURE__ */ new Date()).toISOString(),
    targetDirectory: targetDir
  };
}
async function scanLean(targetDir) {
  return (0, import_ScanCacheService.getCachedManifest)(targetDir, MAX_FILES);
}
function buildLeanPrompt(userPrompt, files, batchNote = "") {
  const list = files.map(
    (f) => `${f.index}. "${f.name}" | ${f.ext} | ${f.modified} | ${f.sizeKB}KB | ${f.parent}`
  ).join("\n");
  return `You are a file organization assistant.${batchNote}

USER'S INSTRUCTION: "${userPrompt}"

FILES TO ORGANIZE:
${list}

Respond ONLY with valid JSON, no other text, no markdown:

{
  "folders": [{"name": "FolderName", "subfolders": ["Sub1"]}],
  "assignments": [{"fileIndex": ${files[0]?.index ?? 1}, "destination": "FolderName", "confidence": 0.9}],
  "unassigned": []
}

Rules:
- Every index listed must appear in "assignments" OR "unassigned"
- confidence: 0.0-1.0 (how certain you are about this placement)
- Folder names: clean, descriptive, no special characters except spaces and hyphens
- Structure at most 2 levels deep
- Files that don't clearly fit: put in "unassigned"
- Never rename files`;
}
function parsePlan(raw, minIdx, maxIdx) {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const plan = JSON.parse(match[0]);
    if (!Array.isArray(plan.assignments) || !Array.isArray(plan.folders)) return null;
    const covered = /* @__PURE__ */ new Set();
    for (const a of plan.assignments) {
      if (typeof a.fileIndex === "number" && typeof a.destination === "string") {
        covered.add(a.fileIndex);
        if (typeof a.confidence !== "number") a.confidence = 0.85;
      }
    }
    for (const u of plan.unassigned ?? []) {
      if (typeof u === "number") covered.add(u);
    }
    const missing = [];
    for (let i = minIdx; i <= maxIdx; i++) {
      if (!covered.has(i)) missing.push(i);
    }
    plan.unassigned = [...plan.unassigned ?? [], ...missing];
    return plan;
  } catch {
    return null;
  }
}
async function generateReasons(userPrompt, files, assignments) {
  try {
    const LlamaService = require("./LlamaService");
    if (!LlamaService.isReady()) return {};
    const assignedFiles = assignments.map((a) => {
      const f = files.find((fi) => fi.index === a.fileIndex);
      return f ? `${a.fileIndex}:"${f.name}"\u2192"${a.destination}"` : null;
    }).filter(Boolean).slice(0, 50);
    if (assignedFiles.length === 0) return {};
    const reasonPrompt = `Based on the user's instruction "${userPrompt}", explain in ONE short phrase why each file was assigned to its folder. Focus on the specific attribute (filename, extension, date, keyword). Be brief.

Assignments: ${assignedFiles.join(", ")}

Reply ONLY as JSON: {"1":"reason","2":"reason",...}`;
    const raw = await LlamaService.generate(reasonPrompt, {
      maxTokens: 1024,
      temperature: 0.1,
      timeoutMs: 3e4
    });
    const match = raw?.match(/\{[\s\S]*\}/);
    if (!match) return {};
    const parsed = JSON.parse(match[0]);
    const result = {};
    for (const [k, v] of Object.entries(parsed)) {
      const idx = parseInt(k, 10);
      if (!isNaN(idx) && typeof v === "string") {
        result[idx] = v;
      }
    }
    return result;
  } catch {
    return {};
  }
}
async function analyzeWithAI(userPrompt, manifest) {
  try {
    const LlamaService = require("./LlamaService");
    if (!LlamaService.isReady()) {
      return { plan: null, error: "The AI engine is loading. Please wait a moment and try again." };
    }
    const files = manifest.files.map((f, i) => ({
      index: i + 1,
      name: f.fileName,
      ext: f.extension,
      modified: f.modifiedAt.slice(0, 10),
      sizeKB: Math.round(f.sizeBytes / 1024),
      parent: f.parentFolder
    }));
    if (files.length > BATCH_SIZE) {
      return analyzeBatched(userPrompt, files);
    }
    const raw = await LlamaService.generate(buildLeanPrompt(userPrompt, files), {
      maxTokens: 2048,
      temperature: 0.1,
      timeoutMs: AI_TIMEOUT_MS
    });
    const plan = parsePlan(raw ?? "", 1, files.length);
    if (!plan) {
      const simple = `Organize ${files.length} files per: "${userPrompt}". Files: ${files.map((f) => `${f.index}:${f.name}`).join(", ")}. Reply ONLY JSON: {"folders":[{"name":"X","subfolders":[]}],"assignments":[{"fileIndex":1,"destination":"X","confidence":0.9}],"unassigned":[]}`;
      const raw2 = await LlamaService.generate(simple, { maxTokens: 1024, temperature: 0.1, timeoutMs: 45e3 });
      const plan2 = parsePlan(raw2 ?? "", 1, files.length);
      if (!plan2) {
        return { plan: null, error: "Couldn't understand the organization plan. Try rephrasing your prompt." };
      }
      return { plan: plan2 };
    }
    return { plan };
  } catch (err) {
    console.error("[PromptReorg] AI error:", err?.message);
    return { plan: null, error: err?.message ?? "AI analysis failed." };
  }
}
async function analyzeBatched(userPrompt, files) {
  const LlamaService = require("./LlamaService");
  const batches = [];
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    batches.push(files.slice(i, i + BATCH_SIZE));
  }
  const mergedPlan = { folders: [], assignments: [], unassigned: [] };
  const folderSet = /* @__PURE__ */ new Map();
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    sendProgress({
      stage: "analyzing",
      pct: Math.round((bi + 1) / batches.length * 60),
      message: `Analyzing batch ${bi + 1} of ${batches.length}...`,
      batchCurrent: bi + 1,
      batchTotal: batches.length
    });
    const batchNote = ` (Batch ${bi + 1} of ${batches.length})`;
    const raw = await LlamaService.generate(
      buildLeanPrompt(userPrompt, batch, batchNote),
      { maxTokens: 2048, temperature: 0.1, timeoutMs: AI_TIMEOUT_MS }
    );
    const minIdx = batch[0].index;
    const maxIdx = batch[batch.length - 1].index;
    const plan = parsePlan(raw ?? "", minIdx, maxIdx);
    if (!plan) {
      mergedPlan.unassigned.push(...batch.map((f) => f.index));
      continue;
    }
    for (const f of plan.folders) {
      if (!folderSet.has(f.name)) {
        folderSet.set(f.name, f.subfolders ?? []);
      } else {
        const existing = folderSet.get(f.name);
        for (const sub of f.subfolders ?? []) {
          if (!existing.includes(sub)) existing.push(sub);
        }
      }
    }
    mergedPlan.assignments.push(...plan.assignments);
    mergedPlan.unassigned.push(...plan.unassigned);
  }
  mergedPlan.folders = Array.from(folderSet.entries()).map(([name, subfolders]) => ({ name, subfolders }));
  return { plan: mergedPlan };
}
async function buildPreviewLean(userPrompt, targetDirectory, manifest, plan) {
  const id = `pr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const moves = [];
  const unmoved = [];
  const unassignedSet = new Set(plan.unassigned ?? []);
  sendProgress({ stage: "generating_reasons", pct: 70, message: "Generating reasons..." });
  const reasons = await generateReasons(
    userPrompt,
    manifest.files,
    plan.assignments.filter((a) => !unassignedSet.has(a.fileIndex))
  );
  sendProgress({ stage: "building_preview", pct: 88, message: "Building preview..." });
  for (const a of plan.assignments) {
    if (unassignedSet.has(a.fileIndex)) continue;
    const file = manifest.files.find((f) => f.index === a.fileIndex);
    if (!file) continue;
    const confidence = typeof a.confidence === "number" ? a.confidence : 0.85;
    const reason = reasons[a.fileIndex] ?? `${file.ext} file sorted by extension`;
    const from = import_path.default.join(targetDirectory, file.parent !== import_path.default.basename(targetDirectory) ? file.parent : "", file.name);
    const originalPath = import_path.default.join(
      targetDirectory,
      file.parent === import_path.default.basename(targetDirectory) ? "" : file.parent,
      file.name
    );
    moves.push({
      id: `m_${a.fileIndex}`,
      file,
      from: originalPath,
      to: import_path.default.join(targetDirectory, a.destination, file.name),
      approved: confidence >= LOW_CONFIDENCE_THRESHOLD,
      reason,
      confidence
    });
  }
  for (const idx of plan.unassigned ?? []) {
    const f = manifest.files.find((fi) => fi.index === idx);
    if (f) unmoved.push(f);
  }
  const treeMap = /* @__PURE__ */ new Map();
  for (const f of plan.folders) {
    treeMap.set(f.name, {
      name: f.name,
      children: (f.subfolders ?? []).map((s) => ({ name: s, children: [], fileCount: 0 })),
      fileCount: 0
    });
  }
  for (const move of moves) {
    const rel = import_path.default.relative(targetDirectory, move.to);
    const parts = rel.split(import_path.default.sep);
    const top = treeMap.get(parts[0]);
    if (top) {
      if (parts.length > 2) {
        const sub = top.children.find((c) => c.name === parts[1]);
        if (sub) sub.fileCount++;
        else top.fileCount++;
      } else {
        top.fileCount++;
      }
    }
  }
  sendProgress({ stage: "done", pct: 100, message: "Preview ready" });
  return {
    id,
    prompt: userPrompt,
    targetDirectory,
    proposedStructure: Array.from(treeMap.values()),
    moves,
    unmoved,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function buildPreview(userPrompt, targetDirectory, manifest, plan) {
  const id = `pr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const moves = [];
  const unmoved = [];
  const unassignedSet = new Set(plan.unassigned ?? []);
  for (const a of plan.assignments) {
    const idx = a.fileIndex - 1;
    if (idx < 0 || idx >= manifest.files.length) continue;
    if (unassignedSet.has(a.fileIndex)) continue;
    const file = manifest.files[idx];
    const confidence = typeof a.confidence === "number" ? a.confidence : 0.85;
    const lean = {
      index: a.fileIndex,
      name: file.fileName,
      ext: file.extension,
      modified: file.modifiedAt.slice(0, 10),
      sizeKB: Math.round(file.sizeBytes / 1024),
      parent: file.parentFolder
    };
    moves.push({
      id: `m_${a.fileIndex}`,
      file: lean,
      from: file.currentPath,
      to: import_path.default.join(targetDirectory, a.destination, file.fileName),
      approved: confidence >= LOW_CONFIDENCE_THRESHOLD,
      reason: `${file.extension} file sorted by type`,
      confidence
    });
  }
  for (const idx of plan.unassigned ?? []) {
    const i = idx - 1;
    if (i >= 0 && i < manifest.files.length) {
      const file = manifest.files[i];
      unmoved.push({
        index: idx,
        name: file.fileName,
        ext: file.extension,
        modified: file.modifiedAt.slice(0, 10),
        sizeKB: Math.round(file.sizeBytes / 1024),
        parent: file.parentFolder
      });
    }
  }
  const treeMap = /* @__PURE__ */ new Map();
  for (const f of plan.folders) {
    treeMap.set(f.name, {
      name: f.name,
      children: (f.subfolders ?? []).map((s) => ({ name: s, children: [], fileCount: 0 })),
      fileCount: 0
    });
  }
  for (const move of moves) {
    const rel = import_path.default.relative(targetDirectory, move.to);
    const parts = rel.split(import_path.default.sep);
    const top = treeMap.get(parts[0]);
    if (top) {
      if (parts.length > 2) {
        const sub = top.children.find((c) => c.name === parts[1]);
        if (sub) sub.fileCount++;
        else top.fileCount++;
      } else {
        top.fileCount++;
      }
    }
  }
  return {
    id,
    prompt: userPrompt,
    targetDirectory,
    proposedStructure: Array.from(treeMap.values()),
    moves,
    unmoved,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function executePreview(preview) {
  const { safeMoveFile } = require("./fileService");
  const logMoves = [];
  const failed = [];
  for (const move of preview.moves.filter((m) => m.approved)) {
    try {
      const finalPath = await safeMoveFile(move.from, move.to);
      logMoves.push({ from: move.from, to: finalPath, fileName: move.file.name, reason: move.reason });
    } catch (err) {
      const msg = err?.code === "EACCES" ? "permission denied" : err?.code === "ENOENT" ? "file not found" : err?.message ?? "unknown error";
      failed.push({ file: move.file.name, error: msg });
      console.warn(`[PromptReorg] Move failed "${move.file.name}": ${msg}`);
    }
  }
  const history = await loadHistory();
  history.operations.unshift({
    id: preview.id,
    prompt: preview.prompt,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    fileCount: logMoves.length,
    moves: logMoves.map((m) => ({ from: m.from, to: m.to })),
    canUndo: logMoves.length > 0
  });
  history.operations = history.operations.slice(0, 50);
  await saveHistory(history);
  let undoLogId = "";
  if (logMoves.length > 0) {
    const folderCount = new Set(logMoves.map((m) => import_path.default.dirname(m.to))).size;
    undoLogId = await (0, import_UndoLogService.recordOperation)(
      "prompt",
      logMoves.map((m) => ({
        fileName: m.fileName,
        fromPath: m.from,
        toPath: m.to,
        movedAt: (/* @__PURE__ */ new Date()).toISOString(),
        reason: m.reason
      })),
      `Organized ${logMoves.length} file${logMoves.length === 1 ? "" : "s"} into ${folderCount} folder${folderCount === 1 ? "" : "s"}`,
      preview.prompt
    );
  }
  await (0, import_ScanCacheService.invalidateCacheEntry)(preview.targetDirectory);
  return { moved: logMoves.length, failed, operationId: preview.id, undoLogId };
}
async function undoOperation(operationId) {
  const { safeMoveFile } = require("./fileService");
  const history = await loadHistory();
  const op = history.operations.find((o) => o.id === operationId);
  if (!op) return { restored: 0, errors: ["Operation not found"] };
  if (!op.canUndo) return { restored: 0, errors: ["This operation has already been undone"] };
  const errors = [];
  let restored = 0;
  for (const move of [...op.moves].reverse()) {
    try {
      await fsp.access(move.to);
      await safeMoveFile(move.to, move.from);
      restored++;
    } catch (err) {
      errors.push(`${import_path.default.basename(move.to)}: ${err?.message ?? "error"}`);
    }
  }
  const dirs = new Set(op.moves.map((m) => import_path.default.dirname(m.to)));
  for (const dir of dirs) {
    try {
      const contents = await fsp.readdir(dir);
      if (contents.length === 0) await fsp.rmdir(dir);
    } catch {
    }
  }
  op.canUndo = false;
  await saveHistory(history);
  return { restored, errors };
}
async function getHistory() {
  return loadHistory();
}
async function runFullPipeline(userPrompt, targetDirectory, deepScan = false) {
  try {
    const LlamaService = require("./LlamaService");
    if (!LlamaService.isReady()) {
      return { preview: null, error: "The AI engine is loading. Please wait a moment and try again." };
    }
    sendProgress({ stage: "scanning", pct: 10, message: "Scanning files..." });
    const manifest = await (0, import_ScanCacheService.getCachedManifest)(targetDirectory, MAX_FILES);
    if (manifest.totalCount === 0) {
      return { preview: null, error: "No files found in this folder." };
    }
    sendProgress({ stage: "analyzing", pct: 25, message: `Analyzing ${manifest.totalCount} files with AI...` });
    let plan;
    if (manifest.files.length > BATCH_SIZE) {
      const result = await analyzeBatched(userPrompt, manifest.files);
      plan = result.plan;
      if (!plan) return { preview: null, error: result.error ?? "AI analysis failed." };
    } else {
      const promptStr = buildLeanPrompt(userPrompt, manifest.files);
      const raw = await LlamaService.generate(promptStr, {
        maxTokens: 2048,
        temperature: 0.1,
        timeoutMs: AI_TIMEOUT_MS
      });
      plan = parsePlan(raw ?? "", 1, manifest.files.length);
      if (!plan) {
        return { preview: null, error: "Couldn't understand the organization plan. Try rephrasing your prompt." };
      }
    }
    sendProgress({ stage: "generating_reasons", pct: 65, message: "Generating explanations..." });
    const preview = await buildPreviewLean(userPrompt, targetDirectory, manifest, plan);
    return { preview };
  } catch (err) {
    console.error("[PromptReorg] Pipeline error:", err?.message);
    return { preview: null, error: err?.message ?? "An unexpected error occurred." };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  analyzeWithAI,
  buildPreview,
  buildPreviewLean,
  executePreview,
  getHistory,
  runFullPipeline,
  scanDirectory,
  scanLean,
  undoOperation
});
