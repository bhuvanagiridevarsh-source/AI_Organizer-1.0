/**
 * fileService.js — Atomic file move with duplicate-safe naming.
 *
 * safeMoveFile(src, dest) guarantees:
 *   1. No overwrites — appends _1, _2, etc. if dest exists
 *   2. Atomic on same filesystem (fs.rename)
 *   3. Cross-filesystem fallback: copy → verify → delete source
 *   4. Verification: destination must exist + match source size before
 *      the source is removed
 *
 * Usage:
 *   const { safeMoveFile } = require("./services/fileService");
 *   const finalPath = await safeMoveFile("/src/report.pdf", "/dst/report.pdf");
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { hashFile } = require("./hashUtil");

/**
 * Resolve a unique destination path. If `dest` already exists,
 * appends _1, _2, etc. before the extension.
 *
 * Example: /dst/report.pdf → /dst/report_1.pdf → /dst/report_2.pdf
 */
async function resolveUniquePath(dest) {
  // Fast path: destination doesn't exist
  try {
    await fsp.access(dest);
  } catch {
    return dest; // file does not exist — safe to use
  }

  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const base = path.basename(dest, ext);

  let counter = 1;
  let candidate;
  do {
    candidate = path.join(dir, `${base}_${counter}${ext}`);
    counter++;
    try {
      await fsp.access(candidate);
    } catch {
      return candidate; // doesn't exist — use it
    }
  } while (counter < 10000); // safety valve

  throw new Error(`Cannot find unique name for ${dest} after 10000 attempts`);
}

/**
 * Move a file atomically with overwrite protection.
 *
 * @param {string} source - Absolute path to source file
 * @param {string} destination - Desired destination path
 * @returns {Promise<string>} The actual final path (may have _N suffix)
 */
async function safeMoveFile(source, destination) {
  // 1. Verify source exists
  const srcStat = await fsp.stat(source);
  if (!srcStat.isFile()) {
    throw new Error(`Source is not a file: ${source}`);
  }

  // 2. Ensure destination directory exists
  const destDir = path.dirname(destination);
  await fsp.mkdir(destDir, { recursive: true });

  // 3. Resolve a unique name (no overwrites)
  const finalDest = await resolveUniquePath(destination);

  // 4. Try atomic rename first (works if same filesystem)
  try {
    await fsp.rename(source, finalDest);

    // 5. Verify the rename actually worked
    const destStat = await fsp.stat(finalDest);
    if (destStat.size !== srcStat.size) {
      throw new Error("Size mismatch after rename");
    }

    return finalDest;
  } catch (err) {
    // EXDEV = cross-device link — different filesystems
    if (err.code !== "EXDEV") {
      throw err;
    }
  }

  // 6. Cross-filesystem fallback: hash source → copy → verify hash → delete
  // We must hash the source BEFORE copying in case the source file changes
  // between copy and verification (concurrent writer).  Once the source hash
  // is captured, we copy, then hash the destination and compare.  Only after
  // a byte-exact match do we unlink the source.
  const srcHash = await hashFile(source);
  await fsp.copyFile(source, finalDest);

  const copyStat = await fsp.stat(finalDest);
  if (copyStat.size !== srcStat.size) {
    await fsp.unlink(finalDest).catch(() => {});
    throw new Error(
      `Copy verification failed: expected ${srcStat.size} bytes, got ${copyStat.size}`
    );
  }

  const dstHash = await hashFile(finalDest);
  if (dstHash !== srcHash) {
    // Same size but different content — silent corruption.  Bail out.
    await fsp.unlink(finalDest).catch(() => {});
    throw new Error(
      `Copy hash mismatch: source=${srcHash.slice(0, 12)}… dest=${dstHash.slice(0, 12)}…`
    );
  }

  // 7. Only NOW delete the source — copy is byte-exact verified
  await fsp.unlink(source);

  return finalDest;
}

// ── Dynamic Folder Discovery ──────────────────────────────────

const DEFAULT_FOLDERS = ["Documents", "Images", "Financial"];

// Folder names that every OS creates — never surface these as user categories
const SYSTEM_FOLDERS = new Set([
  ".ds_store", ".spotlight-v100", ".trashes", ".fseventsd",
  "$recycle.bin", "system volume information", "thumbs.db",
  ".git", ".svn", "node_modules", "__pycache__", ".idea", ".vscode",
]);

/**
 * Scan a destination directory and return the user's existing subfolder names.
 *
 * This is the foundation of "Universal Intelligence" — instead of hard-coding
 * categories, we read what folders the user already has (e.g. "Case Files",
 * "Homework", "Invoices") and use those as the AI's category list.
 *
 * @param {string} targetDir - The root directory to scan (e.g. ~/Desktop/AI_SORTED_FILES)
 * @returns {Promise<string[]>} Sorted list of subfolder names, or defaults if empty
 */
async function scanUserFolders(targetDir) {
  try {
    await fsp.mkdir(targetDir, { recursive: true });

    const entries = await fsp.readdir(targetDir, { withFileTypes: true });

    const folders = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name.startsWith(".")) continue;
      if (SYSTEM_FOLDERS.has(name.toLowerCase())) continue;

      // Add the top-level parent folder
      folders.push(name);

      // ── Scan one level deeper for child subfolders ──
      try {
        const childPath = path.join(targetDir, name);
        const children = await fsp.readdir(childPath, { withFileTypes: true });
        for (const child of children) {
          if (!child.isDirectory()) continue;
          if (child.name.startsWith(".")) continue;
          if (SYSTEM_FOLDERS.has(child.name.toLowerCase())) continue;
          // Add as "Parent/Child" path
          folders.push(`${name}/${child.name}`);
        }
      } catch {
        // Child scan failed — non-fatal, just skip
      }
    }

    folders.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

    // If the user hasn't created any folders yet, return sensible defaults
    if (folders.length === 0) {
      return DEFAULT_FOLDERS;
    }

    return folders;
  } catch (err) {
    console.error(`[fileService] scanUserFolders failed: ${err.message}`);
    return DEFAULT_FOLDERS;
  }
}

module.exports = { safeMoveFile, resolveUniquePath, scanUserFolders };
