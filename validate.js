#!/usr/bin/env node
/**
 * validate.js — validate the quality of a file-organizing run (System Janitor).
 *
 * Usage:
 *   node snapshot.js --folder ./stress_test_folder > before.json
 *   ...run the organizer...
 *   node validate.js --before before.json --after ./organized_folder
 *
 * --before accepts a snapshot JSON (from snapshot.js) or a folder path.
 * --after  accepts a folder path or a snapshot JSON.
 * Optional: --report out.json  (default: validation-report.json)
 *
 * Exit code: 0 = no files lost, 1 = data loss detected, 2 = usage error.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- CLI ----------
const args = process.argv.slice(2);
function argVal(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}
const beforeArg = argVal('--before');
const afterArg = argVal('--after');
const reportPath = argVal('--report') || 'validation-report.json';
if (!beforeArg || !afterArg) {
  console.error('Usage: node validate.js --before before.json --after ./organized_folder [--report out.json]');
  process.exit(2);
}

// ---------- Snapshot loading / building ----------
function sha256File(p) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function snapshotFolder(root) {
  const files = [];
  const paths = walk(root);
  let done = 0;
  for (const p of paths) {
    const st = fs.statSync(p);
    files.push({
      path: path.relative(root, p).split(path.sep).join('/'),
      size: st.size,
      sha256: sha256File(p),
    });
    if (++done % 100 === 0) process.stderr.write(`  hashed ${done}/${paths.length}\r`);
  }
  if (paths.length >= 100) process.stderr.write(`  hashed ${done}/${paths.length}\n`);
  return { root, fileCount: files.length, files };
}

function loadState(arg, label) {
  const resolved = path.resolve(arg);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: ${label} path does not exist: ${resolved}`);
    process.exit(2);
  }
  if (fs.statSync(resolved).isDirectory()) {
    console.error(`Scanning ${label} folder: ${resolved}`);
    return snapshotFolder(resolved);
  }
  const snap = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!Array.isArray(snap.files)) {
    console.error(`Error: ${label} JSON doesn't look like a snapshot (missing "files" array).`);
    process.exit(2);
  }
  return snap;
}

const before = loadState(beforeArg, 'before');
const after = loadState(afterArg, 'after');

// ---------- Index by hash ----------
function byHash(files) {
  const m = new Map();
  for (const f of files) {
    if (!m.has(f.sha256)) m.set(f.sha256, []);
    m.get(f.sha256).push(f);
  }
  return m;
}
const beforeHash = byHash(before.files);
const afterHash = byHash(after.files);

// ---------- Check 1: lost files ----------
// A hash present before but absent after = content lost.
// Fewer copies after than before = copies removed (dedup) — reported separately, not data loss.
const lostFiles = [];       // content gone entirely
const dedupedFiles = [];    // fewer copies, content still present
for (const [hash, files] of beforeHash) {
  const afterCopies = afterHash.get(hash);
  if (!afterCopies) {
    lostFiles.push(...files.map((f) => ({ path: f.path, size: f.size, sha256: hash })));
  } else if (afterCopies.length < files.length) {
    dedupedFiles.push({
      sha256: hash,
      beforeCopies: files.map((f) => f.path),
      afterCopies: afterCopies.map((f) => f.path),
    });
  }
}

// ---------- Check 2: unexpected duplicates / new files ----------
const unexpectedDuplicates = []; // more copies of a hash after than before
const newFiles = [];             // hash never seen before
for (const [hash, files] of afterHash) {
  const beforeCopies = beforeHash.get(hash);
  if (!beforeCopies) {
    newFiles.push(...files.map((f) => ({ path: f.path, size: f.size, sha256: hash })));
  } else if (files.length > beforeCopies.length) {
    unexpectedDuplicates.push({
      sha256: hash,
      beforeCopies: beforeCopies.map((f) => f.path),
      afterCopies: files.map((f) => f.path),
      extraCopies: files.length - beforeCopies.length,
    });
  }
}

// ---------- Check 3: moved / renamed / in place ----------
// Match before→after files within each hash group (greedy, most-specific first).
const inPlace = [], moved = [], renamed = [], movedAndRenamed = [];
for (const [hash, bFiles] of beforeHash) {
  const aFiles = afterHash.get(hash);
  if (!aFiles) continue;
  const remainingA = [...aFiles];
  const remainingB = [...bFiles];

  const takeMatches = (predicate, bucket) => {
    for (let i = remainingB.length - 1; i >= 0; i--) {
      const b = remainingB[i];
      const j = remainingA.findIndex((a) => predicate(b, a));
      if (j !== -1) {
        const a = remainingA[j];
        bucket.push({ before: b.path, after: a.path });
        remainingA.splice(j, 1);
        remainingB.splice(i, 1);
      }
    }
  };

  const base = (p) => p.split('/').pop();
  const dir = (p) => p.split('/').slice(0, -1).join('/');
  // 1) exact same path
  takeMatches((b, a) => b.path === a.path, inPlace);
  // 2) same name, different folder → moved
  takeMatches((b, a) => base(b.path) === base(a.path), moved);
  // 3) same folder, different name → renamed
  takeMatches((b, a) => dir(b.path) === dir(a.path), renamed);
  // 4) anything left with same hash → moved and renamed
  takeMatches(() => true, movedAndRenamed);
}

// ---------- Check 4: categories created ----------
// Top-level folders in the after state, with recursive file counts.
const categories = {};
for (const f of after.files) {
  const top = f.path.includes('/') ? f.path.split('/')[0] : '(root)';
  categories[top] = (categories[top] || 0) + 1;
}
const beforeTops = new Set(
  before.files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : '(root)'))
);
const newCategories = Object.keys(categories).filter((c) => !beforeTops.has(c));

// ---------- Check 5: files in suspicious folders ----------
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'heic', 'gif', 'webp', 'bmp', 'tiff', 'raw', 'svg']);
const DOC_EXTS = new Set(['docx', 'doc', 'txt', 'rtf', 'odt', 'md', 'pages']);
const SHEET_EXTS = new Set(['xlsx', 'xls', 'csv', 'ods', 'numbers']);
const CODE_EXTS = new Set(['js', 'ts', 'py', 'html', 'css', 'json', 'sh', 'sql', 'yaml', 'yml', 'rb', 'go', 'java', 'c', 'cpp']);
const ARCHIVE_EXTS = new Set(['zip', 'gz', 'tar', '7z', 'rar', 'bz2', 'xz']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'm4a', 'ogg']);

function inferFileCategory(relPath) {
  const name = relPath.split('/').pop().toLowerCase();
  const ext = name.includes('.') && !name.startsWith('.')
    ? name.split('.').pop()
    : (name.startsWith('.') && name.slice(1).includes('.') ? name.split('.').pop() : '');

  const isScreenshot = /screen\s?shot|screenshot|cleanshot/i.test(name);
  if (isScreenshot && (IMAGE_EXTS.has(ext) || !ext)) return 'screenshot';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'pdf') {
    return /invoice|receipt|statement|\binv[-_]/i.test(name) ? 'invoice' : 'pdf';
  }
  if (DOC_EXTS.has(ext)) return 'document';
  if (SHEET_EXTS.has(ext)) return 'spreadsheet';
  if (CODE_EXTS.has(ext)) return 'code';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return null; // unknown — never flagged
}

// What a folder name implies, and which file categories are acceptable there.
const FOLDER_RULES = [
  { pattern: /screen\s?shot/i, implies: 'screenshots', allowed: ['screenshot', 'image'] },
  { pattern: /photo|picture|image|camera|pics\b/i, implies: 'images', allowed: ['image', 'screenshot'] },
  { pattern: /invoice|receipt|billing|finance|statement/i, implies: 'invoices', allowed: ['invoice', 'pdf', 'spreadsheet', 'document'] },
  { pattern: /spreadsheet|sheets|excel/i, implies: 'spreadsheets', allowed: ['spreadsheet'] },
  { pattern: /\bcode\b|scripts|dev\b/i, implies: 'code', allowed: ['code', 'document'] },
  { pattern: /archive|zips|compressed/i, implies: 'archives', allowed: ['archive'] },
  { pattern: /video|movies/i, implies: 'videos', allowed: ['video'] },
  { pattern: /music|audio/i, implies: 'audio', allowed: ['audio'] },
  { pattern: /document|docs\b|word\b/i, implies: 'documents', allowed: ['document', 'pdf', 'invoice'] },
];

function folderRule(relPath) {
  // Check deepest folder segment first — "Documents/Photos" should imply photos.
  const segments = relPath.split('/').slice(0, -1);
  for (let i = segments.length - 1; i >= 0; i--) {
    for (const rule of FOLDER_RULES) {
      if (rule.pattern.test(segments[i])) return { ...rule, folderSegment: segments[i] };
    }
  }
  return null;
}

const misplacedFiles = [];
for (const f of after.files) {
  const rule = folderRule(f.path);
  if (!rule) continue;
  const cat = inferFileCategory(f.path);
  if (cat && !rule.allowed.includes(cat)) {
    misplacedFiles.push({
      path: f.path,
      fileCategory: cat,
      folder: rule.folderSegment,
      folderImplies: rule.implies,
      reason: `A ${cat} file in a folder that implies ${rule.implies}`,
    });
  }
}

// ---------- Report ----------
const report = {
  generatedAt: new Date().toISOString(),
  before: { source: path.resolve(beforeArg), fileCount: before.files.length },
  after: { source: path.resolve(afterArg), fileCount: after.files.length },
  integrity: {
    filesLost: lostFiles.length,
    lostFiles,
    deduplicatedGroups: dedupedFiles.length,
    deduplicatedFiles: dedupedFiles,
    unexpectedDuplicateGroups: unexpectedDuplicates.length,
    unexpectedDuplicates,
    newUnknownFiles: newFiles.length,
    newFiles,
  },
  movement: {
    inPlace: inPlace.length,
    moved: moved.length,
    renamed: renamed.length,
    movedAndRenamed: movedAndRenamed.length,
    details: { moved, renamed, movedAndRenamed },
  },
  categories: {
    counts: categories,
    newTopLevelFolders: newCategories,
  },
  misplacements: {
    count: misplacedFiles.length,
    files: misplacedFiles,
  },
  verdict: lostFiles.length === 0 ? 'PASS (no data loss)' : 'FAIL (data loss detected)',
};

fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

// ---------- Human-readable summary ----------
const pct = (n) => before.files.length ? ((n / before.files.length) * 100).toFixed(1) + '%' : 'n/a';
const lines = [];
lines.push('');
lines.push('════════ System Janitor Validation Report ════════');
lines.push('');
lines.push(`Before: ${before.files.length} files    After: ${after.files.length} files`);
lines.push('');
lines.push('— Integrity —');
lines.push(lostFiles.length === 0
  ? '  ✔ No files lost (all content hashes accounted for)'
  : `  ✘ ${lostFiles.length} FILE(S) LOST — content missing from after state!`);
for (const f of lostFiles.slice(0, 10)) lines.push(`      LOST: ${f.path}`);
if (lostFiles.length > 10) lines.push(`      ...and ${lostFiles.length - 10} more (see JSON report)`);
lines.push(unexpectedDuplicates.length === 0
  ? '  ✔ No unexpected duplicates created'
  : `  ⚠ ${unexpectedDuplicates.length} content group(s) have MORE copies than before`);
for (const d of unexpectedDuplicates.slice(0, 5)) {
  lines.push(`      +${d.extraCopies} extra: ${d.afterCopies.join(', ')}`);
}
if (dedupedFiles.length > 0) {
  lines.push(`  ℹ ${dedupedFiles.length} duplicate group(s) were consolidated (fewer copies, content preserved)`);
}
if (newFiles.length > 0) {
  lines.push(`  ⚠ ${newFiles.length} file(s) in after state with content never seen before`);
  for (const f of newFiles.slice(0, 5)) lines.push(`      NEW: ${f.path}`);
}
lines.push('');
lines.push('— Movement —');
lines.push(`  Left in place:     ${String(inPlace.length).padStart(5)}  (${pct(inPlace.length)})`);
lines.push(`  Moved:             ${String(moved.length).padStart(5)}  (${pct(moved.length)})`);
lines.push(`  Renamed:           ${String(renamed.length).padStart(5)}  (${pct(renamed.length)})`);
lines.push(`  Moved + renamed:   ${String(movedAndRenamed.length).padStart(5)}  (${pct(movedAndRenamed.length)})`);
lines.push('');
lines.push('— Categories (top-level folders in after state) —');
const sortedCats = Object.entries(categories).sort((a, b) => b[1] - a[1]);
for (const [cat, n] of sortedCats) {
  const isNew = newCategories.includes(cat) ? '  [new]' : '';
  lines.push(`  ${cat.padEnd(30)} ${String(n).padStart(5)}${isNew}`);
}
lines.push('');
lines.push('— Suspicious placements —');
if (misplacedFiles.length === 0) {
  lines.push('  ✔ No files flagged as obviously misplaced');
} else {
  lines.push(`  ⚠ ${misplacedFiles.length} file(s) look misplaced:`);
  for (const m of misplacedFiles.slice(0, 15)) {
    lines.push(`      ${m.path}  →  ${m.reason}`);
  }
  if (misplacedFiles.length > 15) lines.push(`      ...and ${misplacedFiles.length - 15} more (see JSON report)`);
}
lines.push('');
lines.push(`Verdict: ${report.verdict}`);
lines.push(`Full JSON report: ${path.resolve(reportPath)}`);
lines.push('');

console.log(lines.join('\n'));
process.exit(lostFiles.length === 0 ? 0 : 1);
