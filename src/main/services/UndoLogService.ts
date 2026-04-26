/**
 * UndoLogService.ts — Persistent undo log for ALL organize operations.
 *
 * Stores up to 50 operations (configurable). Each operation records
 * every file move so every single move can be individually reversed.
 *
 * Covers: prompt-based reorg, auto-sort (watcher), manual classification.
 */

import fs from "fs";
import path from "path";
import { app } from "electron";

const fsp = fs.promises;

// ── Types ──────────────────────────────────────────────────────

export type OperationSource = "prompt" | "auto-sort" | "classification" | "manual";

export interface FileMoveRecord {
  fileName: string;
  fromPath: string;
  toPath: string;
  movedAt: string;
  reason?: string;
}

export interface UndoOperation {
  id: string;
  timestamp: string;
  source: OperationSource;
  prompt?: string;
  description: string;
  moves: FileMoveRecord[];
  canUndo: boolean;
  undoneAt?: string;
}

interface UndoLog {
  operations: UndoOperation[];
  maxOperations: number;
}

// ── Constants ──────────────────────────────────────────────────

const DEFAULT_MAX_OPS = 50;

// ── Storage ────────────────────────────────────────────────────

function logPath(): string {
  return path.join(app.getPath("userData"), "undo_log.json");
}

async function loadLog(): Promise<UndoLog> {
  try {
    const raw = await fsp.readFile(logPath(), "utf-8");
    const parsed = JSON.parse(raw) as UndoLog;
    if (!Array.isArray(parsed.operations)) {
      return { operations: [], maxOperations: DEFAULT_MAX_OPS };
    }
    return parsed;
  } catch {
    return { operations: [], maxOperations: DEFAULT_MAX_OPS };
  }
}

async function saveLog(log: UndoLog): Promise<void> {
  await fsp.writeFile(logPath(), JSON.stringify(log, null, 2), "utf-8");
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Record a new organize operation. Returns the generated operation ID.
 */
export async function recordOperation(
  source: OperationSource,
  moves: FileMoveRecord[],
  description: string,
  prompt?: string
): Promise<string> {
  if (moves.length === 0) return "";
  const log = await loadLog();

  const id = `undo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const op: UndoOperation = {
    id,
    timestamp: new Date().toISOString(),
    source,
    prompt,
    description,
    moves,
    canUndo: true,
  };

  log.operations.unshift(op);
  log.operations = log.operations.slice(0, log.maxOperations || DEFAULT_MAX_OPS);
  await saveLog(log);
  return id;
}

/**
 * Undo an operation by ID.
 * Moves each file back to its original location.
 * Returns counts and errors.
 */
export async function undoOperation(
  operationId: string
): Promise<{ restored: number; skipped: number; errors: string[] }> {
  const { safeMoveFile } = require("./fileService");
  const log = await loadLog();
  const op = log.operations.find((o) => o.id === operationId);

  if (!op) return { restored: 0, skipped: 0, errors: ["Operation not found"] };
  if (!op.canUndo) return { restored: 0, skipped: 0, errors: ["This operation has already been undone"] };

  const errors: string[] = [];
  let restored = 0;
  let skipped = 0;

  for (const move of [...op.moves].reverse()) {
    try {
      await fsp.access(move.toPath);
      // Recreate fromPath directory if needed
      const fromDir = path.dirname(move.fromPath);
      await fsp.mkdir(fromDir, { recursive: true });
      await safeMoveFile(move.toPath, move.fromPath);
      restored++;
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        skipped++;
      } else {
        errors.push(`${move.fileName}: ${err?.message ?? "error"}`);
      }
    }
  }

  // Clean up empty folders that the operation created
  const createdDirs = new Set<string>(op.moves.map((m) => path.dirname(m.toPath)));
  for (const dir of createdDirs) {
    try {
      const contents = await fsp.readdir(dir);
      if (contents.length === 0) await fsp.rmdir(dir);
    } catch { /* non-fatal */ }
  }

  op.canUndo = false;
  op.undoneAt = new Date().toISOString();
  await saveLog(log);

  return { restored, skipped, errors };
}

/**
 * Get the full undo log.
 */
export async function getUndoLog(): Promise<UndoOperation[]> {
  const log = await loadLog();
  return log.operations;
}

/**
 * Get a single operation by ID.
 */
export async function getOperation(id: string): Promise<UndoOperation | null> {
  const log = await loadLog();
  return log.operations.find((o) => o.id === id) ?? null;
}

/**
 * Clear all undo history (for settings reset).
 */
export async function clearUndoLog(): Promise<void> {
  await saveLog({ operations: [], maxOperations: DEFAULT_MAX_OPS });
}
