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
var ConsistencyService_exports = {};
__export(ConsistencyService_exports, {
  extractClassKey: () => extractClassKey,
  getHistoryBoost: () => getHistoryBoost
});
module.exports = __toCommonJS(ConsistencyService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_electron = require("electron");
const MEMORY_FILE = "user_memory.json";
const NOISE_TOKENS = /* @__PURE__ */ new Set([
  // ── Assignment-type noise ──────────────────────────────────────────────
  "hw",
  "homework",
  "notes",
  "note",
  "test",
  "quiz",
  "chapter",
  "ch",
  "unit",
  "un",
  "practice",
  "prac",
  "exam",
  "final",
  "midterm",
  "review",
  "worksheet",
  "ws",
  "study",
  "guide",
  "lab",
  "assignment",
  "asgmt",
  "project",
  "proj",
  "reading",
  "rd",
  "lecture",
  "lec",
  "problem",
  "set",
  "ps",
  "discussion",
  "disc",
  "section",
  "sec",
  "part",
  "pt",
  "due",
  "draft",
  "submission",
  "sub",
  "copy",
  "backup",
  "version",
  "ver",
  // ── Extra academic noise (new) ────────────────────────────────────────
  "answers",
  "answer",
  "key",
  "solutions",
  "solution",
  "handout",
  "packet",
  "worksheet",
  "activity",
  "extra",
  "credit",
  "ec",
  "bonus",
  "makeup",
  "retake",
  "redo",
  "graded",
  "returned",
  "feedback",
  "outline",
  "overview",
  "summary",
  "template",
  "example",
  "sample",
  "blank",
  "completed",
  "corrected",
  "annotated",
  "marked",
  // ── File version/revision noise (new) ────────────────────────────────
  "v1",
  "v2",
  "v3",
  "v4",
  "v5",
  "vf",
  "vfinal",
  "rev",
  "revision",
  "updated",
  "new",
  "old",
  "latest",
  "current",
  "previous",
  "original",
  "final",
  "draft",
  "wip",
  // ── Month / day names ─────────────────────────────────────────────────
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
  "january",
  "february",
  "march",
  "april",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
  // ── Semester / quarter (new) ──────────────────────────────────────────
  "fall",
  "spring",
  "summer",
  "winter",
  "semester",
  "sem",
  "quarter",
  "qtr",
  "trimester",
  "q1",
  "q2",
  "q3",
  "q4",
  // ── Common English stop words ─────────────────────────────────────────
  "the",
  "and",
  "for",
  "with",
  "of",
  "in",
  "to",
  "a",
  "an",
  "is",
  "was",
  "are",
  "my",
  "this",
  "that",
  "it",
  "its",
  "from",
  "by",
  "at",
  "on",
  "up",
  "as",
  // ── Generic document/file words (new) ────────────────────────────────
  "document",
  "doc",
  "file",
  "page",
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "scan",
  "scanned",
  "copy",
  "print",
  "misc",
  "miscellaneous",
  "general",
  "other",
  "info",
  "information",
  "data",
  // ── Generic memo/brief/report words ──────────────────────────────────
  "memo",
  "brief",
  "report",
  "letter",
  "email",
  "message",
  "form",
  "sheet",
  "chart",
  "table",
  "list",
  "log",
  "overview",
  "intro",
  "introduction",
  "conclusion"
]);
const MIN_HITS = 2;
const MIN_AGREEMENT = 0.65;
function getMemoryPath() {
  return import_path.default.join(import_electron.app.getPath("userData"), MEMORY_FILE);
}
function loadHistory() {
  try {
    const filePath = getMemoryPath();
    if (!import_fs.default.existsSync(filePath)) return [];
    const raw = import_fs.default.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (Array.isArray(data?.correction_history)) {
      return data.correction_history;
    }
  } catch {
  }
  return [];
}
function extractClassKey(filename) {
  let nameOnly = filename.replace(/\.[^.]+$/, "");
  nameOnly = nameOnly.replace(/\b\d{1,2}[-./]\d{1,2}[-./]\d{2,4}\b/g, " ").replace(/\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b/g, " ").replace(/\b(19|20)\d{2}\b/g, " ").replace(/\bv\d+(\.\d+)*\b/gi, " ");
  const tokens = nameOnly.toLowerCase().split(/[\s\-_()\[\].,;:!?/\\]+/).map((t) => t.replace(/[^a-z]/g, "")).filter((t) => t.length >= 2).filter((t) => !/^\d+$/.test(t)).filter((t) => !NOISE_TOKENS.has(t));
  return tokens.slice(0, 3).join(" ").trim();
}
function computeHistoryConfidence(hitCount, agreement) {
  if (hitCount >= 5 && agreement >= 0.9) return 97;
  if (hitCount >= 3 && agreement >= 0.9) return 93;
  if (hitCount >= 2 && agreement >= 0.9) return 88;
  if (hitCount >= 2 && agreement >= MIN_AGREEMENT) return 75;
  return 0;
}
function keysOverlap(keyA, keyB) {
  if (!keyA || !keyB) return false;
  const tokensA = keyA.split(" ");
  const tokensB = keyB.split(" ");
  const shared = tokensA.filter((t) => tokensB.includes(t));
  if (shared.length === 0) return false;
  const shorter = Math.min(tokensA.length, tokensB.length);
  return shared.length >= Math.ceil(shorter * 0.5);
}
function getHistoryBoost(filename, userFolders) {
  const classKey = extractClassKey(filename);
  if (!classKey) return null;
  const history = loadHistory();
  if (history.length === 0) return null;
  const folderSet = new Set(userFolders.map((f) => f.toLowerCase()));
  const tally = /* @__PURE__ */ new Map();
  for (const entry of history) {
    if (!entry.user_correction) continue;
    const entryKey = extractClassKey(entry.filename);
    if (!entryKey) continue;
    if (!keysOverlap(classKey, entryKey)) continue;
    const dest = entry.user_correction.trim();
    tally.set(dest, (tally.get(dest) ?? 0) + 1);
  }
  if (tally.size === 0) return null;
  let topFolder = "";
  let topCount = 0;
  let totalCount = 0;
  for (const [folder, count] of tally) {
    totalCount += count;
    if (count > topCount) {
      topCount = count;
      topFolder = folder;
    }
  }
  if (topCount < MIN_HITS) return null;
  const agreement = topCount / totalCount;
  if (agreement < MIN_AGREEMENT) return null;
  if (!folderSet.has(topFolder.toLowerCase())) return null;
  const confidence = computeHistoryConfidence(topCount, agreement);
  if (confidence === 0) return null;
  const canonicalFolder = userFolders.find((f) => f.toLowerCase() === topFolder.toLowerCase()) ?? topFolder;
  console.log(
    `[ConsistencyService] HISTORY MATCH: classKey="${classKey}" \u2192 "${canonicalFolder}" (${topCount}/${totalCount} = ${Math.round(agreement * 100)}% agreement \u2192 ${confidence}% confidence)`
  );
  return {
    folder: canonicalFolder,
    confidence,
    matchedKey: classKey,
    hitCount: topCount
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  extractClassKey,
  getHistoryBoost
});
