#!/usr/bin/env node
/**
 * compile-ts.js — Pre-build TypeScript compilation.
 *
 * Compiles every .ts file in src/main/ to a .js file in the same location
 * using esbuild (already installed as a dep of tsx).  This lets the packaged
 * Electron app load plain .js files — no tsx runtime required at all.
 *
 * Run automatically via the prebuild scripts in package.json.
 */

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

function findTsFiles(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findTsFiles(full, results);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

const rootDir = path.join(__dirname, "..");
const srcDir  = path.join(rootDir, "src", "main");
const tsFiles = findTsFiles(srcDir);

if (tsFiles.length === 0) {
  console.log("[compile-ts] No .ts files found — skipping.");
  process.exit(0);
}

// esbuild CLI lives in node_modules/.bin/
const esbuildBin = path.join(
  rootDir, "node_modules", ".bin",
  process.platform === "win32" ? "esbuild.cmd" : "esbuild"
);

if (!fs.existsSync(esbuildBin)) {
  console.error("[compile-ts] esbuild not found at", esbuildBin);
  console.error("             Run: npm install");
  process.exit(1);
}

const args = [
  ...tsFiles,
  "--platform=node",
  "--format=cjs",
  `--outdir=${srcDir}`,
  `--outbase=${srcDir}`,
  // bundle=false = transpile only; keep each file separate so all
  // existing require('./services/Foo') calls continue to resolve.
  "--bundle=false",
  "--log-level=info",
];

console.log(`[compile-ts] Compiling ${tsFiles.length} TypeScript files with esbuild...`);

const result = spawnSync(esbuildBin, args, {
  stdio: "inherit",
  shell: false,
  cwd: rootDir,
});

if (result.error) {
  console.error("[compile-ts] Failed to spawn esbuild:", result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  console.error("[compile-ts] esbuild exited with code", result.status);
  process.exit(result.status || 1);
}

console.log("[compile-ts] Done — all TypeScript compiled to JavaScript.");
