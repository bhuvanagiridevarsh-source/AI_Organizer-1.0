/**
 * hashUtil.js — Streaming SHA-256 for file copy/move verification.
 *
 * Size-only checks miss content corruption (same length, different bytes).
 * For any operation that deletes the source after a copy (cross-fs move) or
 * confirms that a file was uploaded successfully (cloud sync), we should
 * verify by content hash, not just size.
 *
 * Uses a stream so we don't load multi-GB files into RAM.
 */

const fs = require("fs");
const crypto = require("crypto");

/**
 * Compute the SHA-256 hash of a file by streaming its bytes.
 * @param {string} filePath
 * @returns {Promise<string>} lowercase hex digest
 */
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Verify two files have identical content.  Cheap size check first, then full
 * SHA-256 stream comparison.  Both files must exist.
 * @param {string} a
 * @param {string} b
 * @returns {Promise<boolean>}
 */
async function filesMatch(a, b) {
  const fsp = fs.promises;
  const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
  if (sa.size !== sb.size) return false;
  if (sa.size === 0) return true; // both empty → identical, skip hashing
  const [ha, hb] = await Promise.all([hashFile(a), hashFile(b)]);
  return ha === hb;
}

module.exports = { hashFile, filesMatch };
