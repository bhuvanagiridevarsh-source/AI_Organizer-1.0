/**
 * universal-pool-manager.test.js
 *
 * Pure-data tests over the pool sanitization helpers.  These are the
 * functions ClassificationService leans on to decide whether a term is
 * distinctive enough to belong to a folder vs. being noise.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeDistinctivenessScore,
  detectGenericTerms,
  detectCrossContamination,
  sanitizePools,
  validateTermForFolder,
  readMergedPool,
} = require("../src/main/intelligence/universal-pool-manager");

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// ── detectGenericTerms ─────────────────────────────────────────────────

test("detectGenericTerms returns empty set when there are no pools", () => {
  assert.equal(detectGenericTerms({}).size, 0);
});

test("detectGenericTerms flags terms appearing in many folders (>=40%)", () => {
  const pools = {
    Math: ["equation", "report"],
    Science: ["cell", "report"],
    English: ["essay", "report"],
    History: ["war", "report"],
    Art: ["paint", "report"],
  };
  // "report" appears in 5/5 folders → 100% → generic
  const generic = detectGenericTerms(pools);
  assert.ok(generic.has("report"));
  assert.ok(!generic.has("equation"));
});

test("detectGenericTerms keeps folder-unique terms even with case differences", () => {
  // Need enough folders that 1/N stays below the 40% generic threshold.
  const pools = {
    Math: ["Equation", "EQUATION"],
    Science: ["cell"],
    English: ["essay"],
    History: ["war"],
  };
  const generic = detectGenericTerms(pools);
  // "equation" only in Math → 1/4 = 25% < 40% threshold → NOT generic
  assert.ok(!generic.has("equation"));
});

// ── computeDistinctivenessScore ────────────────────────────────────────

test("computeDistinctivenessScore is 100 when no folders exist", () => {
  assert.equal(computeDistinctivenessScore("x", new Map(), 0), 100);
});

test("computeDistinctivenessScore is highest when term appears in 1/N folders", () => {
  const pools = { A: ["unique"], B: ["other"], C: ["other2"], D: ["other3"] };
  // Build the term→folder map the way the implementation does
  const map = new Map();
  for (const [folder, terms] of Object.entries(pools)) {
    for (const t of terms) {
      const key = t.toLowerCase().trim();
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(folder);
    }
  }
  // "unique" in 1/4 → distinctiveness = 75%
  assert.equal(computeDistinctivenessScore("unique", map, 4), 75);
});

// ── detectCrossContamination ───────────────────────────────────────────

test("detectCrossContamination flags terms shared by unrelated folders", () => {
  const pools = {
    Finance: ["invoice", "receipt", "tax"],
    Vacation: ["beach", "hotel", "invoice"], // "invoice" leaked into Vacation
  };
  const cont = detectCrossContamination(pools);
  assert.ok(cont.has("invoice"));
  assert.deepEqual(
    [...cont.get("invoice")].sort(),
    ["Finance", "Vacation"].sort()
  );
});

// ── sanitizePools ──────────────────────────────────────────────────────

test("sanitizePools removes generic AND cross-contaminated terms", () => {
  const pools = {
    Finance: ["invoice", "report"],
    Legal:   ["contract", "report"],
    HR:      ["resume", "report"],
    Vacation: ["beach", "invoice"], // contaminates "invoice" into unrelated folder
  };
  const { cleanedPools, stats } = sanitizePools(pools);
  // "report" generic (4/4) → removed everywhere
  for (const f of Object.keys(cleanedPools)) {
    assert.ok(!cleanedPools[f].includes("report"), `${f} should not retain generic "report"`);
  }
  assert.ok(stats.genericRemoved >= 4);
  assert.ok(stats.afterTotal < stats.beforeTotal);
});

// ── validateTermForFolder ──────────────────────────────────────────────

test("validateTermForFolder rejects terms shorter than 3 chars", () => {
  const v = validateTermForFolder("ab", "Math", { Math: ["equation"] });
  assert.equal(v.allowed, false);
  assert.match(v.reason, /too short/i);
});

test("validateTermForFolder rejects a term already generic in current pools", () => {
  const pools = {
    A: ["common"], B: ["common"], C: ["common"], D: ["common"], E: ["x"],
  };
  const v = validateTermForFolder("common", "E", pools);
  assert.equal(v.allowed, false);
  assert.match(v.reason, /generic/i);
});

test("validateTermForFolder accepts a distinctive new term", () => {
  const pools = { Finance: ["invoice"], Legal: ["contract"], HR: ["resume"] };
  const v = validateTermForFolder("amortization", "Finance", pools);
  assert.equal(v.allowed, true);
  assert.ok(v.distinctivenessScore >= 25);
});

// ── readMergedPool ─────────────────────────────────────────────────────

test("readMergedPool returns {} when neither file exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-test-"));
  assert.deepEqual(readMergedPool(dir), {});
});

test("readMergedPool merges global_concepts.json with knowledge_base.json, deduping", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-test-"));
  fs.writeFileSync(
    path.join(dir, "global_concepts.json"),
    JSON.stringify({ Math: ["equation", "formula"], Science: ["cell"] })
  );
  fs.writeFileSync(
    path.join(dir, "knowledge_base.json"),
    JSON.stringify({ Math: ["formula", "polynomial"], History: ["war"] })
  );
  const merged = readMergedPool(dir);
  assert.ok(merged.Math.includes("equation"));
  assert.ok(merged.Math.includes("polynomial"));
  // "formula" appeared in both — must NOT be duplicated
  assert.equal(merged.Math.filter((t) => t === "formula").length, 1);
  assert.deepEqual(merged.Science, ["cell"]);
  assert.deepEqual(merged.History, ["war"]);
});
