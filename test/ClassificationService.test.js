/**
 * ClassificationService.test.js — public API smoke tests.
 *
 * The waterfall itself requires the full ContextService + Llama runtime,
 * so we focus on the deterministic, exported helpers that have no AI
 * dependency:
 *
 *   - findExistingEquivalent (folder dedup / abbreviation resolution)
 *   - getResultConfidenceTier (confidence → tier label)
 *
 * These are the helpers other services consume directly (UI shows tiers,
 * RenameService calls findExistingEquivalent), so regressions here would
 * be user-visible immediately.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findExistingEquivalent,
  getResultConfidenceTier,
} = require("../src/main/services/ClassificationService");

// ── findExistingEquivalent ─────────────────────────────────────────────

test("findExistingEquivalent returns null for empty inputs", () => {
  assert.equal(findExistingEquivalent("", ["Math"]), null);
  assert.equal(findExistingEquivalent("Math", []), null);
});

test("findExistingEquivalent matches exact name regardless of case", () => {
  assert.equal(findExistingEquivalent("math", ["Math"]), "Math");
  assert.equal(findExistingEquivalent("MATH", ["Math"]), "Math");
});

test("findExistingEquivalent normalizes separators (Pre-Calc ↔ PreCalc)", () => {
  assert.equal(findExistingEquivalent("Pre-Calc", ["PreCalc"]), "PreCalc");
  assert.equal(findExistingEquivalent("pre_calc", ["Pre Calc"]), "Pre Calc");
});

test("findExistingEquivalent resolves common abbreviations (Calculus ↔ Calc)", () => {
  assert.equal(findExistingEquivalent("Calculus", ["Calc"]), "Calc");
  assert.equal(findExistingEquivalent("Bio", ["Biology"]), "Biology");
  assert.equal(findExistingEquivalent("Statistics", ["Stats"]), "Stats");
});

test("findExistingEquivalent returns null when no folder is close enough", () => {
  assert.equal(findExistingEquivalent("Photography", ["Math", "Science"]), null);
});

test("findExistingEquivalent fuzzy-matches substrings only when ratio >= 0.6", () => {
  // "AP Bio" (5 chars normalized) vs "Biology" (7 chars normalized): "bio"
  // is a substring of "biology" — short/long = 3/7 ≈ 0.43 → should NOT match
  // by the substring rule, but the abbreviation rule WILL map Bio→Biology.
  assert.equal(findExistingEquivalent("Bio", ["Biology"]), "Biology");

  // Truly unrelated short tokens should not collide
  assert.equal(findExistingEquivalent("AB", ["AcademicBoard"]), null);
});

// ── getResultConfidenceTier ────────────────────────────────────────────

test("getResultConfidenceTier returns a tier descriptor for each confidence", () => {
  const tierLow = getResultConfidenceTier(20);
  const tierMid = getResultConfidenceTier(65);
  const tierHigh = getResultConfidenceTier(95);
  // The exact tier names live in accuracy-monitor — we just assert the API
  // returns an object/string and never throws.
  assert.ok(tierLow !== undefined);
  assert.ok(tierMid !== undefined);
  assert.ok(tierHigh !== undefined);
});

test("getResultConfidenceTier accepts an optional folder argument without throwing", () => {
  assert.doesNotThrow(() => getResultConfidenceTier(80, "Math"));
});
