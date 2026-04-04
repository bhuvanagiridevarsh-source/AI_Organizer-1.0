/**
 * build-protected.js — Obfuscate JS source, build Electron app, restore originals.
 *
 * Flow:
 *   1. Copy src/ → src-build/
 *   2. Obfuscate every .js file in src-build/
 *   3. Swap: src/ → src-original/, src-build/ → src/
 *   4. Run electron-builder --mac
 *   5. Restore: src/ → src-build/, src-original/ → src/
 *   6. Delete src-build/
 *
 * Safety: if any step fails, src-original/ is restored before exiting.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const JavaScriptObfuscator = require("javascript-obfuscator");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const SRC_BUILD = path.join(ROOT, "src-build");
const SRC_ORIGINAL = path.join(ROOT, "src-original");

const OBFUSCATE_OPTIONS = {
  compact: true,
  controlFlowFlattening: false,
  stringEncryption: true,
  identifierNamesGenerator: "hexadecimal",
};

// ── Helpers ──────────────────────────────────────────────────

function log(msg) {
  console.log(`[build-protected] ${msg}`);
}

function copyDirSync(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const srcPath = path.join(from, entry.name);
    const dstPath = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function deleteDirSync(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function obfuscateDir(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += obfuscateDir(fullPath);
    } else if (entry.name.endsWith(".js")) {
      const code = fs.readFileSync(fullPath, "utf8");
      const result = JavaScriptObfuscator.obfuscate(code, OBFUSCATE_OPTIONS);
      fs.writeFileSync(fullPath, result.getObfuscatedCode(), "utf8");
      log(`  obfuscated: ${path.relative(SRC_BUILD, fullPath)}`);
      count++;
    }
    // .ts, .html, .css files are left untouched (already copied as-is)
  }
  return count;
}

function restore() {
  // Safety restore: if src-original/ exists, put it back as src/
  if (fs.existsSync(SRC_ORIGINAL)) {
    if (fs.existsSync(SRC)) {
      // src/ is currently the build copy — move it out of the way
      if (fs.existsSync(SRC_BUILD)) deleteDirSync(SRC_BUILD);
      fs.renameSync(SRC, SRC_BUILD);
    }
    fs.renameSync(SRC_ORIGINAL, SRC);
    log("restored src/ from src-original/");
  }
  deleteDirSync(SRC_BUILD);
}

// ── Main ─────────────────────────────────────────────────────

function main() {
  // Clean up any leftover state from a previous failed run
  if (fs.existsSync(SRC_ORIGINAL)) {
    log("found leftover src-original/ from a previous run — restoring first");
    restore();
  }
  deleteDirSync(SRC_BUILD);

  // 1. Copy src/ → src-build/
  log("step 1: copying src/ → src-build/");
  copyDirSync(SRC, SRC_BUILD);

  // 2. Obfuscate .js files in src-build/
  log("step 2: obfuscating .js files in src-build/");
  const count = obfuscateDir(SRC_BUILD);
  log(`  done — ${count} file(s) obfuscated`);

  // 3. Swap directories
  log("step 3: swapping src/ ↔ src-build/");
  fs.renameSync(SRC, SRC_ORIGINAL);
  fs.renameSync(SRC_BUILD, SRC);
  log("  src/ → src-original/, src-build/ → src/");

  // 4. Run electron-builder
  log("step 4: running electron-builder --mac");
  try {
    execSync("npx electron-builder --mac", {
      cwd: ROOT,
      stdio: "inherit",
    });
    log("build complete — output in dist/");
  } catch (err) {
    log(`electron-builder failed: ${err.message}`);
    log("restoring original src/ before exiting...");
    restore();
    process.exit(1);
  }

  // 5. Restore
  log("step 5: restoring original src/");
  fs.renameSync(SRC, SRC_BUILD);
  fs.renameSync(SRC_ORIGINAL, SRC);
  log("  src/ → src-build/, src-original/ → src/");

  // 6. Cleanup
  log("step 6: deleting src-build/");
  deleteDirSync(SRC_BUILD);

  log("done — distributable is in dist/");
}

// Run with safety net
try {
  main();
} catch (err) {
  console.error(`[build-protected] FATAL: ${err.message}`);
  log("attempting to restore src/...");
  restore();
  process.exit(1);
}
