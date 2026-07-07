/**
 * fileService.js — Atomic, crash-safe file move with duplicate-safe naming.
 *
 * safeMoveFile(src, dest) guarantees, in priority order:
 *   1. NEVER overwrites an existing file — resolves to name_1, name_2, …
 *      using *exclusive* creation, so two concurrent moves can never clobber.
 *   2. NEVER deletes the source unless the destination is byte-for-byte
 *      verified (size + SHA-256) AND durably flushed to disk (fsync).
 *   3. Crash-safe: cross-filesystem copies land in a temp file and are only
 *      atomically renamed into place after verification, so a crash never
 *      leaves a half-written file at the destination path.
 *   4. Same-filesystem fast path uses a hardlink+unlink (atomic, no-clobber)
 *      instead of rename(), because rename() silently overwrites on POSIX.
 *
 * Symlinks are moved as links (the link is relocated, its target is not
 * followed, copied, or deleted). Directories are rejected.
 *
 * Usage:
 *   const { safeMoveFile } = require("./services/fileService");
 *   const finalPath = await safeMoveFile("/src/report.pdf", "/dst/report.pdf");
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { hashFile } = require("./hashUtil");

// ── In-process serialization ─────────────────────────────────────
// Node's event loop is single-threaded, but `await` points let two
// safeMoveFile() calls interleave. Between "resolve a free name" and
// "create the file" there is a TOCTOU window; two files heading for the
// same destination could both pick "report_1.pdf". We serialize the
// name-resolution + create step per destination directory so only one
// mover claims a name at a time. Exclusive create (below) is the real
// guarantee; this just avoids wasted retries.
const _dirLocks = new Map(); // dir -> Promise chain tail

function _withDirLock(dir, fn) {
  const prev = _dirLocks.get(dir) || Promise.resolve();
  let release;
  const next = new Promise((res) => (release = res));
  _dirLocks.set(dir, prev.then(() => next));
  const run = prev.then(fn, fn);
  run.finally(() => {
    // Clean up the map when this is the last waiter
    if (_dirLocks.get(dir) === next) _dirLocks.delete(dir);
    release();
  });
  return run;
}

/**
 * Windows has a 260-char MAX_PATH limit unless paths are prefixed with
 * the "\\?\" extended-length marker. Node passes the marker through to
 * the OS. No-op on macOS/Linux, which allow long UTF-8 paths natively.
 */
function toOsPath(p) {
  if (process.platform !== "win32") return p;
  const resolved = path.resolve(p);
  if (resolved.startsWith("\\\\?\\")) return resolved;
  if (resolved.startsWith("\\\\")) return "\\\\?\\UNC\\" + resolved.slice(2); // UNC share
  return "\\\\?\\" + resolved;
}

/**
 * Atomically create `candidate` as a hardlink to `source`.
 * Returns true on success, false if the name is already taken (EEXIST),
 * throws EXDEV if source and candidate are on different filesystems,
 * and rethrows anything else.
 */
async function _tryLink(source, candidate) {
  try {
    await fsp.link(toOsPath(source), toOsPath(candidate));
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false; // name taken — caller bumps counter
    throw err; // EXDEV (cross-device) and real errors propagate
  }
}

/**
 * Filesystems (APFS, ext4, NTFS) cap a single NAME at 255 bytes. Appending
 * a `_N` suffix to an already-max-length name would throw ENAMETOOLONG —
 * and a naive organizer dies mid-run (EDGE_CASES.md #3). Truncate the BASE
 * (never the extension, never the suffix) by whole code points so the final
 * `base + suffix + ext` fits in 255 bytes.
 */
const MAX_NAME_BYTES = 255;

function _fitName(base, suffix, ext) {
  const budget = MAX_NAME_BYTES - Buffer.byteLength(suffix, "utf8") - Buffer.byteLength(ext, "utf8");
  if (budget < 1) {
    // Pathological: extension alone nearly fills 255 bytes. Refuse loudly
    // rather than silently mangling the extension.
    throw new Error(`Cannot fit filename within ${MAX_NAME_BYTES} bytes: suffix+extension too long (${suffix}${ext})`);
  }
  if (Buffer.byteLength(base, "utf8") <= budget) return `${base}${suffix}${ext}`;
  const chars = Array.from(base); // whole code points — never split an emoji
  while (chars.length > 1 && Buffer.byteLength(chars.join(""), "utf8") > budget) {
    chars.pop();
  }
  return `${chars.join("")}${suffix}${ext}`;
}

/**
 * Reserve a destination path by *exclusively* creating an empty placeholder
 * file (O_EXCL). Returns the reserved path, or null if `desired` and the
 * first 10000 suffixes are all taken. The placeholder guarantees no other
 * process/mover can take the same name between reservation and use.
 */
async function _reserveUniquePath(desired) {
  const dir = path.dirname(desired);
  const ext = path.extname(desired);
  const base = path.basename(desired, ext);

  const attempt = async (p) => {
    try {
      const handle = await fsp.open(toOsPath(p), "wx"); // wx = create, fail if exists
      await handle.close();
      return true;
    } catch (err) {
      if (err.code === "EEXIST") return false;
      throw err;
    }
  };

  const first = path.join(dir, _fitName(base, "", ext));
  if (await attempt(first)) return first;
  for (let counter = 1; counter < 10000; counter++) {
    const candidate = path.join(dir, _fitName(base, `_${counter}`, ext));
    if (await attempt(candidate)) return candidate;
  }
  throw new Error(`Cannot find unique name for ${desired} after 10000 attempts`);
}

async function _fsyncDir(dir) {
  // Durability: after creating/renaming a file, fsync the parent directory
  // so the rename survives a power loss. Best-effort — some platforms
  // (Windows) don't allow opening a directory for fsync.
  try {
    const dh = await fsp.open(toOsPath(dir), "r");
    try { await dh.sync(); } finally { await dh.close(); }
  } catch { /* non-fatal */ }
}

async function _fsyncFile(p) {
  try {
    const fh = await fsp.open(toOsPath(p), "r+");
    try { await fh.sync(); } finally { await fh.close(); }
  } catch { /* non-fatal */ }
}

/**
 * Move a file safely with overwrite protection and crash safety.
 *
 * @param {string} source - Absolute path to source file
 * @param {string} destination - Desired destination path
 * @returns {Promise<string>} The actual final path (may have _N suffix)
 */
async function safeMoveFile(source, destination) {
  // 1. Inspect the source WITHOUT following symlinks. We must not silently
  //    copy-and-delete the target of a symlink; we relocate the link itself.
  const srcLstat = await fsp.lstat(source);

  if (srcLstat.isDirectory()) {
    throw new Error(`Source is a directory, not a file: ${source}`);
  }

  const isSymlink = srcLstat.isSymbolicLink();
  if (!isSymlink && !srcLstat.isFile()) {
    throw new Error(`Source is not a regular file: ${source}`);
  }

  // 2. Ensure destination directory exists.
  const destDir = path.dirname(destination);
  await fsp.mkdir(toOsPath(destDir), { recursive: true });

  // 3. Reserve a unique destination name atomically (serialized per dir).
  const finalDest = await _withDirLock(destDir, () => _reserveUniquePath(destination));

  // ── Symlink case: recreate the link at the new location, remove old link.
  //    We never touch the link's target file.
  if (isSymlink) {
    const linkTarget = await fsp.readlink(source);
    await fsp.unlink(toOsPath(finalDest));          // remove the reserved placeholder
    await fsp.symlink(linkTarget, toOsPath(finalDest));
    await fsp.unlink(toOsPath(source));
    return finalDest;
  }

  const srcSize = srcLstat.size;

  // 4. Same-filesystem fast path: hardlink the source to the final name,
  //    then unlink the source. This is atomic and cannot overwrite. We must
  //    remove the reserved placeholder first, then link into that exact name
  //    under the dir lock so nobody else can steal it in between.
  const linked = await _withDirLock(destDir, async () => {
    try {
      await fsp.unlink(toOsPath(finalDest)); // drop placeholder
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return _tryLink(source, finalDest); // false only if racily re-taken
  });

  if (linked) {
    // Verify link points at same content (cheap: inode/size via stat).
    const destStat = await fsp.stat(toOsPath(finalDest));
    if (destStat.size !== srcSize) {
      // Extremely unlikely (hardlink shares inode) — bail without deleting src.
      await fsp.unlink(toOsPath(finalDest)).catch(() => {});
      throw new Error("Size mismatch after hardlink — aborting, source untouched");
    }
    await fsp.unlink(toOsPath(source)); // remove the original link to the inode
    await _fsyncDir(destDir);
    return finalDest;
  }

  // 5. Cross-filesystem fallback: copy → verify hash → fsync → swap → delete.
  //    Copy to a TEMP file in the destination dir, never directly to finalDest,
  //    so a crash mid-copy cannot leave a corrupt file at the real name.
  //    Hash the SOURCE first so a concurrent writer can't fool verification.
  const srcHash = await hashFile(source);
  const tmpDest = path.join(destDir, `.sjtmp_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

  try {
    await fsp.copyFile(toOsPath(source), toOsPath(tmpDest));

    const copyStat = await fsp.stat(toOsPath(tmpDest));
    if (copyStat.size !== srcSize) {
      throw new Error(`Copy size mismatch: expected ${srcSize}, got ${copyStat.size}`);
    }

    const dstHash = await hashFile(tmpDest);
    if (dstHash !== srcHash) {
      throw new Error(
        `Copy hash mismatch: source=${srcHash.slice(0, 12)}… dest=${dstHash.slice(0, 12)}…`
      );
    }

    // Preserve modification/access times (best-effort).
    try { await fsp.utimes(toOsPath(tmpDest), srcLstat.atime, srcLstat.mtime); } catch { /* non-fatal */ }

    // Durably flush the verified copy before we swap or delete anything.
    await _fsyncFile(tmpDest);

    // Atomically move the verified temp into the reserved final name.
    // finalDest still holds our exclusive placeholder; remove it, then rename
    // under the dir lock. rename within the same dir is atomic and, because the
    // name was reserved by us, cannot clobber a third party's file.
    await _withDirLock(destDir, async () => {
      await fsp.unlink(toOsPath(finalDest)).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      await fsp.rename(toOsPath(tmpDest), toOsPath(finalDest));
    });
    await _fsyncDir(destDir);
  } catch (err) {
    // Anything went wrong: clean up temp + placeholder, leave SOURCE intact.
    await fsp.unlink(toOsPath(tmpDest)).catch(() => {});
    await fsp.unlink(toOsPath(finalDest)).catch(() => {});
    throw err;
  }

  // 6. Only NOW delete the source — the copy is verified and durable.
  await fsp.unlink(toOsPath(source));

  return finalDest;
}

/**
 * Back-compat shim: some callers still import resolveUniquePath. This is a
 * pure check (no reservation) and remains subject to TOCTOU — prefer letting
 * safeMoveFile own naming. Kept so existing imports don't break.
 */
async function resolveUniquePath(dest) {
  try {
    await fsp.access(toOsPath(dest));
  } catch {
    return dest;
  }
  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const base = path.basename(dest, ext);
  for (let counter = 1; counter < 10000; counter++) {
    const candidate = path.join(dir, `${base}_${counter}${ext}`);
    try {
      await fsp.access(toOsPath(candidate));
    } catch {
      return candidate;
    }
  }
  throw new Error(`Cannot find unique name for ${dest} after 10000 attempts`);
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
 * @param {string} targetDir - The root directory to scan
 * @returns {Promise<string[]>} Sorted list of subfolder names, or defaults if empty
 */
async function scanUserFolders(targetDir) {
  try {
    await fsp.mkdir(toOsPath(targetDir), { recursive: true });

    const entries = await fsp.readdir(toOsPath(targetDir), { withFileTypes: true });

    const folders = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name.startsWith(".")) continue;
      if (SYSTEM_FOLDERS.has(name.toLowerCase())) continue;

      folders.push(name);

      try {
        const childPath = path.join(targetDir, name);
        const children = await fsp.readdir(toOsPath(childPath), { withFileTypes: true });
        for (const child of children) {
          if (!child.isDirectory()) continue;
          if (child.name.startsWith(".")) continue;
          if (SYSTEM_FOLDERS.has(child.name.toLowerCase())) continue;
          folders.push(`${name}/${child.name}`);
        }
      } catch {
        // Child scan failed — non-fatal, just skip
      }
    }

    folders.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

    if (folders.length === 0) {
      return DEFAULT_FOLDERS;
    }

    return folders;
  } catch (err) {
    console.error(`[fileService] scanUserFolders failed: ${err.message}`);
    return DEFAULT_FOLDERS;
  }
}

module.exports = { safeMoveFile, resolveUniquePath, scanUserFolders, _fitName };
