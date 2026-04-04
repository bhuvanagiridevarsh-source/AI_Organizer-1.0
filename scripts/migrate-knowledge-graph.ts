/**
 * migrate-knowledge-graph.ts — One-time concept pool upgrade.
 *
 * Run this script ONCE on an existing installation to:
 *   1. Clean generic terms (appearing in ≥40% of all folders)
 *   2. Remove cross-contaminated terms (shared between unrelated folders)
 *   3. Backup the original pool files
 *   4. Report before/after stats
 *
 * USAGE:
 *   npx tsx scripts/migrate-knowledge-graph.ts /path/to/user/target/dir
 *
 * If no argument is provided, uses the current directory.
 *
 * SAFETY:
 *   - Creates a timestamped backup BEFORE making any changes.
 *   - If the backup fails, the script aborts without touching the pool.
 *   - Can be run multiple times safely (idempotent).
 *   - Rollback: rename the backup file back to global_concepts.json.
 */

import fs from "fs";
import path from "path";
import {
  readMergedPool,
  sanitizePools,
  computePoolHealth,
  SanitizationStats,
  PoolHealth,
} from "../src/main/intelligence/universal-pool-manager";

// ── Configuration ──────────────────────────────────────────────────────────

const GLOBAL_CONCEPTS_FILE = "global_concepts.json";
const KNOWLEDGE_BASE_FILE = "knowledge_base.json";

// ── Utility ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`[migrate] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[migrate] ⚠️  ${msg}`);
}

function die(msg: string): never {
  console.error(`[migrate] ❌  ${msg}`);
  process.exit(1);
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

// ── Backup ──────────────────────────────────────────────────────────────────

function createBackup(targetDir: string): string {
  const poolPath = path.join(targetDir, GLOBAL_CONCEPTS_FILE);
  if (!fs.existsSync(poolPath)) return "";

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(targetDir, `global_concepts_backup_${ts}.json`);

  try {
    fs.copyFileSync(poolPath, backupPath);
    log(`Backup created: ${path.basename(backupPath)}`);
    return backupPath;
  } catch (err) {
    die(`Failed to create backup: ${err}`);
  }
}

// ── Stats Report ────────────────────────────────────────────────────────────

function printHealthReport(health: PoolHealth[]): void {
  console.log("\n📊 POOL HEALTH REPORT:");
  console.log("─".repeat(68));
  console.log(
    `${"Folder".padEnd(25)} ${"Terms".padStart(5)} ${"Generic".padStart(8)} ${"CrossContam".padStart(12)} ${"AvgDistinct".padStart(12)} ${"Status".padStart(8)}`
  );
  console.log("─".repeat(68));

  for (const h of health) {
    const icon =
      h.status === "clean" ? "✅" : h.status === "moderate" ? "⚠️ " : "❌";
    console.log(
      `${h.folder.slice(0, 24).padEnd(25)} ` +
        `${String(h.totalTerms).padStart(5)} ` +
        `${String(h.genericTerms).padStart(8)} ` +
        `${String(h.crossContaminatedTerms).padStart(12)} ` +
        `${String(h.avgDistinctiveness).padStart(11)}% ` +
        `${icon} ${h.status}`
    );
  }
  console.log("─".repeat(68));
}

function printSanitizationStats(stats: SanitizationStats): void {
  console.log("\n🧹 SANITIZATION RESULTS:");
  console.log("─".repeat(55));
  console.log(`  Total before:         ${stats.beforeTotal} terms`);
  console.log(`  Generic removed:      ${stats.genericRemoved} terms`);
  console.log(
    `  Cross-contam removed: ${stats.crossContaminationRemoved} terms`
  );
  const totalRemoved = stats.genericRemoved + stats.crossContaminationRemoved;
  console.log(`  Total removed:        ${totalRemoved} terms`);
  console.log(`  Total after:          ${stats.afterTotal} terms`);
  const reductionPct =
    stats.beforeTotal > 0
      ? formatPercent(totalRemoved / stats.beforeTotal)
      : "0%";
  console.log(`  Reduction:            ${reductionPct}`);
  console.log("─".repeat(55));

  // Per-folder breakdown.
  console.log("\n📁 PER-FOLDER BREAKDOWN:");
  for (const [folder, detail] of Object.entries(stats.byFolder)) {
    const removed = detail.removedGeneric.length + detail.removedCrossContaminated.length;
    if (removed === 0) {
      log(`  ${folder}: clean (${detail.after} terms)`);
      continue;
    }
    console.log(
      `  ${folder}: ${detail.before} → ${detail.after} (-${removed})`
    );
    if (detail.removedGeneric.length > 0) {
      const sample = detail.removedGeneric.slice(0, 5).join(", ");
      console.log(
        `    Generic: [${sample}${detail.removedGeneric.length > 5 ? "..." : ""}]`
      );
    }
    if (detail.removedCrossContaminated.length > 0) {
      const sample = detail.removedCrossContaminated.slice(0, 5).join(", ");
      console.log(
        `    Cross-contam: [${sample}${detail.removedCrossContaminated.length > 5 ? "..." : ""}]`
      );
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function migrate(targetDir: string): Promise<void> {
  console.log("═".repeat(60));
  console.log("  🚀 AI Organizer — Knowledge Graph Migration");
  console.log("  Universal Pool Sanitization (Phase 1 upgrade)");
  console.log("═".repeat(60));
  console.log(`\nTarget directory: ${targetDir}\n`);

  // Verify directory exists.
  if (!fs.existsSync(targetDir)) {
    die(`Target directory does not exist: ${targetDir}`);
  }

  // Load existing pools.
  const pools = readMergedPool(targetDir);
  const folderCount = Object.keys(pools).length;
  const totalTerms = Object.values(pools).reduce((sum, t) => sum + t.length, 0);

  if (folderCount === 0) {
    log("No concept pools found. Nothing to migrate.");
    log("Pools are created automatically during classification.");
    process.exit(0);
  }

  log(`Found ${folderCount} folder pools with ${totalTerms} total terms.`);

  // ── BEFORE report ──────────────────────────────────────────────────────
  console.log("\n📊 BEFORE MIGRATION:");
  const beforeHealth = computePoolHealth(pools);
  printHealthReport(beforeHealth);

  const pollutedBefore = beforeHealth.filter(
    (h) => h.status === "polluted"
  ).length;
  const moderateBefore = beforeHealth.filter(
    (h) => h.status === "moderate"
  ).length;
  if (pollutedBefore > 0 || moderateBefore > 0) {
    log(
      `${pollutedBefore} polluted folders, ${moderateBefore} moderate folders detected.`
    );
  } else {
    log("Pools appear clean already. Migration will still run for safety.");
  }

  // ── Create backup ──────────────────────────────────────────────────────
  console.log();
  const backupPath = createBackup(targetDir);

  // ── Sanitize ───────────────────────────────────────────────────────────
  console.log("\nRunning sanitization...");
  const { cleanedPools, stats } = sanitizePools(pools);
  printSanitizationStats(stats);

  // ── AFTER report ──────────────────────────────────────────────────────
  console.log("\n📊 AFTER MIGRATION:");
  const afterHealth = computePoolHealth(cleanedPools);
  printHealthReport(afterHealth);

  const cleanAfter = afterHealth.filter((h) => h.status === "clean").length;
  log(
    `${cleanAfter}/${folderCount} folders now clean.`
  );

  // ── Save cleaned pools ─────────────────────────────────────────────────
  const poolPath = path.join(targetDir, GLOBAL_CONCEPTS_FILE);
  try {
    fs.writeFileSync(poolPath, JSON.stringify(cleanedPools, null, 2), "utf-8");
    log(`Saved cleaned pool to: ${GLOBAL_CONCEPTS_FILE}`);
  } catch (err) {
    die(`Failed to save cleaned pools: ${err}`);
  }

  // Also clean knowledge_base.json if it exists.
  const kbPath = path.join(targetDir, KNOWLEDGE_BASE_FILE);
  if (fs.existsSync(kbPath)) {
    try {
      const rawKb: Record<string, string[]> = JSON.parse(
        fs.readFileSync(kbPath, "utf-8")
      );
      const kbCleaned: Record<string, string[]> = {};
      for (const [folder, terms] of Object.entries(rawKb)) {
        const detail = stats.byFolder[folder];
        if (detail) {
          const removed = new Set([
            ...detail.removedGeneric.map((t) => t.toLowerCase()),
            ...detail.removedCrossContaminated.map((t) => t.toLowerCase()),
          ]);
          kbCleaned[folder] = terms.filter(
            (t) => !removed.has(t.toLowerCase())
          );
        } else {
          kbCleaned[folder] = terms;
        }
      }
      fs.writeFileSync(kbPath, JSON.stringify(kbCleaned, null, 2), "utf-8");
      log(`Also cleaned: ${KNOWLEDGE_BASE_FILE}`);
    } catch (err) {
      warn(`Could not clean knowledge_base.json: ${err}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────
  const totalRemoved = stats.genericRemoved + stats.crossContaminationRemoved;
  console.log("\n" + "═".repeat(60));
  console.log("  ✅ MIGRATION COMPLETE");
  console.log("═".repeat(60));
  console.log(`  Removed: ${totalRemoved} polluted terms`);
  console.log(`  Before:  ${stats.beforeTotal} terms`);
  console.log(`  After:   ${stats.afterTotal} terms`);
  if (backupPath) {
    console.log(`  Backup:  ${path.basename(backupPath)}`);
  }
  console.log(
    "\n  📈 Accuracy should improve immediately on the next sort."
  );
  console.log(
    "  🔄 Pools will continue to learn with validated term injection."
  );
  console.log(
    `\n  Rollback: rename ${path.basename(backupPath || "backup")} back to global_concepts.json`
  );
  console.log("═".repeat(60) + "\n");
}

// ── Entry Point ─────────────────────────────────────────────────────────────

const targetDir = process.argv[2] || process.cwd();
migrate(path.resolve(targetDir)).catch((err) => {
  die(`Migration failed: ${err}`);
});
