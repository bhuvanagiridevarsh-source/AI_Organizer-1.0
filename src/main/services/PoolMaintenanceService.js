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
var PoolMaintenanceService_exports = {};
__export(PoolMaintenanceService_exports, {
  checkAndRunStartupMaintenance: () => checkAndRunStartupMaintenance,
  isMaintenanceDue: () => isMaintenanceDue,
  runForcedMaintenance: () => runForcedMaintenance,
  runScheduledMaintenance: () => runScheduledMaintenance
});
module.exports = __toCommonJS(PoolMaintenanceService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_electron = require("electron");
var import_universal_pool_manager = require("../intelligence/universal-pool-manager");
const MAINTENANCE_INTERVAL_DAYS = 7;
const MIN_DISTINCTIVENESS = 25;
const STATE_FILE = "maintenance_state.json";
const GLOBAL_CONCEPTS_FILE = "global_concepts.json";
function getStatePath() {
  return import_path.default.join(import_electron.app.getPath("userData"), STATE_FILE);
}
function loadState() {
  try {
    const p = getStatePath();
    if (import_fs.default.existsSync(p)) {
      const data = JSON.parse(import_fs.default.readFileSync(p, "utf-8"));
      if (typeof data?.last_maintenance_at === "number") return data;
    }
  } catch {
  }
  return { last_maintenance_at: 0 };
}
function saveState(state) {
  try {
    import_fs.default.writeFileSync(getStatePath(), JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error(`[PoolMaintenance] Failed to save state: ${err}`);
  }
}
let ranThisSession = false;
function isMaintenanceDue() {
  const state = loadState();
  const intervalMs = MAINTENANCE_INTERVAL_DAYS * 24 * 60 * 60 * 1e3;
  return Date.now() - state.last_maintenance_at >= intervalMs;
}
function runScheduledMaintenance(targetDir, force = false) {
  const emptyReport = (skipped, skipReason) => ({
    ranAt: Date.now(),
    targetDir,
    removedLowDistinctiveness: 0,
    removedGeneric: 0,
    removedCrossContaminated: 0,
    totalBefore: 0,
    totalAfter: 0,
    byFolder: {},
    skipped,
    skipReason
  });
  if (ranThisSession && !force) {
    return emptyReport(true, "Already ran this session");
  }
  if (!force && !isMaintenanceDue()) {
    return emptyReport(true, `Maintenance not due yet (interval: ${MAINTENANCE_INTERVAL_DAYS} days)`);
  }
  const poolPath = import_path.default.join(targetDir, GLOBAL_CONCEPTS_FILE);
  const pools = (0, import_universal_pool_manager.readMergedPool)(targetDir);
  if (Object.keys(pools).length === 0) {
    return emptyReport(true, "No pool data found in target directory");
  }
  if (import_fs.default.existsSync(poolPath)) {
    const backupPath = import_path.default.join(targetDir, `global_concepts_backup_maintenance_${Date.now()}.json`);
    try {
      import_fs.default.copyFileSync(poolPath, backupPath);
      console.log(`[PoolMaintenance] Backup: ${import_path.default.basename(backupPath)}`);
    } catch (err) {
      console.warn(`[PoolMaintenance] Could not create backup: ${err}`);
    }
  }
  const report = {
    ranAt: Date.now(),
    targetDir,
    removedLowDistinctiveness: 0,
    removedGeneric: 0,
    removedCrossContaminated: 0,
    totalBefore: 0,
    totalAfter: 0,
    byFolder: {},
    skipped: false
  };
  for (const terms of Object.values(pools)) {
    report.totalBefore += terms.length;
  }
  const { cleanedPools, stats } = (0, import_universal_pool_manager.sanitizePools)(pools);
  report.removedGeneric = stats.genericRemoved;
  report.removedCrossContaminated = stats.crossContaminationRemoved;
  const totalFolders = Object.keys(cleanedPools).length;
  const termFolderMap = /* @__PURE__ */ new Map();
  for (const [folder, terms] of Object.entries(cleanedPools)) {
    for (const t of terms) {
      const key = t.toLowerCase().trim();
      if (!termFolderMap.has(key)) termFolderMap.set(key, /* @__PURE__ */ new Set());
      termFolderMap.get(key).add(folder);
    }
  }
  const finalPools = {};
  for (const [folder, terms] of Object.entries(cleanedPools)) {
    const sanitizationDetail = stats.byFolder[folder] || {
      removedGeneric: [],
      removedCrossContaminated: []
    };
    const removedLow = [];
    const kept = [];
    for (const term of terms) {
      const score = (0, import_universal_pool_manager.computeDistinctivenessScore)(term, termFolderMap, totalFolders);
      if (score < MIN_DISTINCTIVENESS) {
        removedLow.push(term);
        report.removedLowDistinctiveness++;
      } else {
        kept.push(term);
      }
    }
    finalPools[folder] = kept;
    report.totalAfter += kept.length;
    report.byFolder[folder] = {
      before: (pools[folder] || []).length,
      after: kept.length,
      removedLowDistinctiveness: removedLow,
      removedGeneric: sanitizationDetail.removedGeneric,
      removedCrossContaminated: sanitizationDetail.removedCrossContaminated
    };
  }
  try {
    import_fs.default.writeFileSync(poolPath, JSON.stringify(finalPools, null, 2), "utf-8");
  } catch (err) {
    console.error(`[PoolMaintenance] Failed to write cleaned pools: ${err}`);
  }
  saveState({ last_maintenance_at: report.ranAt });
  ranThisSession = true;
  const totalRemoved = report.removedLowDistinctiveness + report.removedGeneric + report.removedCrossContaminated;
  console.log(
    `[PoolMaintenance] Complete: removed ${totalRemoved} terms (${report.removedLowDistinctiveness} low-distinctiveness, ${report.removedGeneric} generic, ${report.removedCrossContaminated} cross-contaminated). ${report.totalBefore} \u2192 ${report.totalAfter} total.`
  );
  return report;
}
function runForcedMaintenance(targetDir) {
  ranThisSession = false;
  return runScheduledMaintenance(targetDir, true);
}
function checkAndRunStartupMaintenance(targetDir) {
  if (!isMaintenanceDue()) {
    const state = loadState();
    const nextRun = new Date(
      state.last_maintenance_at + MAINTENANCE_INTERVAL_DAYS * 24 * 60 * 60 * 1e3
    ).toLocaleDateString();
    console.log(`[PoolMaintenance] Next scheduled maintenance: ${nextRun}`);
    return;
  }
  setImmediate(() => {
    try {
      const report = runScheduledMaintenance(targetDir);
      if (!report.skipped) {
        const totalRemoved = report.removedLowDistinctiveness + report.removedGeneric + report.removedCrossContaminated;
        console.log(
          `[PoolMaintenance] Startup maintenance complete: ${totalRemoved} stale terms pruned.`
        );
      }
    } catch (err) {
      console.error(`[PoolMaintenance] Startup maintenance failed: ${err}`);
    }
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  checkAndRunStartupMaintenance,
  isMaintenanceDue,
  runForcedMaintenance,
  runScheduledMaintenance
});
