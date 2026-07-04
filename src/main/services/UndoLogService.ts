/**
 * UndoLogService.ts — Persistent undo log for ALL organize operations.
 *
 * Stores up to 50 operations (configurable). Each operation records
 * every file move so every single move can be individually reversed.
 *
 * Covers: prompt-based reorg, auto-sort (watcher), manual classification.
 *
 * DURABILITY & CONCURRENCY:
 *   - All writes go through a temp-file + fsync + atomic rename, so a crash
 *     mid-write can never truncate or corrupt the log (a corrupt log would
 *     silently erase the user's entire undo history).
 *   - All read-modify-write cycles are serialized through an in-process mutex,
 *     so two concurrent recordOperation()/undoOperation() calls can't clobber
 *     each other's changes (last-writer-wins data loss).
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

// ── In-process mutex ───────────────────────────────────────────
// Serializes every load→modify→save cycle. Without this, two callers can both
// loadLog() the same snapshot and the second saveLog() silently drops the
// first's operation.
let _queue: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = _queue.then(fn, fn);
  // Keep the chain alive but swallow errors so one failure doesn't wedge the queue.
  _queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

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

/**
 * Atomic, durable write: serialize to a temp file in the same directory,
 * fsync it, then rename over the real file. rename() within a directory is
 * atomic, so readers see either the old file or the fully-written new one —
 * never a half-written mix.
 */
async function saveLog(log: UndoLog): Promise<void> {
  const finalPath = logPath();
  const dir = path.dirname(finalPath);
  const tmpPath = path.join(dir, `.undo_log.${process.pid}.${Date.now()}.tmp`);
  const data = JSON.stringify(log, null, 2);

  const fh = await fsp.open(tmpPath, "w");
  try {
    await fh.writeFile(data, "utf-8");
    await fh.sync(); // flush file contents to disk before the rename
  } finally {
    await fh.close();
  }

  try {
    await fsp.rename(tmpPath, finalPath);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }

  // Best-effort: flush the directory entry so the rename itself is durable.
  try {
    const dh = await fsp.open(dir, "r");
    try { await dh.sync(); } finally { await dh.close(); }
  } catch { /* non-fatal (e.g. Windows) */ }
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

  return withLock(async () => {
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
  });
}

/**
 * Undo an operation by ID.
 * Moves each file back to its original location.
 *
 * SAFETY: if the original path is now occupied by a DIFFERENT file, we do NOT
 * silently restore under a "_1" suffix (that would leave the file misplaced and
 * report success). We report it as a conflict so the user can resolve it.
 * Returns counts and errors.
 */
export async function undoOperation(
  operationId: string
): Promise<{ restored: number; skipped: number; conflicts: number; errors: string[] }> {
  const { safeMoveFile } = require("./fileService");

  return withLock(async () => {
    const log = await loadLog();
    const op = log.operations.find((o) => o.id === operationId);

    if (!op) return { restored: 0, skipped: 0, conflicts: 0, errors: ["Operation not found"] };
    if (!op.canUndo) {
      return { restored: 0, skipped: 0, conflicts: 0, errors: ["This operation has already been undone"] };
    }

    const errors: string[] = [];
    let restored = 0;
    let skipped = 0;
    let conflicts = 0;
    let anyRestored = false;

    for (const move of [...op.moves].reverse()) {
      try {
        // Source of the restore (where the file currently lives) must exist.
        await fsp.access(move.toPath);

        // If the ORIGINAL location is already occupied, decide carefully.
        let originalOccupied = false;
        try {
          await fsp.access(move.fromPath);
          originalOccupied = true;
        } catch { /* free — good */ }

        if (originalOccupied) {
          // Is it the same file already back home (e.g. a double-undo)? Then skip.
          const { filesMatch } = require("./hashUtil");
          let same = false;
          try { same = await filesMatch(move.toPath, move.fromPath); } catch { /* treat as different */ }
          if (same) {
            skipped++;
            continue;
          }
          // A different file sits at the original path — do NOT clobber and do
          // NOT silently rename. Surface it.
          conflicts++;
          errors.push(
            `${move.fileName}: cannot restore — a different file already exists at ${move.fromPath}`
          );
          continue;
        }

        const fromDir = path.dirname(move.fromPath);
        await fsp.mkdir(fromDir, { recursive: true });

        const landed = await safeMoveFile(move.toPath, move.fromPath);
        if (landed !== move.fromPath) {
          // safeMoveFile had to pick a different name — treat as a conflict,
          // not a clean restore, so the user knows it isn't exactly home.
          conflicts++;
          errors.push(`${move.fileName}: restored to ${landed} (original name was taken)`);
        } else {
          restored++;
        }
        anyRestored = true;
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          skipped++;
        } else {
          errors.push(`${move.fileName}: ${err?.message ?? "error"}`);
        }
      }
    }

    // Clean up empty folders that THIS operation created. Only remove a dir if
    // it is empty AND it was a move destination in this op (best-effort).
    const createdDirs = new Set<string>(op.moves.map((m) => path.dirname(m.toPath)));
    for (const dir of createdDirs) {
      try {
        const contents = await fsp.readdir(dir);
        if (contents.length === 0) await fsp.rmdir(dir);
      } catch { /* non-fatal: not empty, or not ours */ }
    }

    // Only mark as undone if we actually moved something back. If every move
    // failed/conflicted, leave canUndo=true so the user can retry after fixing.
    if (anyRestored || restored > 0) {
      op.canUndo = false;
      op.undoneAt = new Date().toISOString();
      await saveLog(log);
    }

    return { restored, skipped, conflicts, errors };
  });
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
  return withLock(async () => {
    await saveLog({ operations: [], maxOperations: DEFAULT_MAX_OPS });
  });
}
