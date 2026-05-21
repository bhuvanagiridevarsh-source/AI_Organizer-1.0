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
var LearningService_exports = {};
__export(LearningService_exports, {
  buildLearningBlock: () => buildLearningBlock,
  clearMemory: () => clearMemory,
  getAllCorrections: () => getAllCorrections,
  getLearningCorrectionsForFolder: () => getLearningCorrectionsForFolder,
  getLearningEligibleCorrections: () => getLearningEligibleCorrections,
  getRelevantExamples: () => getRelevantExamples,
  getStats: () => getStats,
  recordCorrection: () => recordCorrection
});
module.exports = __toCommonJS(LearningService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_electron = require("electron");
const MAX_HISTORY = 200;
const MAX_PROMPT_EXAMPLES = 10;
const MEMORY_FILE = "user_memory.json";
const MIN_CONFIDENCE_FOR_LEARNING = 40;
function getMemoryPath() {
  return import_path.default.join(import_electron.app.getPath("userData"), MEMORY_FILE);
}
function loadStore() {
  const filePath = getMemoryPath();
  try {
    if (import_fs.default.existsSync(filePath)) {
      const raw = import_fs.default.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.correction_history)) {
        const history = data.correction_history.map((c) => ({
          ...c,
          should_learn_from: c.should_learn_from ?? c.ai_confidence >= MIN_CONFIDENCE_FOR_LEARNING
        }));
        return { correction_history: history };
      }
    }
  } catch {
  }
  return { correction_history: [] };
}
function saveStore(store) {
  const filePath = getMemoryPath();
  try {
    import_fs.default.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    console.error(`[LearningService] Failed to save: ${err}`);
  }
}
const FILENAME_NOISE = /* @__PURE__ */ new Set([
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
  "dec"
]);
function extractFilenameTerms(filename) {
  const nameOnly = filename.replace(/\.[^.]+$/, "");
  const tokens = nameOnly.toLowerCase().replace(/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g, " ").replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, " ").split(/[\s\-_()\[\].,;:!?/\\]+/).map((t) => t.replace(/[^a-z]/g, "")).filter((t) => t.length >= 2).filter((t) => !/^\d+$/.test(t)).filter((t) => !FILENAME_NOISE.has(t));
  return new Set(tokens);
}
function computeTermOverlap(filenameA, filenameB) {
  const termsA = extractFilenameTerms(filenameA);
  const termsB = extractFilenameTerms(filenameB);
  if (termsA.size === 0 || termsB.size === 0) return 0;
  let shared = 0;
  for (const term of termsA) {
    if (termsB.has(term)) shared++;
  }
  const smaller = Math.min(termsA.size, termsB.size);
  return shared / smaller;
}
function recordCorrection(correction) {
  const store = loadStore();
  const fullRecord = {
    ...correction,
    should_learn_from: correction.ai_confidence >= MIN_CONFIDENCE_FOR_LEARNING
  };
  store.correction_history.push(fullRecord);
  if (store.correction_history.length > MAX_HISTORY) {
    store.correction_history = store.correction_history.slice(-MAX_HISTORY);
  }
  saveStore(store);
  console.log(
    `[LearningService] Recorded: "${correction.filename}" AI=${correction.ai_guess} \u2192 User=${correction.user_correction} (learn_from=${fullRecord.should_learn_from})`
  );
}
function getRelevantExamples(currentFilename, currentExtension) {
  const store = loadStore();
  const history = store.correction_history;
  if (history.length === 0) return [];
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1e3;
  const now = Date.now();
  function scoreCorrection(c) {
    let score = 0;
    if (currentFilename) {
      const overlap = computeTermOverlap(currentFilename, c.filename);
      score += overlap * 100;
    }
    if (currentExtension && c.extension && c.extension.toLowerCase() === currentExtension.toLowerCase()) {
      score += 30;
    }
    const ageFactor = c.timestamp > now - THIRTY_DAYS_MS ? 1 : 0.5;
    const recencyScore = c.timestamp / now * 20 * ageFactor;
    score += recencyScore;
    return score;
  }
  const scored = history.map((c) => ({ correction: c, score: scoreCorrection(c) })).sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_PROMPT_EXAMPLES).map((s) => s.correction);
}
function buildLearningBlock(currentFilename, currentExtension) {
  const examples = getRelevantExamples(currentFilename, currentExtension);
  if (examples.length === 0) return "";
  const lines = ["Past corrections from this user:"];
  for (const c of examples) {
    const hint = c.content_hint ? ` (${c.content_hint})` : "";
    lines.push(`- "${c.filename}"${hint} \u2192 ${c.user_correction}`);
  }
  return lines.join("\n");
}
function getLearningEligibleCorrections() {
  return loadStore().correction_history.filter((c) => c.should_learn_from);
}
function getLearningCorrectionsForFolder(folder) {
  return loadStore().correction_history.filter(
    (c) => c.should_learn_from && c.user_correction.toLowerCase() === folder.toLowerCase()
  );
}
function getAllCorrections() {
  return loadStore().correction_history;
}
function getStats() {
  const history = loadStore().correction_history;
  const fromCounts = {};
  const toCounts = {};
  const cats = /* @__PURE__ */ new Set();
  let learningEligible = 0;
  for (const c of history) {
    fromCounts[c.ai_guess] = (fromCounts[c.ai_guess] || 0) + 1;
    toCounts[c.user_correction] = (toCounts[c.user_correction] || 0) + 1;
    cats.add(c.ai_guess);
    cats.add(c.user_correction);
    if (c.should_learn_from) learningEligible++;
  }
  const topFrom = Object.entries(fromCounts).sort((a, b) => b[1] - a[1])[0];
  const topTo = Object.entries(toCounts).sort((a, b) => b[1] - a[1])[0];
  return {
    total_corrections: history.length,
    unique_categories: cats.size,
    most_corrected_from: topFrom ? topFrom[0] : "none",
    most_corrected_to: topTo ? topTo[0] : "none",
    learning_eligible: learningEligible
  };
}
function clearMemory() {
  saveStore({ correction_history: [] });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildLearningBlock,
  clearMemory,
  getAllCorrections,
  getLearningCorrectionsForFolder,
  getLearningEligibleCorrections,
  getRelevantExamples,
  getStats,
  recordCorrection
});
