var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var ScanCacheService_exports = {};
__export(ScanCacheService_exports, {
  getCacheStats: () => getCacheStats,
  getCachedManifest: () => getCachedManifest,
  invalidateCacheEntry: () => invalidateCacheEntry,
  scanLean: () => scanLean
});
module.exports = __toCommonJS(ScanCacheService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_electron = require("electron");
const fsp = import_fs.default.promises;
const CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
const MAX_FOLDERS = 100;
const SKIP_NAMES = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "__macosx",
  ".ds_store",
  ".spotlight-v100",
  ".trashes",
  ".fseventsd",
  "$recycle.bin",
  "system volume information",
  "thumbs.db",
  ".svn",
  "__pycache__",
  ".idea",
  ".vscode"
]);
function cachePath() {
  return import_path.default.join(import_electron.app.getPath("userData"), "scan_cache.json");
}
async function loadCache() {
  try {
    const raw = await fsp.readFile(cachePath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
async function saveCache(cache) {
  try {
    await fsp.writeFile(cachePath(), JSON.stringify(cache), "utf-8");
  } catch {
  }
}
function evictExpired(cache) {
  const now = Date.now();
  const result = {};
  for (const [k, v] of Object.entries(cache)) {
    if (now - new Date(v.lastScanned).getTime() < CACHE_TTL_MS) {
      result[k] = v;
    }
  }
  return result;
}
function evictLRU(cache) {
  const entries = Object.entries(cache);
  if (entries.length <= MAX_FOLDERS) return cache;
  entries.sort(
    (a, b) => new Date(a[1].lastAccessed).getTime() - new Date(b[1].lastAccessed).getTime()
  );
  const keep = entries.slice(entries.length - MAX_FOLDERS);
  return Object.fromEntries(keep);
}
async function buildFileHashes(files) {
  const map = {};
  for (const f of files) {
    map[f.name] = f.modified;
  }
  return map;
}
async function scanLean(targetDir, maxFiles = 500, maxDepth = 2) {
  const files = [];
  let idx = 0;
  async function walk(dir, depth) {
    if (depth > maxDepth || files.length >= maxFiles) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.name.startsWith(".")) continue;
      if (SKIP_NAMES.has(entry.name.toLowerCase())) continue;
      const fullPath = import_path.default.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(fullPath);
          const ext = import_path.default.extname(entry.name).toLowerCase() || "(none)";
          idx++;
          files.push({
            index: idx,
            name: entry.name,
            ext,
            modified: stat.mtime.toISOString().slice(0, 10),
            sizeKB: Math.round(stat.size / 1024),
            parent: import_path.default.basename(dir)
          });
        } catch {
        }
      }
    }
  }
  await walk(targetDir, 1);
  return {
    files,
    totalCount: files.length,
    scannedAt: (/* @__PURE__ */ new Date()).toISOString(),
    targetDirectory: targetDir
  };
}
async function getCachedManifest(targetDir, maxFiles = 500) {
  let cache = await loadCache();
  cache = evictExpired(cache);
  const entry = cache[targetDir];
  if (entry) {
    try {
      const stat = await fsp.stat(targetDir);
      const folderMtime = stat.mtime.toISOString().slice(0, 19);
      const cachedMtime = entry.manifest.scannedAt.slice(0, 19);
      if (folderMtime <= cachedMtime) {
        entry.lastAccessed = (/* @__PURE__ */ new Date()).toISOString();
        cache[targetDir] = entry;
        await saveCache(evictLRU(cache));
        return entry.manifest;
      }
    } catch {
    }
  }
  const manifest = await scanLean(targetDir, maxFiles);
  const hashes = await buildFileHashes(manifest.files);
  cache[targetDir] = {
    lastScanned: (/* @__PURE__ */ new Date()).toISOString(),
    fileCount: manifest.totalCount,
    fileHashes: hashes,
    manifest,
    lastAccessed: (/* @__PURE__ */ new Date()).toISOString()
  };
  await saveCache(evictLRU(cache));
  return manifest;
}
async function invalidateCacheEntry(targetDir) {
  const cache = await loadCache();
  delete cache[targetDir];
  await saveCache(cache);
}
async function getCacheStats() {
  const cache = await loadCache();
  const entries = Object.keys(cache).length;
  const totalFiles = Object.values(cache).reduce((s, e) => s + e.fileCount, 0);
  return { entries, totalFiles };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getCacheStats,
  getCachedManifest,
  invalidateCacheEntry,
  scanLean
});
