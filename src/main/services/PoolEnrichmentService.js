var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var PoolEnrichmentService_exports = {};
__export(PoolEnrichmentService_exports, {
  bulkEnrichFromHistory: () => bulkEnrichFromHistory,
  enrichPoolFromCorrection: () => enrichPoolFromCorrection
});
module.exports = __toCommonJS(PoolEnrichmentService_exports);
var import_LearningService = require("./LearningService");
var import_universal_pool_manager = require("../intelligence/universal-pool-manager");
var import_KnowledgeGraphService = require("./KnowledgeGraphService");
const MAX_TERMS_PER_CORRECTION = 5;
const COLD_START_THRESHOLD = 10;
const COLD_START_TERM_LIMIT = 10;
const MIN_TERM_LENGTH = 3;
const NOISE_TOKENS = /* @__PURE__ */ new Set([
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
  "answers",
  "answer",
  "key",
  "solutions",
  "solution",
  "handout",
  "packet",
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
  "wip",
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
  "print",
  "misc",
  "miscellaneous",
  "general",
  "other",
  "info",
  "information",
  "data",
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
  "intro",
  "introduction",
  "conclusion"
]);
function extractTermsFromFilename(filename) {
  let nameOnly = filename.replace(/\.[^.]+$/, "");
  nameOnly = nameOnly.replace(/\b\d{1,2}[-./]\d{1,2}[-./]\d{2,4}\b/g, " ").replace(/\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b/g, " ").replace(/\b(19|20)\d{2}\b/g, " ").replace(/\bv\d+(\.\d+)*\b/gi, " ");
  return nameOnly.toLowerCase().split(/[\s\-_()\[\].,;:!?/\\]+/).map((t) => t.replace(/[^a-z]/g, "")).filter((t) => t.length >= MIN_TERM_LENGTH).filter((t) => !/^\d+$/.test(t)).filter((t) => !NOISE_TOKENS.has(t));
}
function scoreTerms(candidates, folderCorrections, currentPools, targetFolder) {
  if (candidates.length === 0) return [];
  const totalFolders = Object.keys(currentPools).length;
  const termFolderMap = /* @__PURE__ */ new Map();
  for (const [folder, terms] of Object.entries(currentPools)) {
    for (const t of terms) {
      const key = t.toLowerCase().trim();
      if (!termFolderMap.has(key)) termFolderMap.set(key, /* @__PURE__ */ new Set());
      termFolderMap.get(key).add(folder);
    }
  }
  const termFreqInFolder = /* @__PURE__ */ new Map();
  if (folderCorrections.length > 0) {
    for (const correction of folderCorrections) {
      const corrTerms = extractTermsFromFilename(correction.filename);
      for (const t of corrTerms) {
        termFreqInFolder.set(t, (termFreqInFolder.get(t) ?? 0) + 1);
      }
    }
  }
  const scored = candidates.map((term) => {
    const rawFreq = termFreqInFolder.get(term) ?? 0;
    const folderFrequency = folderCorrections.length > 0 ? rawFreq / folderCorrections.length : 0;
    const distinctiveness = (0, import_universal_pool_manager.computeDistinctivenessScore)(
      term,
      termFolderMap,
      totalFolders
    );
    const score = folderFrequency * 50 + distinctiveness * 0.5;
    return { term, score };
  });
  return scored.sort((a, b) => b.score - a.score);
}
function enrichPoolFromCorrection(filename, targetFolder, aiConfidence, targetDir) {
  try {
    const currentPools = (0, import_universal_pool_manager.readMergedPool)(targetDir);
    const totalFolderCount = (0, import_LearningService.getAllCorrections)().filter(
      (c) => c.user_correction.toLowerCase() === targetFolder.toLowerCase()
    ).length;
    const isColdStart = totalFolderCount < COLD_START_THRESHOLD;
    const allFolderCorrections = (0, import_LearningService.getLearningCorrectionsForFolder)(targetFolder);
    const isTrusted = aiConfidence >= 60;
    if (!isTrusted && !isColdStart) {
      console.log(
        `[PoolEnrichment] Skipping "${filename}" \u2192 "${targetFolder}": ai_confidence=${aiConfidence} < 60 and not cold start`
      );
      return 0;
    }
    const rawCandidates = extractTermsFromFilename(filename);
    const candidates = rawCandidates.filter((t) => (0, import_KnowledgeGraphService.isQualityTerm)(t, currentPools));
    if (candidates.length === 0) {
      console.log(`[PoolEnrichment] No quality terms extracted from "${filename}"`);
      return 0;
    }
    const scored = scoreTerms(candidates, allFolderCorrections, currentPools, targetFolder);
    const limit = isColdStart ? COLD_START_TERM_LIMIT : MAX_TERMS_PER_CORRECTION;
    const topTerms = scored.slice(0, limit).map((s) => s.term);
    if (topTerms.length === 0) return 0;
    const added = (0, import_universal_pool_manager.addTermsToPool)(topTerms, targetFolder, targetDir);
    if (added > 0) {
      console.log(
        `[PoolEnrichment] "${filename}" \u2192 "${targetFolder}": added ${added}/${topTerms.length} terms` + (isColdStart ? " [COLD START MODE]" : "") + `. Top: [${topTerms.slice(0, 3).join(", ")}]`
      );
    }
    return added;
  } catch (err) {
    console.error(`[PoolEnrichment] Error enriching pool for "${targetFolder}": ${err}`);
    return 0;
  }
}
function bulkEnrichFromHistory(targetDir) {
  const eligible = (0, import_LearningService.getLearningEligibleCorrections)();
  if (eligible.length === 0) {
    console.log("[PoolEnrichment] No learning-eligible corrections found for bulk enrichment.");
    return 0;
  }
  let totalAdded = 0;
  for (const correction of eligible) {
    const added = enrichPoolFromCorrection(
      correction.filename,
      correction.user_correction,
      correction.ai_confidence,
      targetDir
    );
    totalAdded += added;
  }
  console.log(
    `[PoolEnrichment] Bulk enrichment complete: processed ${eligible.length} corrections, added ${totalAdded} terms total.`
  );
  return totalAdded;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  bulkEnrichFromHistory,
  enrichPoolFromCorrection
});
