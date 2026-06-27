/**
 * ComplianceService.test.js
 *
 * Audits the audit log: the regression we're protecting against is silent
 * truncation when entries pass the rotation threshold.  Every entry written
 * must remain readable, either via the live log or via the dated archive.
 *
 * NOTE: this test loads the COMPILED ComplianceService.js (esbuild output).
 * Run `npm run compile` once before `npm test` after editing the .ts source.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function freshWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "compliance-test-"));
}

// Require fresh module instances per test — ComplianceService holds the
// workDir in module-level state so tests would interfere otherwise.
function loadCompliance() {
  const p = require.resolve("../src/main/services/ComplianceService");
  delete require.cache[p];
  return require("../src/main/services/ComplianceService");
}

test("writeAuditEntry persists entries readable via readAuditLog", () => {
  const dir = freshWorkDir();
  const C = loadCompliance();
  C.initCompliance(dir);
  C.writeAuditEntry("MOVED", { filename: "a.pdf", to: "/Finance/a.pdf" });
  C.writeAuditEntry("MOVED", { filename: "b.pdf", to: "/Finance/b.pdf" });

  const entries = C.readAuditLog();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].filename, "a.pdf");
  assert.equal(entries[1].filename, "b.pdf");
});

test("rotation does NOT drop entries — archive contains every overflow record", { timeout: 30_000 }, () => {
  const dir = freshWorkDir();
  const C = loadCompliance();
  C.initCompliance(dir);

  const TOTAL = 5200; // > MAX_ACTIVE_ENTRIES (5000), forces one rotation
  for (let i = 0; i < TOTAL; i++) {
    C.writeAuditEntry("MOVED", { filename: `f${i}.pdf`, to: `/X/f${i}.pdf` });
  }

  // Live log keeps the rolling window (~KEEP_AFTER_ROTATE entries)
  const live = C.readAuditLog();
  assert.ok(live.length <= 5000, `live log should be <=5000, got ${live.length}`);
  assert.ok(live.length >= 4000, `live log should retain ~4000 most-recent, got ${live.length}`);

  // includeArchives must return EVERY entry — nothing dropped
  const all = C.readAuditLog({ includeArchives: true });
  assert.equal(all.length, TOTAL, "no entries may be lost across rotation");

  // Archive dir exists and contains at least one JSONL file
  const archiveDir = path.join(dir, "compliance_audit_archives");
  assert.ok(fs.existsSync(archiveDir), "archive directory must be created");
  const archives = fs.readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl"));
  assert.ok(archives.length >= 1, "at least one archive file expected after overflow");
});

test("includeArchives merges archives in chronological order before live", () => {
  const dir = freshWorkDir();
  const C = loadCompliance();
  C.initCompliance(dir);

  for (let i = 0; i < 5050; i++) {
    C.writeAuditEntry("MOVED", { filename: `f${i}.pdf` });
  }
  const all = C.readAuditLog({ includeArchives: true });
  // First entry archived (f0) must precede last entry written (f5049)
  const firstIdx = all.findIndex((e) => e.filename === "f0.pdf");
  const lastIdx  = all.findIndex((e) => e.filename === "f5049.pdf");
  assert.ok(firstIdx !== -1, "earliest entry must still be retrievable");
  assert.ok(lastIdx > firstIdx, "newest entry must come after oldest");
});

test("getComplianceStats counts archived entries (no scoring sleight-of-hand)", () => {
  const dir = freshWorkDir();
  const C = loadCompliance();
  C.initCompliance(dir);

  for (let i = 0; i < 5100; i++) {
    C.writeAuditEntry("MOVED", { filename: `f${i}.pdf`, to: `/X/f${i}.pdf` });
  }
  const stats = C.getComplianceStats();
  assert.equal(stats.totalAuditEntries, 5100, "stats must include archived entries");
  assert.equal(stats.totalMoves,        5100, "moves must include archived MOVED entries");
});
