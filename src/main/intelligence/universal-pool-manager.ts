/**
 * universal-pool-manager.ts — Universal Concept Pool Intelligence.
 *
 * Self-learning pool sanitization that works for ANY user's folder structure.
 * No hardcoded subject knowledge. Discovers what makes each folder unique by
 * analyzing statistical patterns across the user's actual pools.
 *
 * KEY SYSTEMS:
 *
 *   1. DISTINCTIVENESS SCORING
 *      Every term gets a score 0-100 based on how exclusive it is to one folder.
 *      "DBQ" only in APUSH → 100. "document" in every folder → 0.
 *
 *   2. AUTO GENERIC DETECTION
 *      Terms appearing in ≥40% of all folders are auto-detected as generic
 *      and purged — no hardcoded blacklist required.
 *
 *   3. CROSS-CONTAMINATION DETECTION
 *      Folder similarity is auto-computed. Shared terms in UNRELATED folders
 *      (<30% similarity) are removed as contamination.
 *
 *   4. BEFORE-ADDING VALIDATION
 *      Hook called before any term enters a pool. Prevents future pollution
 *      by rejecting terms that fail distinctiveness requirements.
 *
 *   5. POOL HEALTH METRICS
 *      Per-folder statistics: pollution ratio, avg distinctiveness,
 *      confusion partners. Used by the UI dashboard.
 */

import fs from "fs";
import path from "path";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TermDistinctiveness {
  term: string;
  score: number;             // 0-100. Higher = more exclusive to this folder.
  foldersContaining: string[]; // Which folders contain this term.
}

export interface FolderSimilarity {
  folderA: string;
  folderB: string;
  score: number;             // 0-1. 1 = identical, 0 = no shared terms.
  sharedTerms: string[];
}

export interface PoolHealth {
  folder: string;
  totalTerms: number;
  genericTerms: number;      // Terms appearing in ≥40% of all folders.
  crossContaminatedTerms: number; // Terms from unrelated folders.
  avgDistinctiveness: number;    // Average distinctiveness of all terms.
  pollutionRatio: number;        // (generic + cross-contaminated) / total.
  status: "clean" | "moderate" | "polluted"; // "polluted" if ratio > 0.4.
}

export interface SanitizationResult {
  cleanedPools: Record<string, string[]>;
  stats: SanitizationStats;
}

export interface SanitizationStats {
  genericRemoved: number;
  crossContaminationRemoved: number;
  beforeTotal: number;
  afterTotal: number;
  byFolder: Record<string, FolderSanitizationDetail>;
}

export interface FolderSanitizationDetail {
  before: number;
  after: number;
  removedGeneric: string[];
  removedCrossContaminated: string[];
}

export interface ValidationResult {
  allowed: boolean;
  reason: string;
  distinctivenessScore: number;
}

// ── Configuration ──────────────────────────────────────────────────────────

/** Terms in this fraction or more of all folders → auto-detected as generic. */
const GENERIC_THRESHOLD = 0.4;

/**
 * Folder similarity threshold below which folders are "unrelated."
 * Shared terms between unrelated folders are cross-contamination.
 */
const UNRELATED_SIMILARITY_THRESHOLD = 0.3;

/**
 * Minimum distinctiveness score for a new term to be allowed into a pool.
 * Terms below this are too generic to be useful.
 */
const MIN_DISTINCTIVENESS_FOR_NEW_TERMS = 25;

/** Pool file names. */
const GLOBAL_CONCEPTS_FILE = "global_concepts.json";
const KNOWLEDGE_BASE_FILE = "knowledge_base.json";

// ── File I/O helpers ────────────────────────────────────────────────────────

function readPool(filePath: string): Record<string, string[]> {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string[]>;
      }
    }
  } catch {
    // Corrupt or missing — return empty.
  }
  return {};
}

function writePool(filePath: string, pool: Record<string, string[]>): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(pool, null, 2), "utf-8");
  } catch (err) {
    console.error(`[PoolManager] Failed to write ${filePath}: ${err}`);
  }
}

/** Read merged pool: global_concepts.json + knowledge_base.json. */
export function readMergedPool(targetDir: string): Record<string, string[]> {
  const global = readPool(path.join(targetDir, GLOBAL_CONCEPTS_FILE));
  const kb = readPool(path.join(targetDir, KNOWLEDGE_BASE_FILE));

  // Merge kb into global (additive, deduplicated).
  for (const [cat, concepts] of Object.entries(kb)) {
    if (!global[cat]) {
      global[cat] = concepts;
    } else {
      global[cat] = [...new Set([...global[cat], ...concepts])];
    }
  }
  return global;
}

// ── Core Computation ────────────────────────────────────────────────────────

/**
 * Compute a cross-folder term frequency map.
 * Returns: Map<term_lowercase, Set<folder>> — which folders contain each term.
 */
function buildTermFolderMap(
  pools: Record<string, string[]>
): Map<string, Set<string>> {
  const termFolders = new Map<string, Set<string>>();

  for (const [folder, terms] of Object.entries(pools)) {
    for (const term of terms) {
      const key = term.toLowerCase().trim();
      if (key.length < 2) continue;
      if (!termFolders.has(key)) {
        termFolders.set(key, new Set());
      }
      termFolders.get(key)!.add(folder);
    }
  }

  return termFolders;
}

/**
 * Compute distinctiveness score for a single term.
 *
 * FORMULA:
 *   score = (1 - foldersWithTerm / totalFolders) * 100
 *
 * A term in 1/10 folders scores 90.
 * A term in 4/10 folders (generic threshold) scores 60.
 * A term in all 10 folders scores 0.
 *
 * Terms with score < 25 should never enter concept pools.
 */
export function computeDistinctivenessScore(
  term: string,
  termFolderMap: Map<string, Set<string>>,
  totalFolders: number
): number {
  if (totalFolders === 0) return 100;
  const key = term.toLowerCase().trim();
  const foldersWithTerm = termFolderMap.get(key)?.size ?? 1;
  return Math.round((1 - foldersWithTerm / totalFolders) * 100);
}

/**
 * Auto-detect generic terms: those present in ≥ GENERIC_THRESHOLD of all folders.
 * Returns a Set of lowercase term strings that are too generic to be useful.
 */
export function detectGenericTerms(
  pools: Record<string, string[]>
): Set<string> {
  const totalFolders = Object.keys(pools).length;
  if (totalFolders === 0) return new Set();

  const termFolderMap = buildTermFolderMap(pools);
  const generic = new Set<string>();

  for (const [term, folders] of termFolderMap) {
    if (folders.size / totalFolders >= GENERIC_THRESHOLD) {
      generic.add(term);
    }
  }

  return generic;
}

/**
 * Compute similarity between two folders based on shared terms.
 *
 * Similarity = |sharedTerms| / |unionOfTerms|
 * (Jaccard index)
 */
function computeFolderSimilarity(
  folderA: string,
  folderB: string,
  pools: Record<string, string[]>
): FolderSimilarity {
  const setA = new Set((pools[folderA] || []).map((t) => t.toLowerCase().trim()));
  const setB = new Set((pools[folderB] || []).map((t) => t.toLowerCase().trim()));

  const shared: string[] = [];
  for (const term of setA) {
    if (setB.has(term)) shared.push(term);
  }

  const union = new Set([...setA, ...setB]);
  const score = union.size === 0 ? 0 : shared.length / union.size;

  return { folderA, folderB, score, sharedTerms: shared };
}

/**
 * Detect cross-contaminated terms: those shared between UNRELATED folders.
 *
 * Two folders are "unrelated" when their similarity < UNRELATED_SIMILARITY_THRESHOLD.
 * Shared terms between unrelated folders are cross-contamination.
 *
 * Returns: Map<term, conflictingFolders[]>
 */
export function detectCrossContamination(
  pools: Record<string, string[]>
): Map<string, string[]> {
  const folders = Object.keys(pools);
  const contaminated = new Map<string, Set<string>>();

  for (let i = 0; i < folders.length; i++) {
    for (let j = i + 1; j < folders.length; j++) {
      const sim = computeFolderSimilarity(folders[i], folders[j], pools);

      // Only flag shared terms between UNRELATED folders.
      if (sim.score >= UNRELATED_SIMILARITY_THRESHOLD) continue;

      // Shared terms between these unrelated folders are contamination.
      for (const term of sim.sharedTerms) {
        if (!contaminated.has(term)) {
          contaminated.set(term, new Set());
        }
        contaminated.get(term)!.add(folders[i]);
        contaminated.get(term)!.add(folders[j]);
      }
    }
  }

  // Convert sets to arrays.
  const result = new Map<string, string[]>();
  for (const [term, folderSet] of contaminated) {
    result.set(term, [...folderSet]);
  }
  return result;
}

// ── Main Sanitization ──────────────────────────────────────────────────────

/**
 * Sanitize concept pools by removing:
 *   1. Generic terms (appear in ≥40% of all folders)
 *   2. Cross-contaminated terms (appear in unrelated folder pairs)
 *
 * Does NOT use AI or network. Purely statistical.
 * Safe to run multiple times — idempotent.
 */
export function sanitizePools(
  pools: Record<string, string[]>
): SanitizationResult {
  const folders = Object.keys(pools);
  const stats: SanitizationStats = {
    genericRemoved: 0,
    crossContaminationRemoved: 0,
    beforeTotal: 0,
    afterTotal: 0,
    byFolder: {},
  };

  // Count total terms before.
  for (const terms of Object.values(pools)) {
    stats.beforeTotal += terms.length;
  }

  // Step 1: Detect generic terms.
  const genericTerms = detectGenericTerms(pools);

  // Step 2: Detect cross-contaminated terms.
  const contaminated = detectCrossContamination(pools);

  // Step 3: Build cleaned pools.
  const cleanedPools: Record<string, string[]> = {};

  for (const folder of folders) {
    const original = pools[folder] || [];
    const removedGeneric: string[] = [];
    const removedCrossContaminated: string[] = [];
    const cleaned: string[] = [];

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
      removedCrossContaminated,
    };

    stats.genericRemoved += removedGeneric.length;
    stats.crossContaminationRemoved += removedCrossContaminated.length;
    stats.afterTotal += cleaned.length;
  }

  console.log(
    `[PoolManager] Sanitized: ${stats.genericRemoved} generic + ` +
      `${stats.crossContaminationRemoved} cross-contaminated terms removed. ` +
      `${stats.beforeTotal} → ${stats.afterTotal} total.`
  );

  return { cleanedPools, stats };
}

// ── Before-Adding Validation ────────────────────────────────────────────────

/**
 * Validate whether a term should be added to a folder's concept pool.
 *
 * Called BEFORE any new term enters a pool (e.g., from internet retry,
 * entity recognition, or user correction processing).
 *
 * Rejects terms that:
 *   1. Are too short (< 3 chars)
 *   2. Are already auto-detected as generic (appear in ≥40% of folders)
 *   3. Have distinctiveness score < MIN_DISTINCTIVENESS_FOR_NEW_TERMS
 *   4. Already exist in 2+ unrelated folders (cross-contaminated)
 */
export function validateTermForFolder(
  term: string,
  targetFolder: string,
  currentPools: Record<string, string[]>
): ValidationResult {
  const key = term.toLowerCase().trim();

  // Too short to be meaningful.
  if (key.length < 3) {
    return { allowed: false, reason: "Term too short (<3 chars)", distinctivenessScore: 0 };
  }

  const totalFolders = Object.keys(currentPools).length;
  const termFolderMap = buildTermFolderMap(currentPools);

  // Check if it's generic.
  const foldersWithTerm = termFolderMap.get(key)?.size ?? 0;
  if (totalFolders > 0 && foldersWithTerm / totalFolders >= GENERIC_THRESHOLD) {
    return {
      allowed: false,
      reason: `Generic term — appears in ${foldersWithTerm}/${totalFolders} folders`,
      distinctivenessScore: Math.round((1 - foldersWithTerm / totalFolders) * 100),
    };
  }

  // Compute distinctiveness score including the target folder.
  const hypotheticalPools = { ...currentPools };
  hypotheticalPools[targetFolder] = [
    ...(hypotheticalPools[targetFolder] || []),
    term,
  ];
  const hypotheticalMap = buildTermFolderMap(hypotheticalPools);
  const distinctiveness = computeDistinctivenessScore(key, hypotheticalMap, totalFolders);

  if (distinctiveness < MIN_DISTINCTIVENESS_FOR_NEW_TERMS) {
    return {
      allowed: false,
      reason: `Low distinctiveness score: ${distinctiveness} (min ${MIN_DISTINCTIVENESS_FOR_NEW_TERMS})`,
      distinctivenessScore: distinctiveness,
    };
  }

  // Check cross-contamination: is this term already in unrelated folders?
  const existingFolders = [...(termFolderMap.get(key) || [])].filter(
    (f) => f !== targetFolder
  );

  for (const existingFolder of existingFolders) {
    const sim = computeFolderSimilarity(targetFolder, existingFolder, currentPools);
    if (sim.score < UNRELATED_SIMILARITY_THRESHOLD) {
      return {
        allowed: false,
        reason:
          `Cross-contamination risk — "${term}" already in unrelated folder ` +
          `"${existingFolder}" (similarity ${Math.round(sim.score * 100)}%)`,
        distinctivenessScore: distinctiveness,
      };
    }
  }

  return {
    allowed: true,
    reason: `Passes validation (distinctiveness: ${distinctiveness})`,
    distinctivenessScore: distinctiveness,
  };
}

// ── Pool Health ─────────────────────────────────────────────────────────────

/**
 * Compute health metrics for every folder in the pool.
 *
 * Returns an array sorted by pollutionRatio descending (worst first).
 */
export function computePoolHealth(
  pools: Record<string, string[]>
): PoolHealth[] {
  const totalFolders = Object.keys(pools).length;
  const termFolderMap = buildTermFolderMap(pools);
  const genericTerms = detectGenericTerms(pools);
  const contaminated = detectCrossContamination(pools);

  const health: PoolHealth[] = [];

  for (const [folder, terms] of Object.entries(pools)) {
    if (terms.length === 0) {
      health.push({
        folder,
        totalTerms: 0,
        genericTerms: 0,
        crossContaminatedTerms: 0,
        avgDistinctiveness: 100,
        pollutionRatio: 0,
        status: "clean",
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
      status:
        pollutionRatio > 0.4
          ? "polluted"
          : pollutionRatio > 0.2
          ? "moderate"
          : "clean",
    });
  }

  return health.sort((a, b) => b.pollutionRatio - a.pollutionRatio);
}

// ── Top Distinctive Terms ────────────────────────────────────────────────────

/**
 * Get the top N most distinctive terms for a given folder.
 * Used by the AI prompt system to give AI the BEST terms per folder.
 *
 * @param folder - The folder to get terms for.
 * @param pools - All pools (for cross-folder comparison).
 * @param topN - How many terms to return (default 20).
 * @returns Array of terms sorted by distinctiveness score descending.
 */
export function getTopDistinctiveTerms(
  folder: string,
  pools: Record<string, string[]>,
  topN = 20
): TermDistinctiveness[] {
  const totalFolders = Object.keys(pools).length;
  const termFolderMap = buildTermFolderMap(pools);
  const terms = pools[folder] || [];

  const scored: TermDistinctiveness[] = terms.map((term) => {
    const key = term.toLowerCase().trim();
    const foldersContaining = [...(termFolderMap.get(key) || new Set())];
    const score = computeDistinctivenessScore(key, termFolderMap, totalFolders);
    return { term, score, foldersContaining };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

// ── Disk Operations ─────────────────────────────────────────────────────────

/**
 * Run full sanitization on a target directory's pool files.
 *
 * 1. Reads global_concepts.json + knowledge_base.json.
 * 2. Sanitizes (removes generic + cross-contaminated terms).
 * 3. Creates a backup of the original files.
 * 4. Writes cleaned pools back to global_concepts.json.
 * 5. Returns sanitization stats.
 */
export function sanitizePoolFiles(targetDir: string): SanitizationStats {
  const poolPath = path.join(targetDir, GLOBAL_CONCEPTS_FILE);
  const kbPath = path.join(targetDir, KNOWLEDGE_BASE_FILE);

  const mergedPools = readMergedPool(targetDir);

  if (Object.keys(mergedPools).length === 0) {
    console.log(`[PoolManager] No pools found in ${targetDir}. Nothing to sanitize.`);
    return {
      genericRemoved: 0,
      crossContaminationRemoved: 0,
      beforeTotal: 0,
      afterTotal: 0,
      byFolder: {},
    };
  }

  // Backup original file.
  const backupPath = path.join(targetDir, `global_concepts_backup_${Date.now()}.json`);
  if (fs.existsSync(poolPath)) {
    try {
      fs.copyFileSync(poolPath, backupPath);
      console.log(`[PoolManager] Backup created: ${path.basename(backupPath)}`);
    } catch (err) {
      console.warn(`[PoolManager] Could not create backup: ${err}`);
    }
  }

  const { cleanedPools, stats } = sanitizePools(mergedPools);

  // Write cleaned pools to global_concepts.json.
  writePool(poolPath, cleanedPools);

  // If knowledge_base.json exists, clean it too.
  if (fs.existsSync(kbPath)) {
    const kbOnly = readPool(kbPath);
    const kbCleaned: Record<string, string[]> = {};
    for (const [folder, terms] of Object.entries(kbOnly)) {
      const detail = stats.byFolder[folder];
      if (detail) {
        const removed = new Set([
          ...detail.removedGeneric.map((t) => t.toLowerCase()),
          ...detail.removedCrossContaminated.map((t) => t.toLowerCase()),
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

/**
 * Add terms to a folder's concept pool with validation.
 * Filters out terms that fail distinctiveness/generic/cross-contamination checks.
 *
 * @param terms - Candidate terms to add.
 * @param targetFolder - The folder to add them to.
 * @param targetDir - Directory containing pool files.
 * @param skipValidation - If true, bypass validation (use with care).
 * @returns Number of terms actually added.
 */
export function addTermsToPool(
  terms: string[],
  targetFolder: string,
  targetDir: string,
  skipValidation = false
): number {
  const poolPath = path.join(targetDir, GLOBAL_CONCEPTS_FILE);
  const currentPools = readPool(poolPath);

  const existingTerms = new Set(
    (currentPools[targetFolder] || []).map((t) => t.toLowerCase().trim())
  );

  let addedCount = 0;
  const toAdd: string[] = [];

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
    currentPools[targetFolder] = [...(currentPools[targetFolder] || []), ...toAdd];
    writePool(poolPath, currentPools);
    console.log(
      `[PoolManager] Added ${toAdd.length} terms to "${targetFolder}": [${toAdd.slice(0, 5).join(", ")}${toAdd.length > 5 ? "..." : ""}]`
    );
  }

  return addedCount;
}

/**
 * Get pool health report for a target directory.
 * Returns per-folder health metrics.
 */
export function getPoolHealthReport(targetDir: string): PoolHealth[] {
  const pools = readMergedPool(targetDir);
  if (Object.keys(pools).length === 0) return [];
  return computePoolHealth(pools);
}

/**
 * Get the top distinctive terms for each folder.
 * Used by the AI prompt builder to weight terms by importance.
 */
export function getDistinctiveTermsForAllFolders(
  targetDir: string,
  topN = 20
): Record<string, TermDistinctiveness[]> {
  const pools = readMergedPool(targetDir);
  const result: Record<string, TermDistinctiveness[]> = {};

  for (const folder of Object.keys(pools)) {
    result[folder] = getTopDistinctiveTerms(folder, pools, topN);
  }

  return result;
}
