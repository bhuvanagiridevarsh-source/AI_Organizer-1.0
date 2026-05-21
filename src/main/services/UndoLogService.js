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
  await fsp.writeFile(logPath(), JSON.stringify(log, null, 2), "utf-8");
}
async function recordOperation(source, moves, description, prompt) {
  if (moves.length === 0) return "";
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
}
async function undoOperation(operationId) {
  const { safeMoveFile } = require("./fileService");
  const log = await loadLog();
  const op = log.operations.find((o) => o.id === operationId);
  if (!op) return { restored: 0, skipped: 0, errors: ["Operation not found"] };
  if (!op.canUndo) return { restored: 0, skipped: 0, errors: ["This operation has already been undone"] };
  const errors = [];
  let restored = 0;
  let skipped = 0;
  for (const move of [...op.moves].reverse()) {
    try {
      await fsp.access(move.toPath);
      const fromDir = import_path.default.dirname(move.fromPath);
      await fsp.mkdir(fromDir, { recursive: true });
      await safeMoveFile(move.toPath, move.fromPath);
      restored++;
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
  op.canUndo = false;
  op.undoneAt = (/* @__PURE__ */ new Date()).toISOString();
  await saveLog(log);
  return { restored, skipped, errors };
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
  await saveLog({ operations: [], maxOperations: DEFAULT_MAX_OPS });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  clearUndoLog,
  getOperation,
  getUndoLog,
  recordOperation,
  undoOperation
});
