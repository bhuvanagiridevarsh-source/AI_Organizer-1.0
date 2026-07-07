/**
 * InsightsService.test.js — storage report + duplicate archiving.
 *
 * The archive action moves user files, so it inherits fileService's
 * guarantees — but the grouping logic itself must be exact: a false
 * "duplicate" here means the app files away a document the user believes
 * is unique. Only byte-identical files may ever share a group.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { scanInsights, archiveDuplicates, DUPLICATES_DIR } =
  require("../src/main/services/InsightsService");

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "insights-test-"));
}

function seed(dir) {
  // Two exact duplicates of "report.pdf" content + one near-miss (differs by 1 byte)
  fs.mkdirSync(path.join(dir, "Documents"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Downloads"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Documents", "report.pdf"), "SAME-CONTENT-ABC");
  fs.writeFileSync(path.join(dir, "Downloads", "report copy.pdf"), "SAME-CONTENT-ABC");
  fs.writeFileSync(path.join(dir, "Downloads", "report-v2.pdf"), "SAME-CONTENT-ABD"); // NOT a dupe
  // Same size, different content — must not group
  fs.writeFileSync(path.join(dir, "a.txt"), "1234567890");
  fs.writeFileSync(path.join(dir, "b.txt"), "0987654321");
  // Loose file in root
  fs.writeFileSync(path.join(dir, "loose.txt"), "loose");
}

test("scanInsights: categories, totals, and EXACT duplicate grouping", async () => {
  const dir = makeTmpDir();
  seed(dir);

  const report = await scanInsights(dir);

  assert.equal(report.totals.files, 6);
  assert.ok(report.categories.find((c) => c.name === "Documents"));
  assert.ok(report.categories.find((c) => c.name === "(loose files)"));

  // Exactly ONE duplicate group (the two SAME-CONTENT-ABC files).
  // report-v2 (1-byte diff, same size) and a/b.txt (same size) must NOT match.
  assert.equal(report.totals.duplicateGroups, 1);
  const g = report.duplicates[0];
  assert.equal(g.remove.length, 1);
  assert.equal(g.wasteBytes, Buffer.byteLength("SAME-CONTENT-ABC"));
  const names = [g.keep.name, g.remove[0].name].sort();
  assert.deepEqual(names, ["report copy.pdf", "report.pdf"]);
});

test("scanInsights skips symlinks and hidden files", async (t) => {
  if (process.platform === "win32") return t.skip("symlinks not tested on Windows");
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, "real.txt"), "real");
  fs.writeFileSync(path.join(dir, ".hidden"), "hidden");
  fs.symlinkSync(path.join(dir, "real.txt"), path.join(dir, "link.txt"));

  const report = await scanInsights(dir);
  assert.equal(report.totals.files, 1, "only the real file counts");
  assert.equal(report.totals.duplicateGroups, 0, "symlink must not read as a duplicate");
});

test("archiveDuplicates keeps the keeper, moves copies, never deletes bytes", async () => {
  const dir = makeTmpDir();
  seed(dir);
  const report = await scanInsights(dir);

  const undoPairs = [];
  const result = await archiveDuplicates(dir, report.duplicates, async (from, to) => {
    undoPairs.push({ from, to });
  });

  assert.equal(result.moved, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(undoPairs.length, 1, "every move must hit the undo log");

  // Keeper still in place
  assert.ok(fs.existsSync(report.duplicates[0].keep.path));
  // Copy moved into _Duplicates with its origin-folder prefix, content intact
  const archived = fs.readdirSync(path.join(dir, DUPLICATES_DIR));
  assert.equal(archived.length, 1);
  assert.ok(archived[0].includes("__"), `archived name keeps origin context: ${archived[0]}`);
  assert.equal(
    fs.readFileSync(path.join(dir, DUPLICATES_DIR, archived[0]), "utf8"),
    "SAME-CONTENT-ABC"
  );
  // Non-duplicates untouched
  assert.ok(fs.existsSync(path.join(dir, "Downloads", "report-v2.pdf")));
});

test("rescanning after archive finds no duplicates (archive dir is excluded)", async () => {
  const dir = makeTmpDir();
  seed(dir);
  const report = await scanInsights(dir);
  await archiveDuplicates(dir, report.duplicates);

  const after = await scanInsights(dir);
  assert.equal(after.totals.duplicateGroups, 0);
  // _Duplicates content must not be re-counted
  assert.ok(!after.categories.find((c) => c.name === DUPLICATES_DIR));
});

test("archiveDuplicates skips a group whose keeper vanished (safety check)", async () => {
  const dir = makeTmpDir();
  seed(dir);
  const report = await scanInsights(dir);

  fs.unlinkSync(report.duplicates[0].keep.path); // user deleted the keeper mid-flow

  const result = await archiveDuplicates(dir, report.duplicates);
  assert.equal(result.moved, 0, "must not archive when the kept copy is gone");
  assert.equal(result.failed.length, 1);
  // The would-be-archived copy is still where it was
  assert.ok(fs.existsSync(report.duplicates[0].remove[0].path));
});

// ── Screenshot sweeper ──────────────────────────────────────────────────

const { sweepScreenshots, isScreenshot, SCREENSHOTS_DIR } =
  require("../src/main/services/InsightsService");

test("isScreenshot: catches real conventions, ignores lookalikes", () => {
  for (const yes of [
    "Screen Shot 2026-03-01 at 9.14.02 AM.png",
    "Screenshot (44).png",
    "Screenshot_20260301_091402.jpg",
    "screenshot.png",
    "CleanShot 2026-03-01 at 09.14.02.png",
    "SCR_20260301.png",
  ]) assert.equal(isScreenshot(yes), true, yes);

  for (const no of [
    "Screenshot notes.docx",       // not an image
    "my screenshot collage.png",   // pattern is not at start
    "beach.png",
    "screenplay_draft.png",
  ]) assert.equal(isScreenshot(no), false, no);
});

test("sweepScreenshots files by capture month, undo-logged, nothing lost", async () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, "Screenshot 2026-03-01 at 9.00.00 AM.png"), "SHOT-A");
  fs.writeFileSync(path.join(dir, "Screenshot (2).png"), "SHOT-B"); // no date in name → mtime
  fs.writeFileSync(path.join(dir, "beach.png"), "NOT-A-SHOT");

  const report = await scanInsights(dir);
  assert.equal(report.totals.screenshots, 2);

  const undo = [];
  const result = await sweepScreenshots(dir, report.screenshots, async (f, t) => undo.push([f, t]));
  assert.equal(result.moved, 2);
  assert.equal(undo.length, 2);

  // Dated one landed in 2026-03; both contents survive somewhere under Screenshots/
  assert.ok(fs.existsSync(path.join(dir, SCREENSHOTS_DIR, "2026-03", "Screenshot 2026-03-01 at 9.00.00 AM.png")));
  assert.ok(fs.existsSync(path.join(dir, "beach.png")), "non-screenshot untouched");

  // Re-scan: swept screenshots no longer counted (they live in Screenshots/ now)
  const after = await scanInsights(dir);
  assert.equal(after.totals.screenshots, 0);
});
