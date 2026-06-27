/**
 * hashUtil.test.js — SHA-256 streaming + file comparison.
 *
 * The hash helper underpins the CloudSync and fileService verification paths.
 * If `filesMatch` ever returns true for two files with different content, a
 * cross-filesystem move would silently delete the source after a corrupt copy.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const { hashFile, filesMatch } = require("../src/main/services/hashUtil");

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hashutil-test-"));
}

test("hashFile matches Node's one-shot SHA-256 for a small text file", async () => {
  const dir = makeTmpDir();
  const p = path.join(dir, "small.txt");
  const data = "hello world\n";
  fs.writeFileSync(p, data);

  const expected = crypto.createHash("sha256").update(data).digest("hex");
  const actual = await hashFile(p);
  assert.equal(actual, expected);
});

test("hashFile handles empty file (well-known empty-string SHA-256)", async () => {
  const dir = makeTmpDir();
  const p = path.join(dir, "empty.txt");
  fs.writeFileSync(p, "");
  const h = await hashFile(p);
  assert.equal(h, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("hashFile handles a larger random blob (>1 chunk)", async () => {
  const dir = makeTmpDir();
  const p = path.join(dir, "blob.bin");
  const data = crypto.randomBytes(256 * 1024); // 256KB — forces multiple stream chunks
  fs.writeFileSync(p, data);

  const expected = crypto.createHash("sha256").update(data).digest("hex");
  const actual = await hashFile(p);
  assert.equal(actual, expected);
});

test("filesMatch returns true for identical files", async () => {
  const dir = makeTmpDir();
  const a = path.join(dir, "a.bin"); const b = path.join(dir, "b.bin");
  const data = crypto.randomBytes(2048);
  fs.writeFileSync(a, data); fs.writeFileSync(b, data);
  assert.equal(await filesMatch(a, b), true);
});

test("filesMatch returns false for same-size DIFFERENT content (the bug the audit flagged)", async () => {
  // Same length, different bytes — exactly the corruption that size-only checks miss.
  const dir = makeTmpDir();
  const a = path.join(dir, "a.bin"); const b = path.join(dir, "b.bin");
  fs.writeFileSync(a, Buffer.from("AAAA1234"));
  fs.writeFileSync(b, Buffer.from("BBBB1234"));
  assert.equal(await filesMatch(a, b), false);
});

test("filesMatch returns false for different sizes (cheap path, no hashing)", async () => {
  const dir = makeTmpDir();
  const a = path.join(dir, "a.txt"); const b = path.join(dir, "b.txt");
  fs.writeFileSync(a, "short");
  fs.writeFileSync(b, "much longer text here");
  assert.equal(await filesMatch(a, b), false);
});

test("filesMatch returns true for two empty files (size-zero shortcut)", async () => {
  const dir = makeTmpDir();
  const a = path.join(dir, "a.txt"); const b = path.join(dir, "b.txt");
  fs.writeFileSync(a, ""); fs.writeFileSync(b, "");
  assert.equal(await filesMatch(a, b), true);
});
