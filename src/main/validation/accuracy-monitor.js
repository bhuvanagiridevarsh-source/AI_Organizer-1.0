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
var accuracy_monitor_exports = {};
__export(accuracy_monitor_exports, {
  applyDisambiguationRules: () => applyDisambiguationRules,
  disableDisambiguationRule: () => disableDisambiguationRule,
  generateDisambiguationRule: () => generateDisambiguationRule,
  getAccuracyStats: () => getAccuracyStats,
  getConfidenceTier: () => getConfidenceTier,
  getConfusionPairs: () => getConfusionPairs,
  getDisambiguationRules: () => getDisambiguationRules,
  getPendingDisambiguationPairs: () => getPendingDisambiguationPairs,
  getTierStats: () => getTierStats,
  pruneRulesForDeletedFolders: () => pruneRulesForDeletedFolders,
  recordClassification: () => recordClassification,
  resetAccuracyData: () => resetAccuracyData
});
module.exports = __toCommonJS(accuracy_monitor_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_electron = require("electron");
const ACCURACY_FILE = "accuracy_monitor.json";
const DISAMBIGUATION_TRIGGER_COUNT = 10;
const MIN_SUCCESS_RATE = 0.7;
const MIN_USES_FOR_DISABLE = 10;
const RULE_EXPIRY_DAYS = 90;
const RULE_EXPIRY_MS = RULE_EXPIRY_DAYS * 24 * 60 * 60 * 1e3;
const BASE_THRESHOLDS = {
  auto_sort: 90,
  // ≥ this → sort silently
  notify: 75,
  // ≥ this → sort with notification
  suggest: 60
  // ≥ this → show top 3 suggestions
  // below suggest → manual review
};
function getStorePath() {
  return import_path.default.join(import_electron.app.getPath("userData"), ACCURACY_FILE);
}
function loadStore() {
  try {
    const filePath = getStorePath();
    if (import_fs.default.existsSync(filePath)) {
      const data = JSON.parse(import_fs.default.readFileSync(filePath, "utf-8"));
      if (data && Array.isArray(data.confusion_pairs)) {
        if (Array.isArray(data.disambiguation_rules)) {
          data.disambiguation_rules = data.disambiguation_rules.map(
            (r) => ({
              ...r,
              uses: r.uses ?? 0,
              successes: r.successes ?? 0,
              failures: r.failures ?? 0,
              success_rate: r.success_rate ?? -1,
              disabled: r.disabled ?? false,
              last_used: r.last_used ?? 0
            })
          );
        }
        return data;
      }
    }
  } catch {
  }
  return {
    confusion_pairs: [],
    tier_stats: initTierStats(),
    disambiguation_rules: [],
    total_classifications: 0,
    total_corrections: 0,
    last_updated: Date.now()
  };
}
function saveStore(store) {
  try {
    store.last_updated = Date.now();
    import_fs.default.writeFileSync(getStorePath(), JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    console.error(`[AccuracyMonitor] Failed to save: ${err}`);
  }
}
function initTierStats() {
  return [
    { tier: "90-100", predictions: 0, correct: 0, accuracy: 1 },
    { tier: "75-89", predictions: 0, correct: 0, accuracy: 1 },
    { tier: "60-74", predictions: 0, correct: 0, accuracy: 1 },
    { tier: "<60", predictions: 0, correct: 0, accuracy: 1 }
  ];
}
function getTierKey(confidence) {
  if (confidence >= 90) return "90-100";
  if (confidence >= 75) return "75-89";
  if (confidence >= 60) return "60-74";
  return "<60";
}
function getConfidenceTier(confidence, folderName) {
  if (confidence >= BASE_THRESHOLDS.auto_sort) return "auto_sort";
  if (confidence >= BASE_THRESHOLDS.notify) return "notify";
  if (confidence >= BASE_THRESHOLDS.suggest) return "suggest";
  return "manual_review";
}
function recordClassification(aiGuess, aiConfidence, userChoice, wasCorrect) {
  const store = loadStore();
  store.total_classifications++;
  if (!wasCorrect) store.total_corrections++;
  const tierKey = getTierKey(aiConfidence);
  const tierStat = store.tier_stats.find((t) => t.tier === tierKey);
  if (tierStat) {
    tierStat.predictions++;
    if (wasCorrect) tierStat.correct++;
    tierStat.accuracy = tierStat.predictions > 0 ? tierStat.correct / tierStat.predictions : 1;
  }
  if (!wasCorrect && aiGuess && userChoice && aiGuess !== userChoice) {
    recordConfusion(store, aiGuess, userChoice);
    recordRuleOutcomeInStore(store, aiGuess, userChoice, false);
  } else if (wasCorrect && aiGuess) {
    recordRuleOutcomeInStore(store, aiGuess, "", true);
  }
  saveStore(store);
}
function recordConfusion(store, aiGuess, userChoice) {
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
      last_occurrence: Date.now()
    };
    store.confusion_pairs.push(pair);
  }
  if (aiGuess === folderA) {
    pair.a_to_b++;
  } else {
    pair.b_to_a++;
  }
  pair.total++;
  pair.last_occurrence = Date.now();
  if (pair.total >= DISAMBIGUATION_TRIGGER_COUNT && !store.disambiguation_rules.find(
    (r) => r.folder_a === folderA && r.folder_b === folderB
  )) {
    console.log(
      `[AccuracyMonitor] Confusion pair "${folderA}" \u2194 "${folderB}" hit ${DISAMBIGUATION_TRIGGER_COUNT}+ confusions \u2014 queuing disambiguation rule generation.`
    );
  }
}
function generateDisambiguationRule(folderA, folderB, poolA, poolB) {
  const setA = new Set(poolA.map((t) => t.toLowerCase()));
  const setB = new Set(poolB.map((t) => t.toLowerCase()));
  const aIndicators = poolA.filter((t) => !setB.has(t.toLowerCase()) && t.length >= 3).slice(0, 10);
  const bIndicators = poolB.filter((t) => !setA.has(t.toLowerCase()) && t.length >= 3).slice(0, 10);
  if (aIndicators.length === 0 && bIndicators.length === 0) {
    console.log(
      `[AccuracyMonitor] Cannot generate disambiguation rule for "${folderA}" vs "${folderB}" \u2014 no exclusive terms found.`
    );
    return null;
  }
  const rule = {
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
    last_used: 0
  };
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
    `[AccuracyMonitor] Disambiguation rule generated: "${folderA}" vs "${folderB}" (${aIndicators.length} A-indicators, ${bIndicators.length} B-indicators)`
  );
  return rule;
}
function applyDisambiguationRules(filename, fileContent) {
  const store = loadStore();
  if (store.disambiguation_rules.length === 0) return null;
  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent ? fileContent.split(/\s+/).slice(0, 500).join(" ") : "";
  const searchText = (nameNoExt + " " + contentHead).toLowerCase();
  const now = Date.now();
  let storeChanged = false;
  for (const rule of store.disambiguation_rules) {
    if (rule.disabled) continue;
    const staleSince = rule.last_used > 0 ? rule.last_used : rule.generated_at;
    if (now - staleSince > RULE_EXPIRY_MS) {
      console.log(
        `[AccuracyMonitor] Rule "${rule.folder_a}" \u2194 "${rule.folder_b}" expired (${RULE_EXPIRY_DAYS}d since last use). Disabling.`
      );
      rule.disabled = true;
      storeChanged = true;
      continue;
    }
    const aHits = rule.a_indicators.filter(
      (t) => searchText.includes(t.toLowerCase())
    ).length;
    const bHits = rule.b_indicators.filter(
      (t) => searchText.includes(t.toLowerCase())
    ).length;
    if (aHits > bHits && aHits >= 2 || bHits > aHits && bHits >= 2) {
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
function recordRuleOutcomeInStore(store, folderA, folderB, wasCorrect) {
  for (const rule of store.disambiguation_rules) {
    if (rule.disabled) continue;
    if (rule.uses === 0) continue;
    const ruleCoversFailure = !wasCorrect && (rule.folder_a === folderA && rule.folder_b === folderB || rule.folder_b === folderA && rule.folder_a === folderB || rule.folder_a === folderA && folderB === "" || rule.folder_b === folderA && folderB === "");
    const ruleCoverSuccess = wasCorrect && (rule.folder_a === folderA || rule.folder_b === folderA);
    if (ruleCoversFailure) {
      rule.failures++;
    } else if (ruleCoverSuccess) {
      rule.successes++;
    } else {
      continue;
    }
    const totalOutcomes = rule.successes + rule.failures;
    rule.success_rate = totalOutcomes > 0 ? rule.successes / totalOutcomes : -1;
    if (totalOutcomes >= MIN_USES_FOR_DISABLE && rule.success_rate < MIN_SUCCESS_RATE) {
      rule.disabled = true;
      console.log(
        `[AccuracyMonitor] Rule "${rule.folder_a}" \u2194 "${rule.folder_b}" auto-disabled: success_rate=${Math.round(rule.success_rate * 100)}% after ${totalOutcomes} outcomes (min ${Math.round(MIN_SUCCESS_RATE * 100)}%)`
      );
    }
  }
}
function disableDisambiguationRule(folderA, folderB) {
  const store = loadStore();
  const [a, b] = [folderA, folderB].sort();
  const rule = store.disambiguation_rules.find(
    (r) => r.folder_a === a && r.folder_b === b
  );
  if (!rule) return false;
  rule.disabled = true;
  saveStore(store);
  console.log(`[AccuracyMonitor] Rule "${a}" \u2194 "${b}" manually disabled.`);
  return true;
}
function pruneRulesForDeletedFolders(activeFolders) {
  const store = loadStore();
  const folderSet = new Set(activeFolders.map((f) => f.toLowerCase()));
  const before = store.disambiguation_rules.length;
  store.disambiguation_rules = store.disambiguation_rules.filter(
    (r) => folderSet.has(r.folder_a.toLowerCase()) && folderSet.has(r.folder_b.toLowerCase())
  );
  const removed = before - store.disambiguation_rules.length;
  if (removed > 0) {
    saveStore(store);
    console.log(`[AccuracyMonitor] Pruned ${removed} rules for deleted folders.`);
  }
  return removed;
}
function getConfusionPairs() {
  return loadStore().confusion_pairs.sort((a, b) => b.total - a.total);
}
function getTierStats() {
  return loadStore().tier_stats;
}
function getDisambiguationRules() {
  return loadStore().disambiguation_rules;
}
function getPendingDisambiguationPairs() {
  const store = loadStore();
  const ruledPairs = new Set(
    store.disambiguation_rules.map((r) => `${r.folder_a}|${r.folder_b}`)
  );
  return store.confusion_pairs.filter(
    (p) => p.total >= DISAMBIGUATION_TRIGGER_COUNT && !ruledPairs.has(`${p.folder_a}|${p.folder_b}`)
  );
}
function getAccuracyStats() {
  const store = loadStore();
  const accuracy = store.total_classifications > 0 ? 1 - store.total_corrections / store.total_classifications : 1;
  return {
    total: store.total_classifications,
    corrections: store.total_corrections,
    accuracy,
    tierStats: store.tier_stats,
    topConfusionPairs: store.confusion_pairs.sort((a, b) => b.total - a.total).slice(0, 10)
  };
}
function resetAccuracyData() {
  saveStore({
    confusion_pairs: [],
    tier_stats: initTierStats(),
    disambiguation_rules: [],
    total_classifications: 0,
    total_corrections: 0,
    last_updated: Date.now()
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  applyDisambiguationRules,
  disableDisambiguationRule,
  generateDisambiguationRule,
  getAccuracyStats,
  getConfidenceTier,
  getConfusionPairs,
  getDisambiguationRules,
  getPendingDisambiguationPairs,
  getTierStats,
  pruneRulesForDeletedFolders,
  recordClassification,
  resetAccuracyData
});
