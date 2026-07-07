/**
 * fileService.test.js — safety net for the ONE component that can lose data.
 *
 * Every scenario here maps to a documented failure mode in EDGE_CASES.md:
 * silent overwrite on collision, ENAMETOOLONG on suffixing max-length names,
 * symlink targets being copied/deleted, directories swallowed as files.
 * If any of these regress, users lose files. Keep this suite paranoid.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const os = require("node:os");

const { safeMoveFile, resolveUniquePath, scanUserFolders, _fitName } =
  require("../src/main/services/fileService");

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "filesvc-test-"));
}

// ── Basic move ─────────────────────────────────────────────────────────────

test("safeMoveFile moves a file and preserves content", async () => {
  const dir = makeTmpDir();
  const src = path.join(dir, "a.txt");
  const dest = path.join(dir, "out", "a.txt");
  fs.writeFileSync(src, "content-A");

  const finalPath = await safeMoveFile(src, dest);

  assert.equal(finalPath, dest);
  assert.equal(fs.readFileSync(dest, "utf8"), "content-A");
  assert.equal(fs.existsSync(src), false, "source must be deleted after verified move");
});

// ── Collision: never overwrite ────────────────────────────────────────────

test("collision at destination suffixes instead of overwriting (both contents survive)", async () => {
  const dir = makeTmpDir();
  const destDir = path.join(dir, "out");
  const src1 = path.join(dir, "one", "invoice.pdf");
  const src2 = path.join(dir, "two", "invoice.pdf");
  fs.mkdirSync(path.dirname(src1), { recursive: true });
  fs.mkdirSync(path.dirname(src2), { recursive: true });
  fs.writeFileSync(src1, "INVOICE-CONTENT-1");
  fs.writeFileSync(src2, "INVOICE-CONTENT-2");

  const final1 = await safeMoveFile(src1, path.join(destDir, "invoice.pdf"));
  const final2 = await safeMoveFile(src2, path.join(destDir, "invoice.pdf"));

  assert.notEqual(final1, final2, "second move must get a different name");
  const contents = [fs.readFileSync(final1, "utf8"), fs.readFileSync(final2, "utf8")].sort();
  assert.deepEqual(contents, ["INVOICE-CONTENT-1", "INVOICE-CONTENT-2"]);
});

test("pre-existing file at destination is never clobbered", async () => {
  const dir = makeTmpDir();
  const destDir = path.join(dir, "Photos");
  fs.mkdirSync(destDir, { recursive: true });
  const existing = path.join(destDir, "beach.jpg");
  fs.writeFileSync(existing, "USER-ORIGINAL");

  const src = path.join(dir, "beach.jpg");
  fs.writeFileSync(src, "INCOMING-DIFFERENT");
  const finalPath = await safeMoveFile(src, path.join(destDir, "beach.jpg"));

  assert.equal(fs.readFileSync(existing, "utf8"), "USER-ORIGINAL", "pre-existing file untouched");
  assert.notEqual(finalPath, existing);
  assert.equal(fs.readFileSync(finalPath, "utf8"), "INCOMING-DIFFERENT");
});

test("concurrent moves to the same destination name never collide", async () => {
  const dir = makeTmpDir();
  const destDir = path.join(dir, "out");
  const sources = [];
  for (let i = 0; i < 8; i++) {
    const p = path.join(dir, `src${i}`, "report.pdf");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `content-${i}`);
    sources.push(p);
  }

  const finals = await Promise.all(
    sources.map((s) => safeMoveFile(s, path.join(destDir, "report.pdf")))
  );

  assert.equal(new Set(finals).size, 8, "all 8 moves must land on distinct names");
  const got = finals.map((f) => fs.readFileSync(f, "utf8")).sort();
  assert.deepEqual(got, [...Array(8).keys()].map((i) => `content-${i}`).sort());
});

// ── 255-byte filename limit (EDGE_CASES.md #3) ─────────────────────────────

test("_fitName keeps base+suffix+ext within 255 bytes, preserving the extension", () => {
  const base = "x".repeat(251); // 251 + ".pdf" = 255 exactly
  assert.equal(Buffer.byteLength(_fitName(base, "", ".pdf")), 255);

  // Adding a suffix would hit 257 — base must shrink, ext + suffix survive
  const suffixed = _fitName(base, "_1", ".pdf");
  assert.ok(Buffer.byteLength(suffixed) <= 255);
  assert.ok(suffixed.endsWith("_1.pdf"));
});

test("_fitName truncates by whole code points (never splits an emoji)", () => {
  const base = "🎉".repeat(70); // 280 bytes of 4-byte code points
  const out = _fitName(base, "_2", ".txt");
  assert.ok(Buffer.byteLength(out) <= 255);
  // Well-formed UTF-8 round-trips losslessly; a split surrogate would not.
  assert.equal(Buffer.from(out, "utf8").toString("utf8"), out);
  assert.ok(out.endsWith("_2.txt"));
});

test("moving a 255-byte-named file into a folder where it already exists succeeds via truncation", async () => {
  const dir = makeTmpDir();
  const destDir = path.join(dir, "out");
  const longBase = "L".repeat(251); // + ".txt" = 255 bytes
  const name = `${longBase}.txt`;

  const src1 = path.join(dir, "a", name);
  const src2 = path.join(dir, "b", name);
  fs.mkdirSync(path.dirname(src1), { recursive: true });
  fs.mkdirSync(path.dirname(src2), { recursive: true });
  fs.writeFileSync(src1, "long-1");
  fs.writeFileSync(src2, "long-2");

  const final1 = await safeMoveFile(src1, path.join(destDir, name));
  const final2 = await safeMoveFile(src2, path.join(destDir, name)); // would be 257 bytes naively

  assert.ok(Buffer.byteLength(path.basename(final2)) <= 255);
  assert.ok(path.basename(final2).endsWith("_1.txt"));
  const contents = [fs.readFileSync(final1, "utf8"), fs.readFileSync(final2, "utf8")].sort();
  assert.deepEqual(contents, ["long-1", "long-2"]);
});

// ── Symlinks (EDGE_CASES.md #6) ────────────────────────────────────────────

test("symlink is relocated as a link; its target is never copied or deleted", async (t) => {
  if (process.platform === "win32") return t.skip("symlink test not run on Windows CI");
  const dir = makeTmpDir();
  const external = path.join(dir, "external_secret.txt");
  fs.writeFileSync(external, "EXTERNAL-DO-NOT-TOUCH");

  const link = path.join(dir, "inbox", "shortcut.txt");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(external, link);

  const finalPath = await safeMoveFile(link, path.join(dir, "out", "shortcut.txt"));

  assert.equal(fs.readFileSync(external, "utf8"), "EXTERNAL-DO-NOT-TOUCH", "target untouched");
  assert.ok(fs.lstatSync(finalPath).isSymbolicLink(), "moved entry is still a symlink");
  assert.equal(fs.readlinkSync(finalPath), external, "link still points at the original target");
  assert.equal(fs.existsSync(link), false, "old link removed");
});

// ── Bad inputs ─────────────────────────────────────────────────────────────

test("directories are rejected, not moved", async () => {
  const dir = makeTmpDir();
  const sub = path.join(dir, "a-folder");
  fs.mkdirSync(sub);
  await assert.rejects(
    () => safeMoveFile(sub, path.join(dir, "out", "a-folder")),
    /directory/i
  );
  assert.ok(fs.existsSync(sub), "directory left in place");
});

test("missing source rejects without creating anything at the destination", async () => {
  const dir = makeTmpDir();
  const dest = path.join(dir, "out", "ghost.txt");
  await assert.rejects(() => safeMoveFile(path.join(dir, "ghost.txt"), dest));
  assert.equal(fs.existsSync(dest), false);
});

// ── resolveUniquePath / scanUserFolders ────────────────────────────────────

test("resolveUniquePath returns the input when free and suffixes when taken", async () => {
  const dir = makeTmpDir();
  const p = path.join(dir, "doc.txt");
  assert.equal(await resolveUniquePath(p), p);
  fs.writeFileSync(p, "x");
  assert.equal(await resolveUniquePath(p), path.join(dir, "doc_1.txt"));
});

test("scanUserFolders skips hidden/system folders and returns defaults when empty", async () => {
  const dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, ".hidden"));
  fs.mkdirSync(path.join(dir, "node_modules"));
  assert.deepEqual(await scanUserFolders(dir), ["Documents", "Images", "Financial"]);

  fs.mkdirSync(path.join(dir, "Taxes"));
  fs.mkdirSync(path.join(dir, "Taxes", "2026"));
  const folders = await scanUserFolders(dir);
  assert.ok(folders.includes("Taxes"));
  assert.ok(folders.includes("Taxes/2026"));
  assert.ok(!folders.includes("node_modules"));
});
