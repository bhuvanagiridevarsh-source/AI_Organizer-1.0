#!/usr/bin/env node
/**
 * generate-test-data.js
 * Generates a realistic, deeply messy folder structure for stress-testing a file organizer.
 *
 * Usage: node generate-test-data.js --target ./stress_test_folder
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- CLI ----------
const args = process.argv.slice(2);
const targetIdx = args.indexOf('--target');
if (targetIdx === -1 || !args[targetIdx + 1]) {
  console.error('Usage: node generate-test-data.js --target /path/to/folder');
  process.exit(1);
}
const TARGET = path.resolve(args[targetIdx + 1]);

// ---------- RNG helpers ----------
const rand = (n) => Math.floor(Math.random() * n);
const randInt = (min, max) => min + rand(max - min + 1);
const pick = (arr) => arr[rand(arr.length)];
const chance = (p) => Math.random() < p;

// Realistic file sizes (bytes) by kind
const SIZES = {
  pdf: () => randInt(40_000, 2_500_000),
  photo: () => randInt(800_000, 8_000_000),
  screenshot: () => randInt(100_000, 3_000_000),
  doc: () => randInt(15_000, 500_000),
  sheet: () => randInt(8_000, 900_000),
  code: () => randInt(300, 40_000),
  zip: () => randInt(50_000, 20_000_000),
  misc: () => randInt(100, 200_000),
  tiny: () => randInt(0, 2_000),
};

function randomBuffer(size) {
  // crypto.randomBytes is capped per call at 2^31-1 but slow for big sizes;
  // fill a smaller random chunk and repeat it — still "random-looking" content,
  // unique per file via a random header.
  const chunk = crypto.randomBytes(Math.min(size, 65536));
  const buf = Buffer.alloc(size);
  for (let off = 0; off < size; off += chunk.length) {
    chunk.copy(buf, off, 0, Math.min(chunk.length, size - off));
  }
  return buf;
}

// ---------- Name pools ----------
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const VENDORS = ['Amazon','Comcast','Verizon','StateFarm','PG&E','Adobe','Netflix','Uber','Delta','Airbnb','Costco','HomeDepot','BlueCross','Chase','Spotify'];
const PROJECTS = ['website_redesign','q3_planning','budget','taxes','onboarding','marketing','sideproject','freelance','thesis','wedding'];
const DOCWORDS = ['notes','draft','summary','report','proposal','meeting_minutes','agenda','plan','outline','ideas','todo','review','feedback','contract','agreement','resume','cover_letter','letter'];
const CODE_EXTS = ['js','py','ts','html','css','json','sh','sql','yaml','md'];
const SHEET_EXTS = ['xlsx','csv','xls'];
const DOC_EXTS = ['docx','doc','txt','rtf','odt'];
const SUBFOLDERS = [
  'Documents', 'Documents/old', 'Documents/old/archive', 'Documents/old/archive/2019',
  'Downloads_backup', 'Downloads_backup/misc', 'Photos', 'Photos/2023', 'Photos/2023/vacation',
  'work stuff', 'work stuff/projects', 'New folder', 'New folder (2)', 'temp',
  'backup_2022', 'backup_2022/desktop', 'backup_2022/desktop/random',
];

function dateStr() {
  const y = randInt(2018, 2026);
  const m = String(randInt(1, 12)).padStart(2, '0');
  const d = String(randInt(1, 28)).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function dateCompact() { return dateStr().replace(/-/g, ''); }

// ---------- Name generators per category ----------
const generators = {
  invoice() {
    const v = pick(VENDORS);
    const forms = [
      `Invoice_${v}_${dateStr()}.pdf`,
      `invoice-${rand(99999)}.pdf`,
      `${v}_invoice_${MONTHS[rand(12)]}${randInt(2019, 2026)}.pdf`,
      `INV-${dateCompact()}-${randInt(100, 999)}.pdf`,
      `receipt_${v.toLowerCase()}_${rand(9999)}.pdf`,
      `${v} Invoice ${MONTHS[rand(12)]} ${randInt(2020, 2026)}.pdf`,
      `statement_${dateCompact()}.pdf`,
    ];
    return { name: pick(forms), size: SIZES.pdf() };
  },
  photo() {
    const forms = [
      `IMG_${String(randInt(1, 9999)).padStart(4, '0')}.jpg`,
      `IMG_${String(randInt(1, 9999)).padStart(4, '0')}.HEIC`,
      `DSC_${String(randInt(1, 9999)).padStart(4, '0')}.JPG`,
      `DSC${String(randInt(10000, 99999))}.jpg`,
      `PXL_${dateCompact()}_${randInt(100000000, 999999999)}.jpg`,
      `IMG_${dateCompact()}_${String(randInt(0, 235959)).padStart(6, '0')}.jpg`,
      `photo_${randInt(1, 500)}.png`,
      `IMG_${String(randInt(1, 9999)).padStart(4, '0')} (1).jpg`,
    ];
    return { name: pick(forms), size: SIZES.photo() };
  },
  screenshot() {
    const forms = [
      `Screenshot ${dateStr()} at ${randInt(1, 12)}.${String(randInt(0, 59)).padStart(2, '0')}.${String(randInt(0, 59)).padStart(2, '0')} ${pick(['AM','PM'])}.png`,
      `Screen Shot ${dateStr()} at ${randInt(1, 12)}.${String(randInt(0, 59)).padStart(2, '0')} ${pick(['AM','PM'])}.png`,
      `Screenshot_${dateCompact()}-${String(randInt(0, 235959)).padStart(6, '0')}.png`,
      `Screenshot (${randInt(1, 300)}).png`,
      `CleanShot ${dateStr()} at ${String(randInt(0,23)).padStart(2,'0')}.${String(randInt(0,59)).padStart(2,'0')}.${String(randInt(0,59)).padStart(2,'0')}.png`,
    ];
    return { name: pick(forms), size: SIZES.screenshot() };
  },
  document() {
    const w = pick(DOCWORDS);
    const forms = [
      `${w}_${pick(PROJECTS)}.${pick(DOC_EXTS)}`,
      `${w} ${pick(['final','FINAL','final_v2','final final','v3','(1)','copy','REAL final'])}.${pick(DOC_EXTS)}`,
      `Untitled document${chance(0.5) ? ` (${randInt(1, 9)})` : ''}.docx`,
      `${pick(PROJECTS)}_${w}_${dateStr()}.docx`,
      `New Microsoft Word Document${chance(0.4) ? ` (${randInt(2, 5)})` : ''}.docx`,
      `${w}${rand(99)}.txt`,
      `asdf${chance(0.5) ? 'asdf' : ''}.txt`,
      `important!!.txt`,
    ];
    return { name: pick(forms), size: SIZES.doc() };
  },
  spreadsheet() {
    const forms = [
      `${pick(['budget','expenses','tracker','inventory','data','export','contacts','sales'])}_${randInt(2019, 2026)}.${pick(SHEET_EXTS)}`,
      `Book${randInt(1, 20)}.xlsx`,
      `export (${randInt(1, 30)}).csv`,
      `data_export_${dateCompact()}.csv`,
      `${pick(PROJECTS)}_numbers.xlsx`,
      `copy of budget FINAL.xlsx`,
    ];
    return { name: pick(forms), size: SIZES.sheet() };
  },
  code() {
    const ext = pick(CODE_EXTS);
    const forms = [
      `${pick(['index','main','app','utils','test','config','script','helper','old_version','backup'])}.${ext}`,
      `${pick(PROJECTS)}_script.${ext}`,
      `untitled${rand(9)}.${ext}`,
      `fix_${pick(['bug','login','db','api'])}_v${randInt(1, 4)}.${ext}`,
    ];
    return { name: pick(forms), size: SIZES.code() };
  },
  zip() {
    const forms = [
      `${pick(PROJECTS)}_backup.zip`,
      `Archive${chance(0.5) ? ` (${randInt(1, 9)})` : ''}.zip`,
      `photos_${randInt(2018, 2025)}.zip`,
      `download (${randInt(1, 20)}).zip`,
      `${pick(VENDORS).toLowerCase()}_docs.zip`,
      `backup_${dateCompact()}.tar.gz`,
    ];
    return { name: pick(forms), size: SIZES.zip() };
  },
  weird() {
    const longName = 'this_is_an_extremely_long_filename_that_someone_created_by_accident_when_saving_a_document_about_' +
      pick(PROJECTS) + '_and_never_bothered_to_rename_because_who_has_time_for_that_anyway_' + dateCompact();
    const forms = [
      { name: `my resume (final) - Copy.docx`, size: SIZES.doc() },
      { name: `tax docs & receipts ${randInt(2019, 2025)}.pdf`, size: SIZES.pdf() },
      { name: `résumé_${pick(['en','fr'])}.pdf`, size: SIZES.pdf() },
      { name: `photo of mom's garden!.jpg`, size: SIZES.photo() },
      { name: `report [DRAFT] #${randInt(1, 9)}.docx`, size: SIZES.doc() },
      { name: `notes from meeting w. boss.txt`, size: SIZES.tiny() },
      { name: `${longName}.pdf`, size: SIZES.pdf() },
      { name: `${longName}.txt`, size: SIZES.tiny() },
      { name: `weird file name    with spaces.txt`, size: SIZES.tiny() },
      { name: `50% off coupon.pdf`, size: SIZES.pdf() },
      { name: `TODO`, size: SIZES.tiny() },              // no extension
      { name: `README`, size: SIZES.tiny() },            // no extension
      { name: `Makefile`, size: SIZES.tiny() },          // no extension
      { name: `notes_backup`, size: SIZES.misc() },      // no extension
      { name: `randomfile${rand(999)}`, size: SIZES.misc() }, // no extension
      { name: `.DS_Store`, size: randInt(6_000, 20_000) },
      { name: `.env`, size: SIZES.tiny() },
      { name: `.hidden_notes.txt`, size: SIZES.tiny() },
      { name: `.backup_config`, size: SIZES.tiny() },
      { name: `.gitignore`, size: SIZES.tiny() },
      { name: `~$temp_word_lock.docx`, size: 162 },
      { name: `data (1) (2) (copy).csv`, size: SIZES.sheet() },
      { name: `IMPORTANT — read me first.txt`, size: SIZES.tiny() },
    ];
    return pick(forms);
  },
};

// Category weights (invoice-heavy roots feel realistic)
const CATEGORY_WEIGHTS = [
  ['photo', 22], ['screenshot', 14], ['invoice', 14], ['document', 18],
  ['spreadsheet', 9], ['code', 8], ['zip', 5], ['weird', 10],
];
function pickCategory() {
  const total = CATEGORY_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let r = rand(total);
  for (const [cat, w] of CATEGORY_WEIGHTS) {
    if ((r -= w) < 0) return cat;
  }
  return 'document';
}

// ---------- Main generation ----------
const stats = {
  total: 0, dirs: 0, duplicates: 0, nearDuplicates: 0, hidden: 0,
  noExtension: 0, byCategory: {}, bytes: 0, deepest: 0,
};
const usedPaths = new Set();

function uniquePath(dir, name) {
  let p = path.join(dir, name);
  let i = 1;
  while (usedPaths.has(p.toLowerCase())) {
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    p = path.join(dir, `${base} (${i})${ext}`);
    i++;
  }
  usedPaths.add(p.toLowerCase());
  return p;
}

function writeFileTracked(dir, name, buf, category) {
  const p = uniquePath(dir, name);
  fs.writeFileSync(p, buf);
  stats.total++;
  stats.bytes += buf.length;
  stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
  const base = path.basename(p);
  if (base.startsWith('.')) stats.hidden++;
  if (!path.extname(base) && !base.startsWith('.')) stats.noExtension++;
  const depth = path.relative(TARGET, p).split(path.sep).length - 1;
  if (depth > stats.deepest) stats.deepest = depth;
  return p;
}

function randomMtime(p) {
  // Spread modification times over the last ~6 years for realism
  const now = Date.now();
  const t = new Date(now - rand(6 * 365 * 24 * 3600 * 1000));
  try { fs.utimesSync(p, t, t); } catch { /* ignore */ }
}

console.log(`Generating messy test data in: ${TARGET}\n`);
fs.mkdirSync(TARGET, { recursive: true });

// Create nested folder structure (up to 4 deep)
for (const sub of SUBFOLDERS) {
  fs.mkdirSync(path.join(TARGET, sub), { recursive: true });
  stats.dirs++;
}
const subfolderPaths = SUBFOLDERS.map((s) => path.join(TARGET, s));

// Where does a file land? ~65% in root, rest scattered in subfolders.
function pickDir() {
  return chance(0.65) ? TARGET : pick(subfolderPaths);
}

const TOTAL_TARGET = randInt(550, 950);
const DUP_COUNT = 50;
const NEAR_DUP_COUNT = 30;
const BASE_COUNT = TOTAL_TARGET - DUP_COUNT - NEAR_DUP_COUNT;

// 1) Base files
const created = []; // { path, buf, category, name }
for (let i = 0; i < BASE_COUNT; i++) {
  const cat = pickCategory();
  const { name, size } = generators[cat]();
  const buf = randomBuffer(size);
  const p = writeFileTracked(pickDir(), name, buf, cat);
  randomMtime(p);
  // keep a sample of buffers in memory for duplication (cap memory usage)
  if (created.length < 200 && size < 3_000_000) {
    created.push({ path: p, buf, category: cat, name: path.basename(p) });
  }
}

// 2) Genuine duplicates: same content, different name
const dupNameTransforms = [
  (n) => `Copy of ${n}`,
  (n) => `${path.basename(n, path.extname(n))} - Copy${path.extname(n)}`,
  (n) => `${path.basename(n, path.extname(n))} (1)${path.extname(n)}`,
  (n) => `${path.basename(n, path.extname(n))} (2)${path.extname(n)}`,
  (n) => `${path.basename(n, path.extname(n))}_backup${path.extname(n)}`,
  (n) => `${path.basename(n, path.extname(n))}_old${path.extname(n)}`,
  (n) => `${path.basename(n, path.extname(n))} copy${path.extname(n)}`,
];
for (let i = 0; i < DUP_COUNT; i++) {
  const src = pick(created);
  const newName = pick(dupNameTransforms)(src.name);
  const p = writeFileTracked(pickDir(), newName, src.buf, src.category);
  randomMtime(p);
  stats.duplicates++;
}

// 3) Near-duplicates: similar name, slightly different content
const nearNameTransforms = [
  (n) => `${path.basename(n, path.extname(n))}_v2${path.extname(n)}`,
  (n) => `${path.basename(n, path.extname(n))}_final${path.extname(n)}`,
  (n) => `${path.basename(n, path.extname(n))}_edited${path.extname(n)}`,
  (n) => `${path.basename(n, path.extname(n))} revised${path.extname(n)}`,
  (n) => `${path.basename(n, path.extname(n))}_new${path.extname(n)}`,
];
for (let i = 0; i < NEAR_DUP_COUNT; i++) {
  const src = pick(created);
  const newName = pick(nearNameTransforms)(src.name);
  // slightly different: copy buffer, mutate a few bytes, maybe change length
  const buf = Buffer.from(src.buf);
  for (let j = 0; j < randInt(3, 40); j++) {
    if (buf.length > 0) buf[rand(buf.length)] = rand(256);
  }
  const finalBuf = chance(0.5) ? Buffer.concat([buf, crypto.randomBytes(randInt(10, 5000))]) : buf;
  const p = writeFileTracked(pickDir(), newName, finalBuf, src.category);
  randomMtime(p);
  stats.nearDuplicates++;
}

// A few empty files for good measure
for (let i = 0; i < 5; i++) {
  const p = writeFileTracked(TARGET, `empty_${i}.txt`, Buffer.alloc(0), 'weird');
  randomMtime(p);
}

// ---------- Summary ----------
const mb = (stats.bytes / 1024 / 1024).toFixed(1);
console.log('Done!\n');
console.log('=== Summary ===');
console.log(`Target:           ${TARGET}`);
console.log(`Total files:      ${stats.total}`);
console.log(`Total size:       ${mb} MB`);
console.log(`Directories:      ${stats.dirs}`);
console.log(`Max folder depth: ${stats.deepest}`);
console.log(`Genuine dupes:    ${stats.duplicates}`);
console.log(`Near-duplicates:  ${stats.nearDuplicates}`);
console.log(`Hidden files:     ${stats.hidden}`);
console.log(`No extension:     ${stats.noExtension}`);
console.log('\nBy category:');
for (const [cat, n] of Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat.padEnd(12)} ${n}`);
}
