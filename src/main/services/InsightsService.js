/**
 * InsightsService.js — Local storage intelligence built from data the app
 * already has. Zero network, zero new models: pure filesystem stats +
 * streaming SHA-256 (hashUtil) for exact duplicate detection.
 *
 * Two products in one:
 *   scanInsights(rootDir)      → the report: space by category, largest files,
 *                                stale files, duplicate groups, reclaimable bytes
 *   archiveDuplicates(payload) → the action: keep the newest copy of each
 *                                duplicate group, move the rest into
 *                                rootDir/_Duplicates via safeMoveFile.
 *                                NEVER deletes — every move lands in the undo log.
 *
 * Duplicate detection strategy (fast + exact):
 *   1. Group all files by size — different size can't be identical.
 *   2. Only same-size groups of ≥2 get hashed (streaming, bounded).
 *   3. Same hash = exact duplicate. No fuzzy matching, no false positives.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { hashFile } = require("./hashUtil");
const { safeMoveFile } = require("./fileService");

// Bounds so one click can never hang the app on a monster folder
const MAX_FILES = 20000;          // stop walking after this many files
const MAX_HASH_BYTES = 2 * 1024 * 1024 * 1024; // skip hashing files > 2 GB
const STALE_DAYS = 180;           // "untouched" threshold
const TOP_N = 20;                 // largest/stale list caps

const SKIP_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".ds_store",
  "$recycle.bin", "system volume information", ".trashes",
  ".spotlight-v100", ".fseventsd", "library", "applications",
]);

const DUPLICATES_DIR = "_Duplicates"; // never re-scan our own archive
const SCREENSHOTS_DIR = "Screenshots"; // sweep destination

// ── Screenshot detection ───────────────────────────────────────────────
// Filename conventions across macOS, Windows, and popular tools. Extension
// must be an image type — "Screenshot notes.docx" is not a screenshot.
const SCREENSHOT_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".tiff", ".bmp"]);
const SCREENSHOT_PATTERNS = [
  /^screen\s?shot\b/i,        // macOS "Screen Shot 2026-03-01 at…" / "Screenshot"
  /^screenshot[\s_\-(]/i,     // Windows "Screenshot (12)", Android "Screenshot_2026…"
  /^screenshot\.\w+$/i,       // bare "screenshot.png"
  /^cleanshot/i,              // CleanShot X
  /^capture[\s_\-]?\d/i,      // Capture 1, capture_2026
  /^snip\b|^snippet\b/i,      // Snipping tool exports
  /^greenshot/i,              // Greenshot
  /^annotation\s/i,           // macOS markup exports
  /^scr[\s_\-]\d/i,           // SCR_20260301
  /^vlcsnap/i,                // VLC snapshots
];

function isScreenshot(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!SCREENSHOT_EXTS.has(ext)) return false;
  return SCREENSHOT_PATTERNS.some((re) => re.test(filename));
}

/**
 * Walk rootDir (bounded), returning flat file records.
 * Symlinks are skipped entirely — following them can escape the tree.
 */
async function _walk(rootDir, onProgress) {
  const files = [];
  let truncated = false;

  async function walkDir(dir, depth) {
    if (files.length >= MAX_FILES) { truncated = true; return; }
    if (depth > 12) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) { truncated = true; return; }
      const name = entry.name;
      if (name.startsWith(".")) continue;
      if (SKIP_DIRS.has(name.toLowerCase())) continue;
      if (name === DUPLICATES_DIR) continue;
      const full = path.join(dir, name);

      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walkDir(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const st = await fsp.stat(full);
          // Top-level folder under rootDir = the "category"; files sitting
          // directly in the root (no separator in the relative path) are loose.
          const rel = path.relative(rootDir, full);
          const relParts = rel.split(path.sep);
          files.push({
            path: full,
            name,
            size: st.size,
            mtimeMs: st.mtimeMs,
            category: relParts.length > 1 ? relParts[0] : "(loose files)",
          });
          if (onProgress && files.length % 500 === 0) {
            onProgress({ phase: "scanning", count: files.length });
          }
        } catch { /* stat raced a deletion — skip */ }
      }
    }
  }

  await walkDir(rootDir, 0);
  return { files, truncated };
}

/**
 * Build the full insights report for a folder.
 * @param {string} rootDir
 * @param {(p: object) => void} [onProgress] — {phase, count|done, total}
 */
async function scanInsights(rootDir, onProgress) {
  const st = await fsp.stat(rootDir);
  if (!st.isDirectory()) throw new Error("Insights target must be a folder");

  const { files, truncated } = await _walk(rootDir, onProgress);

  // ── Space by category ────────────────────────────────────────────
  const catMap = new Map();
  for (const f of files) {
    const c = catMap.get(f.category) || { name: f.category, files: 0, bytes: 0 };
    c.files += 1;
    c.bytes += f.size;
    catMap.set(f.category, c);
  }
  const categories = [...catMap.values()].sort((a, b) => b.bytes - a.bytes);

  // ── Largest files ────────────────────────────────────────────────
  const largest = [...files]
    .sort((a, b) => b.size - a.size)
    .slice(0, TOP_N)
    .map((f) => ({ path: f.path, name: f.name, size: f.size, category: f.category }));

  // ── Stale files (untouched > STALE_DAYS), biggest first ──────────
  const staleCutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
  const staleAll = files.filter((f) => f.mtimeMs < staleCutoff);
  const staleBytes = staleAll.reduce((s, f) => s + f.size, 0);
  const stale = staleAll
    .sort((a, b) => b.size - a.size)
    .slice(0, TOP_N)
    .map((f) => ({ path: f.path, name: f.name, size: f.size, mtimeMs: f.mtimeMs, category: f.category }));

  // ── Duplicates: size-group → hash → exact groups ─────────────────
  const bySize = new Map();
  for (const f of files) {
    if (f.size === 0 || f.size > MAX_HASH_BYTES) continue;
    const arr = bySize.get(f.size) || [];
    arr.push(f);
    bySize.set(f.size, arr);
  }
  const candidates = [...bySize.values()].filter((arr) => arr.length >= 2);
  const totalToHash = candidates.reduce((s, arr) => s + arr.length, 0);
  let hashed = 0;

  const dupGroups = [];
  for (const group of candidates) {
    const byHash = new Map();
    for (const f of group) {
      try {
        const h = await hashFile(f.path);
        const arr = byHash.get(h) || [];
        arr.push(f);
        byHash.set(h, arr);
      } catch { /* unreadable — skip */ }
      hashed += 1;
      if (onProgress && hashed % 25 === 0) {
        onProgress({ phase: "hashing", done: hashed, total: totalToHash });
      }
    }
    for (const [hash, dupes] of byHash) {
      if (dupes.length < 2) continue;
      // Newest copy is the "keeper" — the one the user most recently touched
      const sorted = [...dupes].sort((a, b) => b.mtimeMs - a.mtimeMs);
      dupGroups.push({
        hash,
        size: sorted[0].size,
        wasteBytes: sorted[0].size * (sorted.length - 1),
        keep: { path: sorted[0].path, name: sorted[0].name, mtimeMs: sorted[0].mtimeMs },
        remove: sorted.slice(1).map((f) => ({ path: f.path, name: f.name, mtimeMs: f.mtimeMs })),
      });
    }
  }
  dupGroups.sort((a, b) => b.wasteBytes - a.wasteBytes);

  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const duplicateWaste = dupGroups.reduce((s, g) => s + g.wasteBytes, 0);

  // ── Screenshots (skip ones already living in Screenshots/) ────────
  const screenshotsAll = files.filter((f) => f.category !== SCREENSHOTS_DIR && isScreenshot(f.name));
  const screenshotBytes = screenshotsAll.reduce((s, f) => s + f.size, 0);
  const screenshots = screenshotsAll
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 500)
    .map((f) => ({ path: f.path, name: f.name, size: f.size, mtimeMs: f.mtimeMs, category: f.category }));

  return {
    rootDir,
    scannedAt: Date.now(),
    truncated,
    totals: {
      files: files.length,
      bytes: totalBytes,
      duplicateGroups: dupGroups.length,
      duplicateWasteBytes: duplicateWaste,
      staleFiles: staleAll.length,
      staleBytes,
      screenshots: screenshotsAll.length,
      screenshotBytes,
    },
    categories,
    largest,
    stale,
    duplicates: dupGroups.slice(0, 100), // UI cap; waste total covers all
    screenshots,
  };
}

/**
 * Sweep screenshots into rootDir/Screenshots/YYYY-MM (by capture date —
 * filename date first, mtime fallback). Moves via safeMoveFile; caller
 * records the undo op.
 */
async function sweepScreenshots(rootDir, shots, logUndo) {
  const { extractDocumentDate, chronoSubfolder } = require("./DateExtractService");
  let moved = 0;
  const failed = [];

  for (const shot of shots || []) {
    try {
      const d = extractDocumentDate(shot.name, "") ||
        (() => { const t = new Date(shot.mtimeMs || Date.now()); return { year: t.getFullYear(), month: t.getMonth() + 1 }; })();
      const destDir = path.join(rootDir, SCREENSHOTS_DIR, chronoSubfolder(d, "year-month"));
      const finalDest = await safeMoveFile(shot.path, path.join(destDir, shot.name));
      if (logUndo) await logUndo(shot.path, finalDest);
      moved += 1;
    } catch (err) {
      failed.push({ path: shot.path, error: String(err?.message || err) });
    }
  }
  return { moved, failed, destRoot: path.join(rootDir, SCREENSHOTS_DIR) };
}

/**
 * Move the redundant copies of the given duplicate groups into
 * rootDir/_Duplicates. Keeps folder context in the archived name
 * (e.g. "Downloads__invoice.pdf") so users can trace where each came from.
 *
 * @param {string} rootDir
 * @param {Array<{keep: {path: string}, remove: Array<{path: string}>}>} groups
 * @param {(from: string, to: string) => Promise<void>} [logUndo] — undo-log hook
 * @returns {Promise<{moved: number, failed: Array<{path: string, error: string}>, archiveDir: string}>}
 */
async function archiveDuplicates(rootDir, groups, logUndo) {
  const archiveDir = path.join(rootDir, DUPLICATES_DIR);
  await fsp.mkdir(archiveDir, { recursive: true });

  let moved = 0;
  const failed = [];

  for (const group of groups || []) {
    for (const dupe of group.remove || []) {
      try {
        // Safety: the keeper must still exist before we move a copy away.
        await fsp.access(group.keep.path);
        // Trace-friendly archived name: parent-folder prefix
        const parent = path.basename(path.dirname(dupe.path));
        const archivedName = parent && parent !== path.basename(rootDir)
          ? `${parent}__${path.basename(dupe.path)}`
          : path.basename(dupe.path);
        const finalDest = await safeMoveFile(dupe.path, path.join(archiveDir, archivedName));
        if (logUndo) await logUndo(dupe.path, finalDest);
        moved += 1;
      } catch (err) {
        failed.push({ path: dupe.path, error: String(err?.message || err) });
      }
    }
  }

  return { moved, failed, archiveDir };
}

module.exports = { scanInsights, archiveDuplicates, sweepScreenshots, isScreenshot, STALE_DAYS, DUPLICATES_DIR, SCREENSHOTS_DIR };
