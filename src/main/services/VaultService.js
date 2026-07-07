/**
 * VaultService.js — encrypted local folder for sensitive documents.
 *
 * The PII detector already knows which files are sensitive (SSNs, passports,
 * contracts). Vault mode gives them a real home: AES-256-GCM blobs inside
 * <baseDir>/_Vault, unreadable by anything but this app on this machine.
 *
 * Key management:
 *   - One random 256-bit vault key, generated on first use.
 *   - At rest the key is wrapped by Electron's safeStorage (OS keychain/DPAPI),
 *     stored as vault.key in userData. No passphrase UX to forget.
 *   - If safeStorage is unavailable, vault mode is DISABLED — we never store
 *     a plaintext key on disk.
 *
 * Data safety rules (same religion as fileService):
 *   - Encrypt first, VERIFY by decrypting and hashing against the source,
 *     and only then delete the plaintext original.
 *   - Restore verifies the GCM auth tag (tamper-evident by construction).
 *   - Manifest (vault.manifest.json) maps blob ids → original name/path,
 *     and is itself encrypted with the same key.
 *
 * Blob format (.sjvault):
 *   [ 8B magic "SJVAULT1" ][ 12B IV ][ 16B GCM tag ][ ciphertext ]
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { hashFile } = require("./hashUtil");

const MAGIC = Buffer.from("SJVAULT1");
const VAULT_DIRNAME = "_Vault";
const ALGO = "aes-256-gcm";

// ── Blob primitives (pure — unit tested with an injected key) ──────────

/** Encrypt srcPath → destPath (blob). Streams; never loads whole file. */
function encryptFileToBlob(srcPath, destPath, key) {
  return new Promise((resolve, reject) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const input = fs.createReadStream(srcPath);
    const output = fs.createWriteStream(destPath, { flags: "wx" }); // never clobber

    // Reserve space for magic+iv+tag header, then stream ciphertext.
    output.write(Buffer.concat([MAGIC, iv, Buffer.alloc(16)])); // tag patched after

    input.on("error", reject);
    output.on("error", reject);
    input.pipe(cipher).pipe(output, { end: false });
    cipher.on("error", reject);
    cipher.on("end", async () => {
      try {
        output.end();
        await new Promise((res, rej) => output.on("close", res).on("error", rej));
        // Patch the auth tag into the header (offset: 8 magic + 12 iv)
        const tag = cipher.getAuthTag();
        const fh = await fsp.open(destPath, "r+");
        try { await fh.write(tag, 0, 16, MAGIC.length + 12); } finally { await fh.close(); }
        resolve();
      } catch (err) { reject(err); }
    });
  });
}

/** Decrypt blobPath → outPath. Rejects on tampered/garbled blobs (GCM tag). */
function decryptBlobToFile(blobPath, outPath, key) {
  return new Promise((resolve, reject) => {
    (async () => {
      const fh = await fsp.open(blobPath, "r");
      const header = Buffer.alloc(MAGIC.length + 12 + 16);
      await fh.read(header, 0, header.length, 0);
      await fh.close();

      if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error("Not a vault blob (bad magic)");
      }
      const iv = header.subarray(MAGIC.length, MAGIC.length + 12);
      const tag = header.subarray(MAGIC.length + 12);

      const decipher = crypto.createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);

      const input = fs.createReadStream(blobPath, { start: header.length });
      const output = fs.createWriteStream(outPath, { flags: "wx" });
      input.on("error", reject);
      output.on("error", reject);
      decipher.on("error", (err) => {
        // Auth failure = tampered or wrong key. Clean up the partial output.
        fs.promises.unlink(outPath).catch(() => {});
        reject(new Error(`Vault decryption failed (tampered or wrong key): ${err.message}`));
      });
      output.on("close", resolve);
      input.pipe(decipher).pipe(output);
    })().catch(reject);
  });
}

// ── Manifest (encrypted JSON) ───────────────────────────────────────────

function _manifestPath(vaultDir) { return path.join(vaultDir, "vault.manifest.enc"); }

function _encryptBuffer(buf, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
}

function _decryptBuffer(buf, key) {
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Bad manifest magic");
  const iv = buf.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = buf.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const ct = buf.subarray(MAGIC.length + 28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

async function loadManifest(vaultDir, key) {
  try {
    const raw = await fsp.readFile(_manifestPath(vaultDir));
    return JSON.parse(_decryptBuffer(raw, key).toString("utf8"));
  } catch {
    return { entries: [] };
  }
}

async function saveManifest(vaultDir, key, manifest) {
  const tmp = _manifestPath(vaultDir) + ".tmp";
  await fsp.writeFile(tmp, _encryptBuffer(Buffer.from(JSON.stringify(manifest)), key));
  await fsp.rename(tmp, _manifestPath(vaultDir));
}

// ── High-level operations ───────────────────────────────────────────────

/**
 * Move a plaintext file INTO the vault.
 * Encrypt → decrypt-verify against source hash → delete original.
 * @returns {Promise<{id: string, name: string}>}
 */
async function vaultFile(srcPath, baseDir, key) {
  const st = await fsp.lstat(srcPath);
  if (!st.isFile()) throw new Error("Only regular files can be vaulted");

  const vaultDir = path.join(baseDir, VAULT_DIRNAME);
  await fsp.mkdir(vaultDir, { recursive: true });

  const id = crypto.randomUUID();
  const blobPath = path.join(vaultDir, `${id}.sjvault`);
  const srcHash = await hashFile(srcPath);

  await encryptFileToBlob(srcPath, blobPath, key);

  // VERIFY: decrypt to temp, hash must match source, else abort (source kept)
  const verifyPath = path.join(vaultDir, `.verify_${id}`);
  try {
    await decryptBlobToFile(blobPath, verifyPath, key);
    const roundTrip = await hashFile(verifyPath);
    if (roundTrip !== srcHash) throw new Error("Round-trip hash mismatch");
  } catch (err) {
    await fsp.unlink(blobPath).catch(() => {});
    await fsp.unlink(verifyPath).catch(() => {});
    throw new Error(`Vaulting aborted, original untouched: ${err.message}`);
  }
  await fsp.unlink(verifyPath).catch(() => {});

  const manifest = await loadManifest(vaultDir, key);
  manifest.entries.push({
    id,
    name: path.basename(srcPath),
    originalPath: srcPath,
    size: st.size,
    sha256: srcHash,
    vaultedAt: Date.now(),
  });
  await saveManifest(vaultDir, key, manifest);

  // Only now remove the plaintext original
  await fsp.unlink(srcPath);
  return { id, name: path.basename(srcPath) };
}

/**
 * Restore a vaulted file back to disk (original location, or destDir).
 * Verifies content hash against the manifest record.
 */
async function restoreFile(id, baseDir, key, destDir) {
  const vaultDir = path.join(baseDir, VAULT_DIRNAME);
  const manifest = await loadManifest(vaultDir, key);
  const entry = manifest.entries.find((e) => e.id === id);
  if (!entry) throw new Error("No such vault entry");

  const blobPath = path.join(vaultDir, `${id}.sjvault`);
  const targetDir = destDir || path.dirname(entry.originalPath);
  await fsp.mkdir(targetDir, { recursive: true });

  // Never clobber: suffix if the name is taken
  let outPath = path.join(targetDir, entry.name);
  const ext = path.extname(entry.name);
  const base = path.basename(entry.name, ext);
  for (let i = 1; fs.existsSync(outPath) && i < 10000; i++) {
    outPath = path.join(targetDir, `${base}_${i}${ext}`);
  }

  await decryptBlobToFile(blobPath, outPath, key);
  const restoredHash = await hashFile(outPath);
  if (entry.sha256 && restoredHash !== entry.sha256) {
    await fsp.unlink(outPath).catch(() => {});
    throw new Error("Restored content failed hash verification — blob corrupt, kept in vault");
  }

  manifest.entries = manifest.entries.filter((e) => e.id !== id);
  await saveManifest(vaultDir, key, manifest);
  await fsp.unlink(blobPath).catch(() => {});
  return outPath;
}

async function listVault(baseDir, key) {
  const vaultDir = path.join(baseDir, VAULT_DIRNAME);
  const manifest = await loadManifest(vaultDir, key);
  return manifest.entries.map(({ id, name, size, vaultedAt, originalPath }) =>
    ({ id, name, size, vaultedAt, originalPath }));
}

// ── Key management (Electron-only; injected in tests) ──────────────────

/**
 * Get (or create) the vault key, wrapped by safeStorage.
 * Returns null if the OS keychain isn't available — vault disabled.
 */
function getVaultKey(userDataDir) {
  let safeStorage;
  try {
    ({ safeStorage } = require("electron"));
  } catch {
    return null;
  }
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;

  const keyFile = path.join(userDataDir, "vault.key");
  try {
    if (fs.existsSync(keyFile)) {
      return Buffer.from(safeStorage.decryptString(fs.readFileSync(keyFile)), "base64");
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, safeStorage.encryptString(key.toString("base64")));
    return key;
  } catch (err) {
    console.warn(`[VaultService] key unavailable: ${err.message}`);
    return null;
  }
}

module.exports = {
  vaultFile,
  restoreFile,
  listVault,
  getVaultKey,
  encryptFileToBlob,
  decryptBlobToFile,
  VAULT_DIRNAME,
};
