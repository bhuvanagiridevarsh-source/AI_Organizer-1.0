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
var UndoLogService_exports = {};
__export(UndoLogService_exports, {
  clearUndoLog: () => clearUndoLog,
  getOperation: () => getOperation,
  getUndoLog: () => getUndoLog,
  recordOperation: () => recordOperation,
  undoOperation: () => undoOperation
});
module.exports = __toCommonJS(UndoLogService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_electron = require("electron");
const fsp = import_fs.default.promises;
const DEFAULT_MAX_OPS = 50;
let _queue = Promise.resolve();
function withLock(fn) {
  const run = _queue.then(fn, fn);
  _queue = run.then(
    () => void 0,
    () => void 0
  );
  return run;
}
function logPath() {
  return import_path.default.join(import_electron.app.getPath("userData"), "undo_log.json");
}
async function loadLog() {
  try {
    const raw = await fsp.readFile(logPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.operations)) {
      return { operations: [], maxOperations: DEFAULT_MAX_OPS };
    }
    return parsed;
  } catch {
    return { operations: [], maxOperations: DEFAULT_MAX_OPS };
  }
}
async function saveLog(log) {
  const finalPath = logPath();
  const dir = import_path.default.dirname(finalPath);
  const tmpPath = import_path.default.join(dir, `.undo_log.${process.pid}.${Date.now()}.tmp`);
  const data = JSON.stringify(log, null, 2);
  const fh = await fsp.open(tmpPath, "w");
  try {
    await fh.writeFile(data, "utf-8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmpPath, finalPath);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {
    });
    throw err;
  }
  try {
    const dh = await fsp.open(dir, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
  }
}
async function recordOperation(source, moves, description, prompt) {
  if (moves.length === 0) return "";
  return withLock(async () => {
    const log = await loadLog();
    const id = `undo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const op = {
      id,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      source,
      prompt,
      description,
      moves,
      canUndo: true
    };
    log.operations.unshift(op);
    log.operations = log.operations.slice(0, log.maxOperations || DEFAULT_MAX_OPS);
    await saveLog(log);
    return id;
  });
}
async function undoOperation(operationId) {
  const { safeMoveFile } = require("./fileService");
  return withLock(async () => {
    const log = await loadLog();
    const op = log.operations.find((o) => o.id === operationId);
    if (!op) return { restored: 0, skipped: 0, conflicts: 0, errors: ["Operation not found"] };
    if (!op.canUndo) {
      return { restored: 0, skipped: 0, conflicts: 0, errors: ["This operation has already been undone"] };
    }
    const errors = [];
    let restored = 0;
    let skipped = 0;
    let conflicts = 0;
    let anyRestored = false;
    for (const move of [...op.moves].reverse()) {
      try {
        await fsp.access(move.toPath);
        let originalOccupied = false;
        try {
          await fsp.access(move.fromPath);
          originalOccupied = true;
        } catch {
        }
        if (originalOccupied) {
          const { filesMatch } = require("./hashUtil");
          let same = false;
          try {
            same = await filesMatch(move.toPath, move.fromPath);
          } catch {
          }
          if (same) {
            skipped++;
            continue;
          }
          conflicts++;
          errors.push(
            `${move.fileName}: cannot restore \u2014 a different file already exists at ${move.fromPath}`
          );
          continue;
        }
        const fromDir = import_path.default.dirname(move.fromPath);
        await fsp.mkdir(fromDir, { recursive: true });
        const landed = await safeMoveFile(move.toPath, move.fromPath);
        if (landed !== move.fromPath) {
          conflicts++;
          errors.push(`${move.fileName}: restored to ${landed} (original name was taken)`);
        } else {
          restored++;
        }
        anyRestored = true;
      } catch (err) {
        if (err?.code === "ENOENT") {
          skipped++;
        } else {
          errors.push(`${move.fileName}: ${err?.message ?? "error"}`);
        }
      }
    }
    const createdDirs = new Set(op.moves.map((m) => import_path.default.dirname(m.toPath)));
    for (const dir of createdDirs) {
      try {
        const contents = await fsp.readdir(dir);
        if (contents.length === 0) await fsp.rmdir(dir);
      } catch {
      }
    }
    if (anyRestored || restored > 0) {
      op.canUndo = false;
      op.undoneAt = (/* @__PURE__ */ new Date()).toISOString();
      await saveLog(log);
    }
    return { restored, skipped, conflicts, errors };
  });
}
async function getUndoLog() {
  const log = await loadLog();
  return log.operations;
}
async function getOperation(id) {
  const log = await loadLog();
  return log.operations.find((o) => o.id === id) ?? null;
}
async function clearUndoLog() {
  return withLock(async () => {
    await saveLog({ operations: [], maxOperations: DEFAULT_MAX_OPS });
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  clearUndoLog,
  getOperation,
  getUndoLog,
  recordOperation,
  undoOperation
});
