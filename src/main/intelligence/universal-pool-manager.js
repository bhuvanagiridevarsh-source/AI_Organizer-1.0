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
var universal_pool_manager_exports = {};
__export(universal_pool_manager_exports, {
  addTermsToPool: () => addTermsToPool,
  computeDistinctivenessScore: () => computeDistinctivenessScore,
  computePoolHealth: () => computePoolHealth,
  detectCrossContamination: () => detectCrossContamination,
  detectGenericTerms: () => detectGenericTerms,
  getDistinctiveTermsForAllFolders: () => getDistinctiveTermsForAllFolders,
  getPoolHealthReport: () => getPoolHealthReport,
  getTopDistinctiveTerms: () => getTopDistinctiveTerms,
  readMergedPool: () => readMergedPool,
  sanitizePoolFiles: () => sanitizePoolFiles,
  sanitizePools: () => sanitizePools,
  validateTermForFolder: () => validateTermForFolder
});
module.exports = __toCommonJS(universal_pool_manager_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
const GENERIC_THRESHOLD = 0.4;
const UNRELATED_SIMILARITY_THRESHOLD = 0.3;
const MIN_DISTINCTIVENESS_FOR_NEW_TERMS = 25;
const GLOBAL_CONCEPTS_FILE = "global_concepts.json";
const KNOWLEDGE_BASE_FILE = "knowledge_base.json";
function readPool(filePath) {
  try {
    if (import_fs.default.existsSync(filePath)) {
      const parsed = JSON.parse(import_fs.default.readFileSync(filePath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch {
  }
  return {};
}
function writePool(filePath, pool) {
  try {
    import_fs.default.writeFileSync(filePath, JSON.stringify(pool, null, 2), "utf-8");
  } catch (err) {
    console.error(`[PoolManager] Failed to write ${filePath}: ${err}`);
  }
}
function readMergedPool(targetDir) {
  const global = readPool(import_path.default.join(targetDir, GLOBAL_CONCEPTS_FILE));
  const kb = readPool(import_path.default.join(targetDir, KNOWLEDGE_BASE_FILE));
  for (const [cat, concepts] of Object.entries(kb)) {
    if (!global[cat]) {
      global[cat] = concepts;
    } else {
      global[cat] = [.../* @__PURE__ */ new Set([...global[cat], ...concepts])];
    }
  }
  return global;
}
function buildTermFolderMap(pools) {
  const termFolders = /* @__PURE__ */ new Map();
  for (const [folder, terms] of Object.entries(pools)) {
    for (const term of terms) {
      const key = term.toLowerCase().trim();
      if (key.length < 2) continue;
      if (!termFolders.has(key)) {
        termFolders.set(key, /* @__PURE__ */ new Set());
      }
      termFolders.get(key).add(folder);
    }
  }
  return termFolders;
}
function computeDistinctivenessScore(term, termFolderMap, totalFolders) {
  if (totalFolders === 0) return 100;
  const key = term.toLowerCase().trim();
  const foldersWithTerm = termFolderMap.get(key)?.size ?? 1;
  return Math.round((1 - foldersWithTerm / totalFolders) * 100);
}
function detectGenericTerms(pools) {
  const totalFolders = Object.keys(pools).length;
  if (totalFolders === 0) return /* @__PURE__ */ new Set();
  const termFolderMap = buildTermFolderMap(pools);
  const generic = /* @__PURE__ */ new Set();
  for (const [term, folders] of termFolderMap) {
    if (folders.size / totalFolders >= GENERIC_THRESHOLD) {
      generic.add(term);
    }
  }
  return generic;
}
function computeFolderSimilarity(folderA, folderB, pools) {
  const setA = new Set((pools[folderA] || []).map((t) => t.toLowerCase().trim()));
  const setB = new Set((pools[folderB] || []).map((t) => t.toLowerCase().trim()));
  const shared = [];
  for (const term of setA) {
    if (setB.has(term)) shared.push(term);
  }
  const union = /* @__PURE__ */ new Set([...setA, ...setB]);
  const score = union.size === 0 ? 0 : shared.length / union.size;
  return { folderA, folderB, score, sharedTerms: shared };
}
function detectCrossContamination(pools) {
  const folders = Object.keys(pools);
  const contaminated = /* @__PURE__ */ new Map();
  for (let i = 0; i < folders.length; i++) {
    for (let j = i + 1; j < folders.length; j++) {
      const sim = computeFolderSimilarity(folders[i], folders[j], pools);
      if (sim.score >= UNRELATED_SIMILARITY_THRESHOLD) continue;
      for (const term of sim.sharedTerms) {
        if (!contaminated.has(term)) {
          contaminated.set(term, /* @__PURE__ */ new Set());
        }
        contaminated.get(term).add(folders[i]);
        contaminated.get(term).add(folders[j]);
      }
    }
  }
  const result = /* @__PURE__ */ new Map();
  for (const [term, folderSet] of contaminated) {
    result.set(term, [...folderSet]);
  }
  return result;
}
function sanitizePools(pools) {
  const folders = Object.keys(pools);
  const stats = {
    genericRemoved: 0,
    crossContaminationRemoved: 0,
    beforeTotal: 0,
    afterTotal: 0,
    byFolder: {}
  };
  for (const terms of Object.values(pools)) {
    stats.beforeTotal += terms.length;
  }
  const genericTerms = detectGenericTerms(pools);
  const contaminated = detectCrossContamination(pools);
  const cleanedPools = {};
  for (const folder of folders) {
    const original = pools[folder] || [];
    const removedGeneric = [];
    const removedCrossContaminated = [];
    const cleaned = [];
    for (const term of original) {
      const key = term.toLowerCase().trim();
      if (genericTerms.has(key)) {
        removedGeneric.push(term);
        continue;
      }
      if (contaminated.has(key)) {
        removedCrossContaminated.push(term);
        continue;
      }
      cleaned.push(term);
    }
    cleanedPools[folder] = cleaned;
    stats.byFolder[folder] = {
      before: original.length,
      after: cleaned.length,
      removedGeneric,
      removedCrossContaminated
    };
    stats.genericRemoved += removedGeneric.length;
    stats.crossContaminationRemoved += removedCrossContaminated.length;
    stats.afterTotal += cleaned.length;
  }
  console.log(
    `[PoolManager] Sanitized: ${stats.genericRemoved} generic + ${stats.crossContaminationRemoved} cross-contaminated terms removed. ${stats.beforeTotal} \u2192 ${stats.afterTotal} total.`
  );
  return { cleanedPools, stats };
}
function validateTermForFolder(term, targetFolder, currentPools) {
  const key = term.toLowerCase().trim();
  if (key.length < 3) {
    return { allowed: false, reason: "Term too short (<3 chars)", distinctivenessScore: 0 };
  }
  const totalFolders = Object.keys(currentPools).length;
  const termFolderMap = buildTermFolderMap(currentPools);
  const foldersWithTerm = termFolderMap.get(key)?.size ?? 0;
  if (totalFolders > 0 && foldersWithTerm / totalFolders >= GENERIC_THRESHOLD) {
    return {
      allowed: false,
      reason: `Generic term \u2014 appears in ${foldersWithTerm}/${totalFolders} folders`,
      distinctivenessScore: Math.round((1 - foldersWithTerm / totalFolders) * 100)
    };
  }
  const hypotheticalPools = { ...currentPools };
  hypotheticalPools[targetFolder] = [
    ...hypotheticalPools[targetFolder] || [],
    term
  ];
  const hypotheticalMap = buildTermFolderMap(hypotheticalPools);
  const distinctiveness = computeDistinctivenessScore(key, hypotheticalMap, totalFolders);
  if (distinctiveness < MIN_DISTINCTIVENESS_FOR_NEW_TERMS) {
    return {
      allowed: false,
      reason: `Low distinctiveness score: ${distinctiveness} (min ${MIN_DISTINCTIVENESS_FOR_NEW_TERMS})`,
      distinctivenessScore: distinctiveness
    };
  }
  const existingFolders = [...termFolderMap.get(key) || []].filter(
    (f) => f !== targetFolder
  );
  for (const existingFolder of existingFolders) {
    const sim = computeFolderSimilarity(targetFolder, existingFolder, currentPools);
    if (sim.score < UNRELATED_SIMILARITY_THRESHOLD) {
      return {
        allowed: false,
        reason: `Cross-contamination risk \u2014 "${term}" already in unrelated folder "${existingFolder}" (similarity ${Math.round(sim.score * 100)}%)`,
        distinctivenessScore: distinctiveness
      };
    }
  }
  return {
    allowed: true,
    reason: `Passes validation (distinctiveness: ${distinctiveness})`,
    distinctivenessScore: distinctiveness
  };
}
function computePoolHealth(pools) {
  const totalFolders = Object.keys(pools).length;
  const termFolderMap = buildTermFolderMap(pools);
  const genericTerms = detectGenericTerms(pools);
  const contaminated = detectCrossContamination(pools);
  const health = [];
  for (const [folder, terms] of Object.entries(pools)) {
    if (terms.length === 0) {
      health.push({
        folder,
        totalTerms: 0,
        genericTerms: 0,
        crossContaminatedTerms: 0,
        avgDistinctiveness: 100,
        pollutionRatio: 0,
        status: "clean"
      });
      continue;
    }
    let genericCount = 0;
    let crossCount = 0;
    let totalDistinctiveness = 0;
    for (const term of terms) {
      const key = term.toLowerCase().trim();
      if (genericTerms.has(key)) genericCount++;
      else if (contaminated.has(key)) crossCount++;
      totalDistinctiveness += computeDistinctivenessScore(key, termFolderMap, totalFolders);
    }
    const pollutionRatio = (genericCount + crossCount) / terms.length;
    const avgDistinctiveness = Math.round(totalDistinctiveness / terms.length);
    health.push({
      folder,
      totalTerms: terms.length,
      genericTerms: genericCount,
      crossContaminatedTerms: crossCount,
      avgDistinctiveness,
      pollutionRatio,
      status: pollutionRatio > 0.4 ? "polluted" : pollutionRatio > 0.2 ? "moderate" : "clean"
    });
  }
  return health.sort((a, b) => b.pollutionRatio - a.pollutionRatio);
}
function getTopDistinctiveTerms(folder, pools, topN = 20) {
  const totalFolders = Object.keys(pools).length;
  const termFolderMap = buildTermFolderMap(pools);
  const terms = pools[folder] || [];
  const scored = terms.map((term) => {
    const key = term.toLowerCase().trim();
    const foldersContaining = [...termFolderMap.get(key) || /* @__PURE__ */ new Set()];
    const score = computeDistinctivenessScore(key, termFolderMap, totalFolders);
    return { term, score, foldersContaining };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, topN);
}
function sanitizePoolFiles(targetDir) {
  const poolPath = import_path.default.join(targetDir, GLOBAL_CONCEPTS_FILE);
  const kbPath = import_path.default.join(targetDir, KNOWLEDGE_BASE_FILE);
  const mergedPools = readMergedPool(targetDir);
  if (Object.keys(mergedPools).length === 0) {
    console.log(`[PoolManager] No pools found in ${targetDir}. Nothing to sanitize.`);
    return {
      genericRemoved: 0,
      crossContaminationRemoved: 0,
      beforeTotal: 0,
      afterTotal: 0,
      byFolder: {}
    };
  }
  const backupPath = import_path.default.join(targetDir, `global_concepts_backup_${Date.now()}.json`);
  if (import_fs.default.existsSync(poolPath)) {
    try {
      import_fs.default.copyFileSync(poolPath, backupPath);
      console.log(`[PoolManager] Backup created: ${import_path.default.basename(backupPath)}`);
    } catch (err) {
      console.warn(`[PoolManager] Could not create backup: ${err}`);
    }
  }
  const { cleanedPools, stats } = sanitizePools(mergedPools);
  writePool(poolPath, cleanedPools);
  if (import_fs.default.existsSync(kbPath)) {
    const kbOnly = readPool(kbPath);
    const kbCleaned = {};
    for (const [folder, terms] of Object.entries(kbOnly)) {
      const detail = stats.byFolder[folder];
      if (detail) {
        const removed = /* @__PURE__ */ new Set([
          ...detail.removedGeneric.map((t) => t.toLowerCase()),
          ...detail.removedCrossContaminated.map((t) => t.toLowerCase())
        ]);
        kbCleaned[folder] = terms.filter((t) => !removed.has(t.toLowerCase()));
      } else {
        kbCleaned[folder] = terms;
      }
    }
    writePool(kbPath, kbCleaned);
  }
  return stats;
}
function addTermsToPool(terms, targetFolder, targetDir, skipValidation = false) {
  const poolPath = import_path.default.join(targetDir, GLOBAL_CONCEPTS_FILE);
  const currentPools = readPool(poolPath);
  const existingTerms = new Set(
    (currentPools[targetFolder] || []).map((t) => t.toLowerCase().trim())
  );
  let addedCount = 0;
  const toAdd = [];
  for (const term of terms) {
    const key = term.toLowerCase().trim();
    if (key.length < 3 || existingTerms.has(key)) continue;
    if (!skipValidation) {
      const validation = validateTermForFolder(term, targetFolder, currentPools);
      if (!validation.allowed) {
        console.log(
          `[PoolManager] Rejected "${term}" for "${targetFolder}": ${validation.reason}`
        );
        continue;
      }
    }
    toAdd.push(term);
    existingTerms.add(key);
    addedCount++;
  }
  if (toAdd.length > 0) {
    currentPools[targetFolder] = [...currentPools[targetFolder] || [], ...toAdd];
    writePool(poolPath, currentPools);
    console.log(
      `[PoolManager] Added ${toAdd.length} terms to "${targetFolder}": [${toAdd.slice(0, 5).join(", ")}${toAdd.length > 5 ? "..." : ""}]`
    );
  }
  return addedCount;
}
function getPoolHealthReport(targetDir) {
  const pools = readMergedPool(targetDir);
  if (Object.keys(pools).length === 0) return [];
  return computePoolHealth(pools);
}
function getDistinctiveTermsForAllFolders(targetDir, topN = 20) {
  const pools = readMergedPool(targetDir);
  const result = {};
  for (const folder of Object.keys(pools)) {
    result[folder] = getTopDistinctiveTerms(folder, pools, topN);
  }
  return result;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  addTermsToPool,
  computeDistinctivenessScore,
  computePoolHealth,
  detectCrossContamination,
  detectGenericTerms,
  getDistinctiveTermsForAllFolders,
  getPoolHealthReport,
  getTopDistinctiveTerms,
  readMergedPool,
  sanitizePoolFiles,
  sanitizePools,
  validateTermForFolder
});
