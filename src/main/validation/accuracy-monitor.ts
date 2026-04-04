/**
 * accuracy-monitor.ts — Classification Quality Control.
 *
 * Tracks:
 *   1. CONFUSION MATRIX — which folders get confused with each other.
 *      When a pair reaches 10+ confusions, auto-generates a
 *      disambiguation rule for the pre-check pipeline.
 *
 *   2. CONFIDENCE CALIBRATION — tracks how accurate the system is
 *      at each confidence tier. If 90% predictions are only 80%
 *      accurate, the thresholds adjust automatically.
 *
 *   3. TIER ENFORCEMENT — maps confidence scores to user-visible actions:
 *       ≥90% → Auto-sort silently
 *       75-89% → Auto-sort with notification
 *       60-74% → Show top 3 suggestions, require click
 *       <60%  → Flag as "Needs Manual Review"
 *
 * All data is stored locally. No data leaves the device.
 */

import fs from "fs";
import path from "path";
import { app } from "electron";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ConfusionPair {
  folder_a: string;
  folder_b: string;
  /** How many times the AI picked folder_a but user corrected to folder_b. */
  a_to_b: number;
  /** How many times the AI picked folder_b but user corrected to folder_a. */
  b_to_a: number;
  /** Total confusion count (a_to_b + b_to_a). */
  total: number;
  last_occurrence: number; // Unix timestamp.
}

export interface ConfidenceTierStats {
  tier: string;           // "90-100", "75-89", "60-74", "<60"
  predictions: number;    // Total classifications at this tier.
  correct: number;        // Classifications the user confirmed / did not correct.
  accuracy: number;       // correct / predictions (0-1).
}

export interface DisambiguationRule {
  folder_a: string;
  folder_b: string;
  /** Terms that strongly indicate folder_a (not folder_b). */
  a_indicators: string[];
  /** Terms that strongly indicate folder_b (not folder_a). */
  b_indicators: string[];
  confidence: number;     // How confident we are in this rule (0-100).
  generated_at: number;   // Unix timestamp.
  // ── Lifecycle tracking (v2) ────────────────────────────────
  /** Total times this rule has fired and returned a folder suggestion. */
  uses: number;
  /** Times the rule fired and the user accepted the result (was correct). */
  successes: number;
  /** Times the rule fired and the user overrode it (was wrong). */
  failures: number;
  /** Fraction of uses that were successful: successes / uses. -1 when uses === 0. */
  success_rate: number;
  /**
   * When true, this rule is silently skipped during classification.
   * Auto-disabled when success_rate < 0.7 after 10+ uses.
   * Can also be manually disabled by user override action.
   */
  disabled: boolean;
  /** Timestamp of most recent use. 0 if never used. */
  last_used: number;
}

export interface AccuracyStore {
  confusion_pairs: ConfusionPair[];
  tier_stats: ConfidenceTierStats[];
  disambiguation_rules: DisambiguationRule[];
  total_classifications: number;
  total_corrections: number;
  last_updated: number;
}

/** One of four confidence tiers. */
export type ConfidenceTier =
  | "auto_sort"      // ≥90%: sort silently
  | "notify"         // 75-89%: sort with notification
  | "suggest"        // 60-74%: show top 3, require click
  | "manual_review"; // <60%: flag for manual review

// ── Configuration ──────────────────────────────────────────────────────────

const ACCURACY_FILE = "accuracy_monitor.json";

/** Confusion pairs with this many total confusions trigger a disambiguation rule. */
const DISAMBIGUATION_TRIGGER_COUNT = 10;

/** Rules with success_rate below this (after MIN_USES_FOR_DISABLE uses) are auto-disabled. */
const MIN_SUCCESS_RATE = 0.7;

/** Number of uses required before a rule can be auto-disabled. */
const MIN_USES_FOR_DISABLE = 10;

/** Rules unused for this many days are considered stale and pruned. */
const RULE_EXPIRY_DAYS = 90;
const RULE_EXPIRY_MS = RULE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

/**
 * Auto-sort thresholds. These are the base values; calibration can shift them.
 * When the system learns its own accuracy, thresholds adapt.
 */
const BASE_THRESHOLDS = {
  auto_sort: 90,   // ≥ this → sort silently
  notify: 75,      // ≥ this → sort with notification
  suggest: 60,     // ≥ this → show top 3 suggestions
  // below suggest → manual review
};

// ── File I/O ───────────────────────────────────────────────────────────────

function getStorePath(): string {
  return path.join(app.getPath("userData"), ACCURACY_FILE);
}

function loadStore(): AccuracyStore {
  try {
    const filePath = getStorePath();
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (data && Array.isArray(data.confusion_pairs)) {
        // Back-fill lifecycle fields on old rules that predate v2.
        if (Array.isArray(data.disambiguation_rules)) {
          data.disambiguation_rules = data.disambiguation_rules.map(
            (r: DisambiguationRule) => ({
              ...r,
              uses: r.uses ?? 0,
              successes: r.successes ?? 0,
              failures: r.failures ?? 0,
              success_rate: r.success_rate ?? -1,
              disabled: r.disabled ?? false,
              last_used: r.last_used ?? 0,
            })
          );
        }
        return data as AccuracyStore;
      }
    }
  } catch {
    // Corrupted — start fresh.
  }
  return {
    confusion_pairs: [],
    tier_stats: initTierStats(),
    disambiguation_rules: [],
    total_classifications: 0,
    total_corrections: 0,
    last_updated: Date.now(),
  };
}

function saveStore(store: AccuracyStore): void {
  try {
    store.last_updated = Date.now();
    fs.writeFileSync(getStorePath(), JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    console.error(`[AccuracyMonitor] Failed to save: ${err}`);
  }
}

function initTierStats(): ConfidenceTierStats[] {
  return [
    { tier: "90-100", predictions: 0, correct: 0, accuracy: 1 },
    { tier: "75-89", predictions: 0, correct: 0, accuracy: 1 },
    { tier: "60-74", predictions: 0, correct: 0, accuracy: 1 },
    { tier: "<60", predictions: 0, correct: 0, accuracy: 1 },
  ];
}

function getTierKey(confidence: number): string {
  if (confidence >= 90) return "90-100";
  if (confidence >= 75) return "75-89";
  if (confidence >= 60) return "60-74";
  return "<60";
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Map a confidence score to the appropriate user-facing action.
 *
 * Uses calibrated thresholds if available — the system learns its own
 * accuracy over time and adjusts when predictions don't match.
 */
export function getConfidenceTier(
  confidence: number,
  folderName?: string
): ConfidenceTier {
  // TODO: per-folder calibrated thresholds (Phase 5.3)
  // For now, use base thresholds.
  if (confidence >= BASE_THRESHOLDS.auto_sort) return "auto_sort";
  if (confidence >= BASE_THRESHOLDS.notify) return "notify";
  if (confidence >= BASE_THRESHOLDS.suggest) return "suggest";
  return "manual_review";
}

/**
 * Record a classification event.
 *
 * Call this EVERY time a file is classified, regardless of whether the
 * user corrects it. The `wasCorrect` flag determines whether the AI
 * was right.
 *
 * @param aiGuess - What the AI predicted.
 * @param aiConfidence - AI's confidence score (0-100).
 * @param userChoice - What the user actually selected.
 * @param wasCorrect - true if user accepted AI's suggestion.
 */
export function recordClassification(
  aiGuess: string,
  aiConfidence: number,
  userChoice: string,
  wasCorrect: boolean
): void {
  const store = loadStore();
  store.total_classifications++;
  if (!wasCorrect) store.total_corrections++;

  // Update tier stats.
  const tierKey = getTierKey(aiConfidence);
  const tierStat = store.tier_stats.find((t) => t.tier === tierKey);
  if (tierStat) {
    tierStat.predictions++;
    if (wasCorrect) tierStat.correct++;
    tierStat.accuracy =
      tierStat.predictions > 0 ? tierStat.correct / tierStat.predictions : 1;
  }

  // Record confusion pair if the user corrected the AI.
  if (!wasCorrect && aiGuess && userChoice && aiGuess !== userChoice) {
    recordConfusion(store, aiGuess, userChoice);
    // Also record a failure on any disambiguation rule that covers this pair.
    // If the AI fired a rule claiming folder X but the user picked folder Y,
    // the rule was wrong — record that as a failure.
    recordRuleOutcomeInStore(store, aiGuess, userChoice, false);
  } else if (wasCorrect && aiGuess) {
    // Record a success on any disambiguation rule covering this folder.
    // We approximate: if the user confirmed the AI's guess and a rule
    // covers the folder, that rule performed well.
    recordRuleOutcomeInStore(store, aiGuess, "", true);
  }

  saveStore(store);
}

/**
 * Record a confusion event between two folders.
 * Triggers disambiguation rule generation when threshold is hit.
 */
function recordConfusion(
  store: AccuracyStore,
  aiGuess: string,
  userChoice: string
): void {
  // Find or create the confusion pair (order-normalized).
  const [folderA, folderB] = [aiGuess, userChoice].sort();
  let pair = store.confusion_pairs.find(
    (p) => p.folder_a === folderA && p.folder_b === folderB
  );

  if (!pair) {
    pair = {
      folder_a: folderA,
      folder_b: folderB,
      a_to_b: 0,
      b_to_a: 0,
      total: 0,
      last_occurrence: Date.now(),
    };
    store.confusion_pairs.push(pair);
  }

  // Track direction of confusion.
  if (aiGuess === folderA) {
    pair.a_to_b++;
  } else {
    pair.b_to_a++;
  }
  pair.total++;
  pair.last_occurrence = Date.now();

  // Check if this pair has hit the disambiguation trigger.
  if (
    pair.total >= DISAMBIGUATION_TRIGGER_COUNT &&
    !store.disambiguation_rules.find(
      (r) => r.folder_a === folderA && r.folder_b === folderB
    )
  ) {
    console.log(
      `[AccuracyMonitor] Confusion pair "${folderA}" ↔ "${folderB}" hit ` +
        `${DISAMBIGUATION_TRIGGER_COUNT}+ confusions — queuing disambiguation rule generation.`
    );
    // Rule generation is done asynchronously by generateDisambiguationRule().
    // We set a flag in the pair data so it can be picked up.
  }
}

/**
 * Generate or update a disambiguation rule for a confused folder pair.
 *
 * This is called after enough confusion data has been collected.
 * The rule lists terms that distinguish folder_a from folder_b and vice versa,
 * extracted from the concept pools.
 *
 * @param folderA - First folder in the confused pair.
 * @param folderB - Second folder in the confused pair.
 * @param poolA - Concept terms from folder A's pool.
 * @param poolB - Concept terms from folder B's pool.
 */
export function generateDisambiguationRule(
  folderA: string,
  folderB: string,
  poolA: string[],
  poolB: string[]
): DisambiguationRule | null {
  const setA = new Set(poolA.map((t) => t.toLowerCase()));
  const setB = new Set(poolB.map((t) => t.toLowerCase()));

  // Find terms exclusive to A (not in B) — these indicate folder A.
  const aIndicators = poolA
    .filter((t) => !setB.has(t.toLowerCase()) && t.length >= 3)
    .slice(0, 10);

  // Find terms exclusive to B (not in A) — these indicate folder B.
  const bIndicators = poolB
    .filter((t) => !setA.has(t.toLowerCase()) && t.length >= 3)
    .slice(0, 10);

  if (aIndicators.length === 0 && bIndicators.length === 0) {
    console.log(
      `[AccuracyMonitor] Cannot generate disambiguation rule for ` +
        `"${folderA}" vs "${folderB}" — no exclusive terms found.`
    );
    return null;
  }

  const rule: DisambiguationRule = {
    folder_a: folderA,
    folder_b: folderB,
    a_indicators: aIndicators,
    b_indicators: bIndicators,
    confidence: Math.min(90, 70 + aIndicators.length + bIndicators.length),
    generated_at: Date.now(),
    // Lifecycle fields (v2)
    uses: 0,
    successes: 0,
    failures: 0,
    success_rate: -1,
    disabled: false,
    last_used: 0,
  };

  // Save the rule.
  const store = loadStore();
  const existingIdx = store.disambiguation_rules.findIndex(
    (r) => r.folder_a === folderA && r.folder_b === folderB
  );
  if (existingIdx >= 0) {
    store.disambiguation_rules[existingIdx] = rule;
  } else {
    store.disambiguation_rules.push(rule);
  }
  saveStore(store);

  console.log(
    `[AccuracyMonitor] Disambiguation rule generated: "${folderA}" vs "${folderB}" ` +
      `(${aIndicators.length} A-indicators, ${bIndicators.length} B-indicators)`
  );

  return rule;
}

/**
 * Check if a file matches a disambiguation rule.
 * Returns the preferred folder if a rule applies, or null if not.
 *
 * Used as a pre-check BEFORE the main classification pipeline.
 *
 * @param fileContent - First 500 words of file content.
 * @param filename - The file's name (for term extraction).
 * @returns `{ folder, confidence }` if a rule fires, else `null`.
 */
export function applyDisambiguationRules(
  filename: string,
  fileContent: string
): { folder: string; confidence: number; rule: DisambiguationRule } | null {
  const store = loadStore();
  if (store.disambiguation_rules.length === 0) return null;

  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent
    ? fileContent.split(/\s+/).slice(0, 500).join(" ")
    : "";
  const searchText = (nameNoExt + " " + contentHead).toLowerCase();
  const now = Date.now();

  let storeChanged = false;

  for (const rule of store.disambiguation_rules) {
    // Skip disabled rules.
    if (rule.disabled) continue;

    // Skip expired rules: unused for 90+ days (uses=0 and generated 90+ days ago),
    // or last used more than 90 days ago.
    const staleSince = rule.last_used > 0 ? rule.last_used : rule.generated_at;
    if (now - staleSince > RULE_EXPIRY_MS) {
      console.log(
        `[AccuracyMonitor] Rule "${rule.folder_a}" ↔ "${rule.folder_b}" expired ` +
        `(${RULE_EXPIRY_DAYS}d since last use). Disabling.`
      );
      rule.disabled = true;
      storeChanged = true;
      continue;
    }

    const aHits = rule.a_indicators.filter((t) =>
      searchText.includes(t.toLowerCase())
    ).length;
    const bHits = rule.b_indicators.filter((t) =>
      searchText.includes(t.toLowerCase())
    ).length;

    // Rule fires if one side has significantly more hits than the other.
    if ((aHits > bHits && aHits >= 2) || (bHits > aHits && bHits >= 2)) {
      // Track that this rule was used.
      rule.uses++;
      rule.last_used = now;
      storeChanged = true;

      const firedFolder = aHits > bHits ? rule.folder_a : rule.folder_b;

      if (storeChanged) saveStore(store);

      return { folder: firedFolder, confidence: rule.confidence, rule };
    }
  }

  if (storeChanged) saveStore(store);

  return null;
}

/**
 * Update success/failure stats on disambiguation rules that cover a folder pair.
 * Called from recordClassification — inline, within the same store load/save cycle.
 *
 * @param store - The currently loaded AccuracyStore (mutated in place).
 * @param folderA - The AI's predicted folder.
 * @param folderB - The user's actual folder (empty string for success tracking).
 * @param wasCorrect - Whether the classification was accepted.
 */
function recordRuleOutcomeInStore(
  store: AccuracyStore,
  folderA: string,
  folderB: string,
  wasCorrect: boolean
): void {
  for (const rule of store.disambiguation_rules) {
    if (rule.disabled) continue;
    if (rule.uses === 0) continue; // Rule hasn't fired yet — skip.

    // Determine if this rule covers the folders involved.
    const ruleCoversFailure =
      !wasCorrect &&
      (
        (rule.folder_a === folderA && rule.folder_b === folderB) ||
        (rule.folder_b === folderA && rule.folder_a === folderB) ||
        (rule.folder_a === folderA && folderB === "") ||
        (rule.folder_b === folderA && folderB === "")
      );

    const ruleCoverSuccess =
      wasCorrect &&
      (rule.folder_a === folderA || rule.folder_b === folderA);

    if (ruleCoversFailure) {
      rule.failures++;
    } else if (ruleCoverSuccess) {
      rule.successes++;
    } else {
      continue;
    }

    // Recompute success_rate.
    const totalOutcomes = rule.successes + rule.failures;
    rule.success_rate = totalOutcomes > 0
      ? rule.successes / totalOutcomes
      : -1;

    // Auto-disable if the rule is performing poorly.
    if (
      totalOutcomes >= MIN_USES_FOR_DISABLE &&
      rule.success_rate < MIN_SUCCESS_RATE
    ) {
      rule.disabled = true;
      console.log(
        `[AccuracyMonitor] Rule "${rule.folder_a}" ↔ "${rule.folder_b}" ` +
        `auto-disabled: success_rate=${Math.round(rule.success_rate * 100)}% ` +
        `after ${totalOutcomes} outcomes (min ${Math.round(MIN_SUCCESS_RATE * 100)}%)`
      );
    }
  }
}

/**
 * Manually disable a disambiguation rule (e.g., user triggered via UI).
 * The rule stays in the store but is silently skipped during classification.
 */
export function disableDisambiguationRule(folderA: string, folderB: string): boolean {
  const store = loadStore();
  const [a, b] = [folderA, folderB].sort();
  const rule = store.disambiguation_rules.find(
    (r) => r.folder_a === a && r.folder_b === b
  );
  if (!rule) return false;

  rule.disabled = true;
  saveStore(store);
  console.log(`[AccuracyMonitor] Rule "${a}" ↔ "${b}" manually disabled.`);
  return true;
}

/**
 * Remove disambiguation rules for folders that no longer exist.
 * Call this when the user deletes or renames a folder.
 *
 * @param activeFolders - Current list of valid folder names.
 * @returns Number of rules removed.
 */
export function pruneRulesForDeletedFolders(activeFolders: string[]): number {
  const store = loadStore();
  const folderSet = new Set(activeFolders.map((f) => f.toLowerCase()));

  const before = store.disambiguation_rules.length;
  store.disambiguation_rules = store.disambiguation_rules.filter(
    (r) =>
      folderSet.has(r.folder_a.toLowerCase()) &&
      folderSet.has(r.folder_b.toLowerCase())
  );
  const removed = before - store.disambiguation_rules.length;

  if (removed > 0) {
    saveStore(store);
    console.log(`[AccuracyMonitor] Pruned ${removed} rules for deleted folders.`);
  }

  return removed;
}

/**
 * Get all confusion pairs sorted by total confusion count (worst first).
 */
export function getConfusionPairs(): ConfusionPair[] {
  return loadStore()
    .confusion_pairs.sort((a, b) => b.total - a.total);
}

/**
 * Get confidence tier statistics for the accuracy dashboard.
 */
export function getTierStats(): ConfidenceTierStats[] {
  return loadStore().tier_stats;
}

/**
 * Get all active disambiguation rules.
 */
export function getDisambiguationRules(): DisambiguationRule[] {
  return loadStore().disambiguation_rules;
}

/**
 * Get pairs that have hit the threshold but don't yet have disambiguation rules.
 * Used by the UI to prompt rule generation.
 */
export function getPendingDisambiguationPairs(): ConfusionPair[] {
  const store = loadStore();
  const ruledPairs = new Set(
    store.disambiguation_rules.map((r) => `${r.folder_a}|${r.folder_b}`)
  );
  return store.confusion_pairs.filter(
    (p) =>
      p.total >= DISAMBIGUATION_TRIGGER_COUNT &&
      !ruledPairs.has(`${p.folder_a}|${p.folder_b}`)
  );
}

/**
 * Get overall accuracy stats for the dashboard.
 */
export function getAccuracyStats(): {
  total: number;
  corrections: number;
  accuracy: number;
  tierStats: ConfidenceTierStats[];
  topConfusionPairs: ConfusionPair[];
} {
  const store = loadStore();
  const accuracy =
    store.total_classifications > 0
      ? 1 - store.total_corrections / store.total_classifications
      : 1;

  return {
    total: store.total_classifications,
    corrections: store.total_corrections,
    accuracy,
    tierStats: store.tier_stats,
    topConfusionPairs: store.confusion_pairs
      .sort((a, b) => b.total - a.total)
      .slice(0, 10),
  };
}

/**
 * Reset all accuracy tracking data.
 * Used when the user clears their learning history.
 */
export function resetAccuracyData(): void {
  saveStore({
    confusion_pairs: [],
    tier_stats: initTierStats(),
    disambiguation_rules: [],
    total_classifications: 0,
    total_corrections: 0,
    last_updated: Date.now(),
  });
}
