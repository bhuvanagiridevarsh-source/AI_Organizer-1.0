/**
 * PromptReorgService.ts — Prompt-Based File Reorganization
 *
 * Pipeline:
 *   1. Scan directory → LeanManifest (lean by default, deep scan optional)
 *   2. Build structured prompt + call LlamaService → JSON ReorgPlan
 *   3. Generate per-file reasons via second lightweight AI call
 *   4. Build ReorgPreview from plan (full move list with paths, reasons, confidence)
 *   5. Execute approved moves via safeMoveFile (never deletes files)
 *   6. Persist to undo log for full reversibility
 *
 * Large folders (>500 files) are processed in batches of 200.
 */

import fs from "fs";
import path from "path";
import { app, BrowserWindow } from "electron";
import { getCachedManifest, invalidateCacheEntry, LeanFileInfo, LeanManifest } from "./ScanCacheService";
import { recordOperation } from "./UndoLogService";

const fsp = fs.promises;

// ── Types ──────────────────────────────────────────────────────

export interface FileInfo {
  currentPath: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  createdAt: string;
  modifiedAt: string;
  parentFolder: string;
}

export interface FileManifest {
  files: FileInfo[];
  totalCount: number;
  scannedAt: string;
  targetDirectory: string;
}

export interface ReorgPlan {
  folders: { name: string; subfolders: string[] }[];
  assignments: { fileIndex: number; destination: string; confidence?: number }[];
  unassigned: number[];
}

export interface FileMove {
  id: string;
  file: LeanFileInfo;
  from: string;
  to: string;
  approved: boolean;
  reason: string;
  confidence: number;
}

export interface FolderNode {
  name: string;
  children: FolderNode[];
  fileCount: number;
}

export interface ReorgPreview {
  id: string;
  prompt: string;
  targetDirectory: string;
  proposedStructure: FolderNode[];
  moves: FileMove[];
  unmoved: LeanFileInfo[];
  timestamp: string;
}

export interface ExecuteResult {
  moved: number;
  failed: { file: string; error: string }[];
  operationId: string;
  undoLogId: string;
}

export interface ReorgOperation {
  id: string;
  prompt: string;
  timestamp: string;
  fileCount: number;
  moves: { from: string; to: string }[];
  canUndo: boolean;
}

export interface ReorgHistory {
  operations: ReorgOperation[];
}

export interface AnalysisProgress {
  stage: "scanning" | "analyzing" | "generating_reasons" | "building_preview" | "done";
  pct: number;
  message: string;
  batchCurrent?: number;
  batchTotal?: number;
}

// ── Constants ──────────────────────────────────────────────────

const SKIP_NAMES = new Set([
  "node_modules", ".git", "__macosx", ".ds_store", ".spotlight-v100",
  ".trashes", ".fseventsd", "$recycle.bin", "system volume information",
  "thumbs.db", ".svn", "__pycache__", ".idea", ".vscode",
]);

const MAX_FILES = 500;
const BATCH_SIZE = 200;
const MAX_DEPTH = 2;
const AI_TIMEOUT_MS = 60_000;
const LOW_CONFIDENCE_THRESHOLD = 0.6;

// ── History ────────────────────────────────────────────────────

function historyPath(): string {
  return path.join(app.getPath("userData"), "prompt_reorg_history.json");
}

async function loadHistory(): Promise<ReorgHistory> {
  try {
    const raw = await fsp.readFile(historyPath(), "utf-8");
    return JSON.parse(raw) as ReorgHistory;
  } catch {
    return { operations: [] };
  }
}

async function saveHistory(h: ReorgHistory): Promise<void> {
  await fsp.writeFile(historyPath(), JSON.stringify(h, null, 2), "utf-8");
}

function sendProgress(progress: AnalysisProgress): void {
  const wins = BrowserWindow.getAllWindows();
  const win = wins.find((w) => !w.isDestroyed());
  if (win) win.webContents.send("prompt-reorg:progress", progress);
}

// ── Step 1: Directory Scan ─────────────────────────────────────

export async function scanDirectory(
  targetDir: string,
  maxDepth: number = MAX_DEPTH
): Promise<FileManifest> {
  const files: FileInfo[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || files.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.name.startsWith(".")) continue;
      if (SKIP_NAMES.has(entry.name.toLowerCase())) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(fullPath);
          files.push({
            currentPath: fullPath,
            fileName: entry.name,
            extension: path.extname(entry.name).toLowerCase() || "(none)",
            sizeBytes: stat.size,
            createdAt: stat.birthtime.toISOString(),
            modifiedAt: stat.mtime.toISOString(),
            parentFolder: path.basename(dir),
          });
        } catch {
          // unreadable file — skip silently
        }
      }
    }
  }

  await walk(targetDir, 1);
  return {
    files,
    totalCount: files.length,
    scannedAt: new Date().toISOString(),
    targetDirectory: targetDir,
  };
}

/** Lean scan with caching. Returns LeanManifest. */
export async function scanLean(targetDir: string): Promise<LeanManifest> {
  return getCachedManifest(targetDir, MAX_FILES);
}

// ── Step 2: Build Prompt ───────────────────────────────────────

function buildLeanPrompt(userPrompt: string, files: LeanFileInfo[], batchNote = ""): string {
  const list = files
    .map(
      (f) =>
        `${f.index}. "${f.name}" | ${f.ext} | ${f.modified} | ${f.sizeKB}KB | ${f.parent}`
    )
    .join("\n");

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

function parsePlan(raw: string, minIdx: number, maxIdx: number): ReorgPlan | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const plan = JSON.parse(match[0]) as ReorgPlan;
    if (!Array.isArray(plan.assignments) || !Array.isArray(plan.folders)) return null;

    const covered = new Set<number>();
    for (const a of plan.assignments) {
      if (typeof a.fileIndex === "number" && typeof a.destination === "string") {
        covered.add(a.fileIndex);
        if (typeof a.confidence !== "number") a.confidence = 0.85;
      }
    }
    for (const u of plan.unassigned ?? []) {
      if (typeof u === "number") covered.add(u);
    }

    const missing: number[] = [];
    for (let i = minIdx; i <= maxIdx; i++) {
      if (!covered.has(i)) missing.push(i);
    }
    plan.unassigned = [...(plan.unassigned ?? []), ...missing];
    return plan;
  } catch {
    return null;
  }
}

// ── Step 2b: Reason Generation ─────────────────────────────────

async function generateReasons(
  userPrompt: string,
  files: LeanFileInfo[],
  assignments: { fileIndex: number; destination: string }[]
): Promise<Record<number, string>> {
  try {
    const LlamaService = require("./LlamaService");
    if (!LlamaService.isReady()) return {};

    const assignedFiles = assignments
      .map((a) => {
        const f = files.find((fi) => fi.index === a.fileIndex);
        return f ? `${a.fileIndex}:"${f.name}"→"${a.destination}"` : null;
      })
      .filter(Boolean)
      .slice(0, 50); // Limit to 50 to keep prompt short

    if (assignedFiles.length === 0) return {};

    const reasonPrompt = `Based on the user's instruction "${userPrompt}", explain in ONE short phrase why each file was assigned to its folder. Focus on the specific attribute (filename, extension, date, keyword). Be brief.

Assignments: ${assignedFiles.join(", ")}

Reply ONLY as JSON: {"1":"reason","2":"reason",...}`;

    const raw: string = await LlamaService.generate(reasonPrompt, {
      maxTokens: 1024,
      temperature: 0.1,
      timeoutMs: 30_000,
    });

    const match = raw?.match(/\{[\s\S]*\}/);
    if (!match) return {};
    const parsed = JSON.parse(match[0]) as Record<string, string>;
    const result: Record<number, string> = {};
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

// ── Step 3: AI Analysis ────────────────────────────────────────

export async function analyzeWithAI(
  userPrompt: string,
  manifest: FileManifest
): Promise<{ plan: ReorgPlan | null; error?: string }> {
  try {
    const LlamaService = require("./LlamaService");
    if (!LlamaService.isReady()) {
      return { plan: null, error: "The AI engine is loading. Please wait a moment and try again." };
    }

    // Build lean list from FileManifest
    const files: LeanFileInfo[] = manifest.files.map((f, i) => ({
      index: i + 1,
      name: f.fileName,
      ext: f.extension,
      modified: f.modifiedAt.slice(0, 10),
      sizeKB: Math.round(f.sizeBytes / 1024),
      parent: f.parentFolder,
    }));

    if (files.length > BATCH_SIZE) {
      return analyzeBatched(userPrompt, files);
    }

    const raw: string = await LlamaService.generate(buildLeanPrompt(userPrompt, files), {
      maxTokens: 2048,
      temperature: 0.1,
      timeoutMs: AI_TIMEOUT_MS,
    });

    const plan = parsePlan(raw ?? "", 1, files.length);
    if (!plan) {
      const simple = `Organize ${files.length} files per: "${userPrompt}". Files: ${files.map((f) => `${f.index}:${f.name}`).join(", ")}. Reply ONLY JSON: {"folders":[{"name":"X","subfolders":[]}],"assignments":[{"fileIndex":1,"destination":"X","confidence":0.9}],"unassigned":[]}`;
      const raw2: string = await LlamaService.generate(simple, { maxTokens: 1024, temperature: 0.1, timeoutMs: 45_000 });
      const plan2 = parsePlan(raw2 ?? "", 1, files.length);
      if (!plan2) {
        return { plan: null, error: "Couldn't understand the organization plan. Try rephrasing your prompt." };
      }
      return { plan: plan2 };
    }
    return { plan };
  } catch (err: any) {
    console.error("[PromptReorg] AI error:", err?.message);
    return { plan: null, error: err?.message ?? "AI analysis failed." };
  }
}

async function analyzeBatched(
  userPrompt: string,
  files: LeanFileInfo[]
): Promise<{ plan: ReorgPlan | null; error?: string }> {
  const LlamaService = require("./LlamaService");
  const batches: LeanFileInfo[][] = [];
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    batches.push(files.slice(i, i + BATCH_SIZE));
  }

  const mergedPlan: ReorgPlan = { folders: [], assignments: [], unassigned: [] };
  const folderSet = new Map<string, string[]>();

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    sendProgress({
      stage: "analyzing",
      pct: Math.round(((bi + 1) / batches.length) * 60),
      message: `Analyzing batch ${bi + 1} of ${batches.length}...`,
      batchCurrent: bi + 1,
      batchTotal: batches.length,
    });

    const batchNote = ` (Batch ${bi + 1} of ${batches.length})`;
    const raw: string = await LlamaService.generate(
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
        const existing = folderSet.get(f.name)!;
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

// ── Step 4: Build Preview ──────────────────────────────────────

export async function buildPreviewLean(
  userPrompt: string,
  targetDirectory: string,
  manifest: LeanManifest,
  plan: ReorgPlan
): Promise<ReorgPreview> {
  const id = `pr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const moves: FileMove[] = [];
  const unmoved: LeanFileInfo[] = [];
  const unassignedSet = new Set<number>(plan.unassigned ?? []);

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

    const from = path.join(targetDirectory, file.parent !== path.basename(targetDirectory)
      ? file.parent
      : "", file.name);

    // Reconstruct original full path from lean info: assume file is in targetDirectory/parent/name
    const originalPath = path.join(
      targetDirectory,
      file.parent === path.basename(targetDirectory) ? "" : file.parent,
      file.name
    );

    moves.push({
      id: `m_${a.fileIndex}`,
      file,
      from: originalPath,
      to: path.join(targetDirectory, a.destination, file.name),
      approved: confidence >= LOW_CONFIDENCE_THRESHOLD,
      reason,
      confidence,
    });
  }

  for (const idx of plan.unassigned ?? []) {
    const f = manifest.files.find((fi) => fi.index === idx);
    if (f) unmoved.push(f);
  }

  // Build folder tree
  const treeMap = new Map<string, FolderNode>();
  for (const f of plan.folders) {
    treeMap.set(f.name, {
      name: f.name,
      children: (f.subfolders ?? []).map((s) => ({ name: s, children: [], fileCount: 0 })),
      fileCount: 0,
    });
  }

  for (const move of moves) {
    const rel = path.relative(targetDirectory, move.to);
    const parts = rel.split(path.sep);
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
    timestamp: new Date().toISOString(),
  };
}

/** Legacy buildPreview for compatibility with existing FileManifest callers. */
export function buildPreview(
  userPrompt: string,
  targetDirectory: string,
  manifest: FileManifest,
  plan: ReorgPlan
): ReorgPreview {
  const id = `pr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const moves: FileMove[] = [];
  const unmoved: LeanFileInfo[] = [];
  const unassignedSet = new Set<number>(plan.unassigned ?? []);

  for (const a of plan.assignments) {
    const idx = a.fileIndex - 1;
    if (idx < 0 || idx >= manifest.files.length) continue;
    if (unassignedSet.has(a.fileIndex)) continue;
    const file = manifest.files[idx];
    const confidence = typeof a.confidence === "number" ? a.confidence : 0.85;
    const lean: LeanFileInfo = {
      index: a.fileIndex,
      name: file.fileName,
      ext: file.extension,
      modified: file.modifiedAt.slice(0, 10),
      sizeKB: Math.round(file.sizeBytes / 1024),
      parent: file.parentFolder,
    };
    moves.push({
      id: `m_${a.fileIndex}`,
      file: lean,
      from: file.currentPath,
      to: path.join(targetDirectory, a.destination, file.fileName),
      approved: confidence >= LOW_CONFIDENCE_THRESHOLD,
      reason: `${file.extension} file sorted by type`,
      confidence,
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
        parent: file.parentFolder,
      });
    }
  }

  const treeMap = new Map<string, FolderNode>();
  for (const f of plan.folders) {
    treeMap.set(f.name, {
      name: f.name,
      children: (f.subfolders ?? []).map((s) => ({ name: s, children: [], fileCount: 0 })),
      fileCount: 0,
    });
  }
  for (const move of moves) {
    const rel = path.relative(targetDirectory, move.to);
    const parts = rel.split(path.sep);
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
    timestamp: new Date().toISOString(),
  };
}

// ── Step 5: Execute ────────────────────────────────────────────

export async function executePreview(preview: ReorgPreview): Promise<ExecuteResult> {
  const { safeMoveFile } = require("./fileService");
  const logMoves: { from: string; to: string; fileName: string; reason?: string }[] = [];
  const failed: { file: string; error: string }[] = [];

  for (const move of preview.moves.filter((m) => m.approved)) {
    try {
      const finalPath: string = await safeMoveFile(move.from, move.to);
      logMoves.push({ from: move.from, to: finalPath, fileName: move.file.name, reason: move.reason });
    } catch (err: any) {
      const msg =
        err?.code === "EACCES" ? "permission denied" :
        err?.code === "ENOENT" ? "file not found" :
        err?.message ?? "unknown error";
      failed.push({ file: move.file.name, error: msg });
      console.warn(`[PromptReorg] Move failed "${move.file.name}": ${msg}`);
    }
  }

  // Persist to legacy history (for backward compat)
  const history = await loadHistory();
  history.operations.unshift({
    id: preview.id,
    prompt: preview.prompt,
    timestamp: new Date().toISOString(),
    fileCount: logMoves.length,
    moves: logMoves.map((m) => ({ from: m.from, to: m.to })),
    canUndo: logMoves.length > 0,
  });
  history.operations = history.operations.slice(0, 50);
  await saveHistory(history);

  // Persist to new UndoLogService
  let undoLogId = "";
  if (logMoves.length > 0) {
    const folderCount = new Set(logMoves.map((m) => path.dirname(m.to))).size;
    undoLogId = await recordOperation(
      "prompt",
      logMoves.map((m) => ({
        fileName: m.fileName,
        fromPath: m.from,
        toPath: m.to,
        movedAt: new Date().toISOString(),
        reason: m.reason,
      })),
      `Organized ${logMoves.length} file${logMoves.length === 1 ? "" : "s"} into ${folderCount} folder${folderCount === 1 ? "" : "s"}`,
      preview.prompt
    );
  }

  // Invalidate scan cache for this directory
  await invalidateCacheEntry(preview.targetDirectory);

  return { moved: logMoves.length, failed, operationId: preview.id, undoLogId };
}

// ── Step 6: Undo ───────────────────────────────────────────────

export async function undoOperation(
  operationId: string
): Promise<{ restored: number; errors: string[] }> {
  const { safeMoveFile } = require("./fileService");
  const history = await loadHistory();
  const op = history.operations.find((o) => o.id === operationId);

  if (!op) return { restored: 0, errors: ["Operation not found"] };
  if (!op.canUndo) return { restored: 0, errors: ["This operation has already been undone"] };

  const errors: string[] = [];
  let restored = 0;

  for (const move of [...op.moves].reverse()) {
    try {
      await fsp.access(move.to);
      await safeMoveFile(move.to, move.from);
      restored++;
    } catch (err: any) {
      errors.push(`${path.basename(move.to)}: ${err?.message ?? "error"}`);
    }
  }

  const dirs = new Set<string>(op.moves.map((m) => path.dirname(m.to)));
  for (const dir of dirs) {
    try {
      const contents = await fsp.readdir(dir);
      if (contents.length === 0) await fsp.rmdir(dir);
    } catch { /* non-fatal */ }
  }

  op.canUndo = false;
  await saveHistory(history);
  return { restored, errors };
}

// ── History read ───────────────────────────────────────────────

export async function getHistory(): Promise<ReorgHistory> {
  return loadHistory();
}

// ── Full pipeline (lean, with progress events) ─────────────────

export async function runFullPipeline(
  userPrompt: string,
  targetDirectory: string,
  deepScan = false
): Promise<{ preview: ReorgPreview | null; error?: string }> {
  try {
    const LlamaService = require("./LlamaService");
    if (!LlamaService.isReady()) {
      return { preview: null, error: "The AI engine is loading. Please wait a moment and try again." };
    }

    sendProgress({ stage: "scanning", pct: 10, message: "Scanning files..." });
    const manifest = await getCachedManifest(targetDirectory, MAX_FILES);

    if (manifest.totalCount === 0) {
      return { preview: null, error: "No files found in this folder." };
    }

    sendProgress({ stage: "analyzing", pct: 25, message: `Analyzing ${manifest.totalCount} files with AI...` });

    let plan: ReorgPlan | null;
    if (manifest.files.length > BATCH_SIZE) {
      const result = await analyzeBatched(userPrompt, manifest.files);
      plan = result.plan;
      if (!plan) return { preview: null, error: result.error ?? "AI analysis failed." };
    } else {
      const promptStr = buildLeanPrompt(userPrompt, manifest.files);
      const raw: string = await LlamaService.generate(promptStr, {
        maxTokens: 2048,
        temperature: 0.1,
        timeoutMs: AI_TIMEOUT_MS,
      });
      plan = parsePlan(raw ?? "", 1, manifest.files.length);
      if (!plan) {
        return { preview: null, error: "Couldn't understand the organization plan. Try rephrasing your prompt." };
      }
    }

    sendProgress({ stage: "generating_reasons", pct: 65, message: "Generating explanations..." });
    const preview = await buildPreviewLean(userPrompt, targetDirectory, manifest, plan);
    return { preview };
  } catch (err: any) {
    console.error("[PromptReorg] Pipeline error:", err?.message);
    return { preview: null, error: err?.message ?? "An unexpected error occurred." };
  }
}
