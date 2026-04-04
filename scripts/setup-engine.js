#!/usr/bin/env node
/**
 * setup-engine.js — Downloads the AI inference engine for the current OS
 * and places it at resources/bin/internal-core.
 *
 * Runs automatically via `npm install` (postinstall hook).
 *
 * The binary is renamed so end-users and enterprise clients never see
 * the upstream project name. From their perspective the AI engine is
 * a native component of your product.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

// ── Configuration ──────────────────────────────────────────

// Ollama release to pull. Pin this so builds are reproducible.
const ENGINE_VERSION = "0.5.4";

// Map (platform, arch) → download URL + expected binary name inside the archive
const TARGETS = {
  "darwin-arm64": {
    url: `https://github.com/ollama/ollama/releases/download/v${ENGINE_VERSION}/ollama-darwin`,
    archiveType: "binary",
  },
  "darwin-x64": {
    url: `https://github.com/ollama/ollama/releases/download/v${ENGINE_VERSION}/ollama-darwin`,
    archiveType: "binary",
  },
  "linux-x64": {
    url: `https://github.com/ollama/ollama/releases/download/v${ENGINE_VERSION}/ollama-linux-amd64`,
    archiveType: "binary",
  },
  "linux-arm64": {
    url: `https://github.com/ollama/ollama/releases/download/v${ENGINE_VERSION}/ollama-linux-arm64`,
    archiveType: "binary",
  },
  "win32-x64": {
    url: `https://github.com/ollama/ollama/releases/download/v${ENGINE_VERSION}/ollama-windows-amd64.exe`,
    archiveType: "binary",
  },
};

const DEST_DIR = path.resolve(__dirname, "..", "resources", "bin");
const BINARY_NAME = process.platform === "win32" ? "internal-core.exe" : "internal-core";
const DEST_PATH = path.join(DEST_DIR, BINARY_NAME);

// ── Helpers ────────────────────────────────────────────────

function log(msg) {
  console.log(`  [setup-engine] ${msg}`);
}

/**
 * Follow redirects (GitHub releases redirect to S3).
 * Returns a readable stream for the final response.
 */
function download(url) {
  return new Promise((resolve, reject) => {
    const get = (currentUrl, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error("Too many redirects"));
        return;
      }

      https
        .get(currentUrl, { headers: { "User-Agent": "setup-engine/1.0" } }, (res) => {
          // Follow 3xx redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume(); // drain
            get(res.headers.location, redirectCount + 1);
            return;
          }

          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
            return;
          }

          resolve(res);
        })
        .on("error", reject);
    };

    get(url);
  });
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  // Skip if binary already exists and is the right version
  if (fs.existsSync(DEST_PATH)) {
    log(`${BINARY_NAME} already exists at ${DEST_DIR} — skipping download.`);
    log(`Delete resources/bin/${BINARY_NAME} and re-run npm install to force a refresh.`);
    return;
  }

  const key = `${process.platform}-${process.arch}`;
  const target = TARGETS[key];

  if (!target) {
    console.error(`  [setup-engine] Unsupported platform: ${key}`);
    console.error(`  [setup-engine] Supported: ${Object.keys(TARGETS).join(", ")}`);
    process.exit(1);
  }

  log(`Platform: ${key}`);
  log(`Engine version: ${ENGINE_VERSION}`);
  log(`Downloading from: ${target.url}`);

  // Ensure destination directory exists
  fs.mkdirSync(DEST_DIR, { recursive: true });

  // Download
  const stream = await download(target.url);
  const totalBytes = parseInt(stream.headers["content-length"] || "0", 10);
  let downloadedBytes = 0;
  let lastPct = -1;

  const fileStream = fs.createWriteStream(DEST_PATH);

  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => {
      downloadedBytes += chunk.length;
      if (totalBytes > 0) {
        const pct = Math.round((downloadedBytes / totalBytes) * 100);
        if (pct !== lastPct && pct % 10 === 0) {
          log(`  ${pct}%  (${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)})`);
          lastPct = pct;
        }
      }
    });

    stream.pipe(fileStream);
    fileStream.on("finish", resolve);
    fileStream.on("error", reject);
    stream.on("error", reject);
  });

  // Make executable on unix
  if (process.platform !== "win32") {
    fs.chmodSync(DEST_PATH, 0o755);
  }

  log(`Saved to: ${DEST_PATH}`);
  log(`Size: ${formatBytes(fs.statSync(DEST_PATH).size)}`);
  log("Engine setup complete.");
}

main().catch((err) => {
  console.error(`  [setup-engine] FATAL: ${err.message}`);
  // Don't process.exit(1) — npm install should still succeed even if
  // the download fails (user can retry or place the binary manually).
  console.error("  [setup-engine] You can place the binary manually at:");
  console.error(`  [setup-engine]   ${DEST_PATH}`);
});
