#!/usr/bin/env node
/**
 * snapshot.js — capture a folder's state (file list + content hashes) as JSON.
 *
 * Usage: node snapshot.js --folder ./stress_test_folder > before.json
 *
 * Progress goes to stderr so stdout stays clean JSON.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const idx = args.indexOf('--folder');
if (idx === -1 || !args[idx + 1]) {
  console.error('Usage: node snapshot.js --folder /path/to/folder > snapshot.json');
  process.exit(1);
}
const ROOT = path.resolve(args[idx + 1]);
if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  console.error(`Error: not a directory: ${ROOT}`);
  process.exit(1);
}

function sha256File(p) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
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
    // symlinks/sockets ignored
  }
  return out;
}

const filePaths = walk(ROOT);
const files = [];
let done = 0;
for (const p of filePaths) {
  const st = fs.statSync(p);
  files.push({
    path: path.relative(ROOT, p).split(path.sep).join('/'), // posix-style, portable
    size: st.size,
    mtime: st.mtime.toISOString(),
    sha256: sha256File(p),
  });
  done++;
  if (done % 100 === 0) process.stderr.write(`  hashed ${done}/${filePaths.length}\r`);
}
process.stderr.write(`  hashed ${done}/${filePaths.length}\n`);

const snapshot = {
  tool: 'snapshot.js',
  version: 1,
  root: ROOT,
  createdAt: new Date().toISOString(),
  fileCount: files.length,
  totalBytes: files.reduce((s, f) => s + f.size, 0),
  files: files.sort((a, b) => a.path.localeCompare(b.path)),
};

process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
console.error(`Snapshot of ${ROOT}: ${files.length} files.`);
