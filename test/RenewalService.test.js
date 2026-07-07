/**
 * RenewalService.test.js — the radar must catch real obligations and stay
 * quiet on noise. A missed expiry is a broken promise; a false one teaches
 * the user to ignore the feature.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { extractRenewals, buildRadar, upcoming } = require("../src/main/services/RenewalService");

// Fixed "now" so tests never rot: 2026-07-06
const NOW = Date.UTC(2026, 6, 6);

test("catches expiry, renewal, due, and warranty phrasings", () => {
  const text = `
    Your AppleCare coverage — warranty ends September 30, 2026.
    Domain sj-app.com renewal date: 2026-08-15.
    Invoice #4417 — payment due by 07/20/2026.
    Passport valid until 2031-01-09.
  `;
  const found = extractRenewals(text, NOW);
  const kinds = found.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ["due", "expiry", "renewal", "warranty"]);
  const dates = found.map((f) => new Date(f.dateMs).toISOString().slice(0, 10)).sort();
  assert.deepEqual(dates, ["2026-07-20", "2026-08-15", "2026-09-30", "2031-01-09"]);
});

test("every hit carries readable context", () => {
  const found = extractRenewals("Contract ends 2026-12-31 per section 4.", NOW);
  assert.equal(found.length, 1);
  assert.match(found[0].context, /Contract ends 2026-12-31/i);
});

test("ignores dates without obligation language", () => {
  const text = "Meeting notes from March 5, 2026. Photo taken 2026-01-02. Born 1994-06-01.";
  assert.deepEqual(extractRenewals(text, NOW), []);
});

test("drops long-lapsed dates but keeps recently expired (90-day window)", () => {
  const text = "Warranty ends 2026-06-15. Old policy expires 2020-01-01.";
  const found = extractRenewals(text, NOW);
  assert.equal(found.length, 1, "2020 is long gone; 2026-06-15 is 21 days past — keep");
  assert.equal(new Date(found[0].dateMs).toISOString().slice(0, 10), "2026-06-15");
});

test("dedupes same kind+date; caps at 8 per document", () => {
  const line = "Payment due 2026-08-01. ";
  const found = extractRenewals(line.repeat(30), NOW);
  assert.equal(found.length, 1);
});

test("buildRadar sorts soonest-first across files and upcoming() filters horizon", () => {
  const entries = [
    { filename: "lease.pdf", folder: "Legal", fullPath: "/x/lease.pdf", fullText: "Lease term — end date: 2027-05-01" },
    { filename: "car.pdf", folder: "Insurance", fullPath: "/x/car.pdf", fullText: "coverage ends 2026-07-25" },
    { filename: "empty.txt", folder: "Misc", fullPath: "/x/empty.txt", fullText: "" },
  ];
  const radar = buildRadar(entries, NOW);
  assert.equal(radar.length, 2);
  assert.equal(radar[0].fileName, "car.pdf", "soonest first");
  assert.equal(radar[0].dateISO, "2026-07-25");

  const soon = upcoming(radar, 30, NOW);
  assert.equal(soon.length, 1);
  assert.equal(soon[0].fileName, "car.pdf");
});
