/**
 * VaultService.test.js — encryption that can lose a passport scan gets the
 * paranoid treatment: round-trip integrity, tamper detection, wrong-key
 * rejection, no-clobber restore, and the source-stays-until-verified rule.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const {
  vaultFile, restoreFile, listVault,
  encryptFileToBlob, decryptBlobToFile, VAULT_DIRNAME,
} = require("../src/main/services/VaultService");

const KEY = crypto.randomBytes(32);

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vault-test-"));
}

test("blob round-trip preserves bytes exactly (1 MB random)", async () => {
  const dir = makeTmpDir();
  const src = path.join(dir, "secret.bin");
  const data = crypto.randomBytes(1024 * 1024);
  fs.writeFileSync(src, data);

  const blob = path.join(dir, "secret.sjvault");
  await encryptFileToBlob(src, blob, KEY);
  assert.ok(!fs.readFileSync(blob).includes(data.subarray(0, 64)), "ciphertext must not contain plaintext");

  const out = path.join(dir, "restored.bin");
  await decryptBlobToFile(blob, out, KEY);
  assert.ok(fs.readFileSync(out).equals(data));
});

test("wrong key is rejected, no partial plaintext left behind", async () => {
  const dir = makeTmpDir();
  const src = path.join(dir, "a.txt");
  fs.writeFileSync(src, "top secret contents");
  const blob = path.join(dir, "a.sjvault");
  await encryptFileToBlob(src, blob, KEY);

  const out = path.join(dir, "leak.txt");
  await assert.rejects(() => decryptBlobToFile(blob, out, crypto.randomBytes(32)), /tampered or wrong key/);
  assert.equal(fs.existsSync(out), false, "partial output must be cleaned up");
});

test("tampered blob is rejected (GCM auth)", async () => {
  const dir = makeTmpDir();
  const src = path.join(dir, "a.txt");
  fs.writeFileSync(src, "audit me");
  const blob = path.join(dir, "a.sjvault");
  await encryptFileToBlob(src, blob, KEY);

  // Flip one ciphertext byte
  const buf = fs.readFileSync(blob);
  buf[buf.length - 1] ^= 0xff;
  fs.writeFileSync(blob, buf);

  await assert.rejects(() => decryptBlobToFile(blob, path.join(dir, "out.txt"), KEY), /tampered|wrong key/);
});

test("vaultFile: original deleted only after verified; listVault shows it", async () => {
  const base = makeTmpDir();
  const src = path.join(base, "passport_scan.pdf");
  fs.writeFileSync(src, "PASSPORT-DATA-123");

  const { id, name } = await vaultFile(src, base, KEY);
  assert.equal(name, "passport_scan.pdf");
  assert.equal(fs.existsSync(src), false, "plaintext original removed after verification");
  assert.ok(fs.existsSync(path.join(base, VAULT_DIRNAME, `${id}.sjvault`)));

  const listing = await listVault(base, KEY);
  assert.equal(listing.length, 1);
  assert.equal(listing[0].name, "passport_scan.pdf");
  assert.equal(listing[0].size, Buffer.byteLength("PASSPORT-DATA-123"));
});

test("restoreFile puts contents back at the original path and clears the entry", async () => {
  const base = makeTmpDir();
  const src = path.join(base, "Docs", "ssn.txt");
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, "123-45-6789");

  const { id } = await vaultFile(src, base, KEY);
  const outPath = await restoreFile(id, base, KEY);

  assert.equal(outPath, src, "restores to original location");
  assert.equal(fs.readFileSync(src, "utf8"), "123-45-6789");
  assert.deepEqual(await listVault(base, KEY), []);
  assert.equal(fs.existsSync(path.join(base, VAULT_DIRNAME, `${id}.sjvault`)), false, "blob removed");
});

test("restore never clobbers: existing file at original path gets suffix", async () => {
  const base = makeTmpDir();
  const src = path.join(base, "doc.txt");
  fs.writeFileSync(src, "VAULTED-VERSION");
  const { id } = await vaultFile(src, base, KEY);

  fs.writeFileSync(src, "NEW-FILE-SAME-NAME"); // user recreated the name

  const outPath = await restoreFile(id, base, KEY);
  assert.notEqual(outPath, src);
  assert.equal(fs.readFileSync(src, "utf8"), "NEW-FILE-SAME-NAME", "existing file untouched");
  assert.equal(fs.readFileSync(outPath, "utf8"), "VAULTED-VERSION");
});

test("manifest on disk is encrypted (no filenames readable)", async () => {
  const base = makeTmpDir();
  const src = path.join(base, "very_secret_lawsuit.pdf");
  fs.writeFileSync(src, "x");
  await vaultFile(src, base, KEY);

  const manifestRaw = fs.readFileSync(path.join(base, VAULT_DIRNAME, "vault.manifest.enc"));
  assert.ok(!manifestRaw.includes("very_secret_lawsuit"), "manifest must not leak names in plaintext");
});
