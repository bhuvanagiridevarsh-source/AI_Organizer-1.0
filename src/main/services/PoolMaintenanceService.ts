/**
 * PoolMaintenanceService.ts — Scheduled pool decay and pruning.
 *
 * Prevents concept pools from accumulating stale, low-quality terms
 * over time. Runs maintenance on a 7-day schedule (configurable).
 *
 * MAINTENANCE OPERATIONS:
 *   1. Low-distinctiveness removal — terms scoring < MIN_DISTINCTIVENESS
 *      (computed against current pool state) are pruned.
 *   2. Cross-contamination removal — terms shared between unrelated folders.
 *   3. Generic term removal — terms in ≥ 40% of all folders.
 *      (Delegates to sanitizePools() from universal-pool-manager.)
 *
 * SCHEDULING:
 *   - Checks at app startup whether 7 days have elapsed since last run.
 *   - Stores last_maintenance_at in maintenance_state.json (userData dir).
 *   - Silent by default — logs to console, no user-visible UI disruption.
 *
 * SAFETY:
 *   - Creates a timestamped backup before every run.
 *   - Returns a MaintenanceReport so callers can log or display results.
 *   - Never runs more than once per session even if called multiple times.
 */

import fs from "fs";
import path from "path";
import { app } from "electron";
import {
  readMergedPool,
  sanitizePools,
  computeDistinctivenessScore,
  detectCrossContamination,
} from "../intelligence/universal-pool-manager";

// ── Configuration ──────────────────────────────────────────────────────────

/** How many days between scheduled maintenance runs. */
const MAINTENANCE_INTERVAL_DAYS = 7;

/** Minimum distinctiveness score; terms below this are pruned. */
const MIN_DISTINCTIVENESS = 25;

/** File tracking last maintenance timestamp. */
const STATE_FILE = "maintenance_state.json";

/** Pool file that gets written back after pruning. */
const GLOBAL_CONCEPTS_FILE = "global_concepts.json";

// ── Types ──────────────────────────────────────────────────────────────────

export interface MaintenanceReport {
  ranAt: number;
  targetDir: string;
  removedLowDistinctiveness: number;
  removedGeneric: number;
  removedCrossContaminated: number;
  totalBefore: number;
  totalAfter: number;
  byFolder: Record<string, FolderMaintenanceDetail>;
  skipped: boolean;
  skipReason?: string;
}

export interface FolderMaintenanceDetail {
  before: number;
  after: number;
  removedLowDistinctiveness: string[];
  removedGeneric: string[];
  removedCrossContaminated: string[];
}

interface MaintenanceState {
  last_maintenance_at: number; // Unix timestamp
}

// ── State I/O ──────────────────────────────────────────────────────────────

function getStatePath(): string {
  return path.join(app.getPath("userData"), STATE_FILE);
}

function loadState(): MaintenanceState {
  try {
    const p = getStatePath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (typeof data?.last_maintenance_at === "number") return data;
    }
  } catch {
    // Fallback to never-run state
  }
  return { last_maintenance_at: 0 };
}

function saveState(state: MaintenanceState): void {
  try {
    fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error(`[PoolMaintenance] Failed to save state: ${err}`);
  }
}

// ── Guard: only run once per session ──────────────────────────────────────

let ranThisSession = false;

// ── Core Maintenance Logic ──────────────────────────────────────────────────

/**
 * Determine whether maintenance is due based on elapsed time.
 */
export function isMaintenanceDue(): boolean {
  const state = loadState();
  const intervalMs = MAINTENANCE_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() - state.last_maintenance_at >= intervalMs;
}

/**
 * Run scheduled pool maintenance on the given target directory.
 *
 * Safely skips when:
 *   - Already ran this session (idempotent guard)
 *   - Maintenance interval has not elapsed
 *   - Pool is empty (nothing to prune)
 *
 * @param targetDir - Directory containing global_concepts.json
 * @param force - If true, bypass the 7-day schedule check
 * @returns MaintenanceReport with stats
 */
export function runScheduledMaintenance(
  targetDir: string,
  force = false
): MaintenanceReport {
  const emptyReport = (skipped: boolean, skipReason: string): MaintenanceReport => ({
    ranAt: Date.now(),
    targetDir,
    removedLowDistinctiveness: 0,
    removedGeneric: 0,
    removedCrossContaminated: 0,
    totalBefore: 0,
    totalAfter: 0,
    byFolder: {},
    skipped,
    skipReason,
  });

  // Session guard — prevents double-run in the same app session
  if (ranThisSession && !force) {
    return emptyReport(true, "Already ran this session");
  }

  // Scheduling guard
  if (!force && !isMaintenanceDue()) {
    return emptyReport(true, `Maintenance not due yet (interval: ${MAINTENANCE_INTERVAL_DAYS} days)`);
  }

  const poolPath = path.join(targetDir, GLOBAL_CONCEPTS_FILE);
  const pools = readMergedPool(targetDir);

  if (Object.keys(pools).length === 0) {
    return emptyReport(true, "No pool data found in target directory");
  }

  // Backup before any changes
  if (fs.existsSync(poolPath)) {
    const backupPath = path.join(targetDir, `global_concepts_backup_maintenance_${Date.now()}.json`);
    try {
      fs.copyFileSync(poolPath, backupPath);
      console.log(`[PoolMaintenance] Backup: ${path.basename(backupPath)}`);
    } catch (err) {
      console.warn(`[PoolMaintenance] Could not create backup: ${err}`);
    }
  }

  const report: MaintenanceReport = {
    ranAt: Date.now(),
    targetDir,
    removedLowDistinctiveness: 0,
    removedGeneric: 0,
    removedCrossContaminated: 0,
    totalBefore: 0,
    totalAfter: 0,
    byFolder: {},
    skipped: false,
  };

  // Count total before
  for (const terms of Object.values(pools)) {
    report.totalBefore += terms.length;
  }

  // Step 1: Run full sanitization (generic + cross-contamination) via pool manager
  const { cleanedPools, stats } = sanitizePools(pools);
  report.removedGeneric = stats.genericRemoved;
  report.removedCrossContaminated = stats.crossContaminationRemoved;

  // Step 2: Low-distinctiveness pruning on the already-sanitized pools
  const totalFolders = Object.keys(cleanedPools).length;
  const termFolderMap = new Map<string, Set<string>>();
  for (const [folder, terms] of Object.entries(cleanedPools)) {
    for (const t of terms) {
      const key = t.toLowerCase().trim();
      if (!termFolderMap.has(key)) termFolderMap.set(key, new Set());
      termFolderMap.get(key)!.add(folder);
    }
  }

  const finalPools: Record<string, string[]> = {};

  for (const [folder, terms] of Object.entries(cleanedPools)) {
    const sanitizationDetail = stats.byFolder[folder] || {
      removedGeneric: [],
      removedCrossContaminated: [],
    };

    const removedLow: string[] = [];
    const kept: string[] = [];

    for (const term of terms) {
      const score = computeDistinctivenessScore(term, termFolderMap, totalFolders);
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
      removedCrossContaminated: sanitizationDetail.removedCrossContaminated,
    };
  }

  // Write cleaned pools back to disk
  try {
    fs.writeFileSync(poolPath, JSON.stringify(finalPools, null, 2), "utf-8");
  } catch (err) {
    console.error(`[PoolMaintenance] Failed to write cleaned pools: ${err}`);
  }

  // Update state
  saveState({ last_maintenance_at: report.ranAt });
  ranThisSession = true;

  const totalRemoved =
    report.removedLowDistinctiveness +
    report.removedGeneric +
    report.removedCrossContaminated;

  console.log(
    `[PoolMaintenance] Complete: removed ${totalRemoved} terms ` +
    `(${report.removedLowDistinctiveness} low-distinctiveness, ` +
    `${report.removedGeneric} generic, ` +
    `${report.removedCrossContaminated} cross-contaminated). ` +
    `${report.totalBefore} → ${report.totalAfter} total.`
  );

  return report;
}

/**
 * Run maintenance immediately, bypassing the schedule check.
 * Use for manual user-triggered maintenance from settings UI.
 */
export function runForcedMaintenance(targetDir: string): MaintenanceReport {
  ranThisSession = false; // Reset session guard so force always runs
  return runScheduledMaintenance(targetDir, true);
}

/**
 * Check at app startup whether scheduled maintenance should run.
 * Call this from index.js after the app window is ready.
 * Non-blocking: returns immediately and does not await anything.
 */
export function checkAndRunStartupMaintenance(targetDir: string): void {
  if (!isMaintenanceDue()) {
    const state = loadState();
    const nextRun = new Date(
      state.last_maintenance_at + MAINTENANCE_INTERVAL_DAYS * 24 * 60 * 60 * 1000
    ).toLocaleDateString();
    console.log(`[PoolMaintenance] Next scheduled maintenance: ${nextRun}`);
    return;
  }

  // Run in next tick so startup is not blocked
  setImmediate(() => {
    try {
      const report = runScheduledMaintenance(targetDir);
      if (!report.skipped) {
        const totalRemoved =
          report.removedLowDistinctiveness +
          report.removedGeneric +
          report.removedCrossContaminated;
        console.log(
          `[PoolMaintenance] Startup maintenance complete: ${totalRemoved} stale terms pruned.`
        );
      }
    } catch (err) {
      console.error(`[PoolMaintenance] Startup maintenance failed: ${err}`);
    }
  });
}
