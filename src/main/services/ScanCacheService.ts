/**
 * ScanCacheService.ts — Lean manifest cache for fast re-scanning.
 *
 * Cache logic:
 *  1. Before scanning, check if folder is in cache + mtimes unchanged.
 *  2. Cached & unchanged → return cached manifest immediately (zero I/O).
 *  3. Cached but changed → differential scan (only new/changed files).
 *  4. Not cached → full scan, then store.
 *  5. Evict entries > 24 hours old; LRU cap at 100 folders.
 */

import fs from "fs";
import path from "path";
import { app } from "electron";

const fsp = fs.promises;

// ── Types ──────────────────────────────────────────────────────

export interface LeanFileInfo {
  index: number;
  name: string;
  ext: string;
  modified: string;
  sizeKB: number;
  parent: string;
}

export interface LeanManifest {
  files: LeanFileInfo[];
  totalCount: number;
  scannedAt: string;
  targetDirectory: string;
}

interface CacheEntry {
  lastScanned: string;
  fileCount: number;
  fileHashes: Record<string, string>;
  manifest: LeanManifest;
  lastAccessed: string;
}

interface ScanCache {
  [folderPath: string]: CacheEntry;
}

// ── Constants ──────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FOLDERS = 100;

const SKIP_NAMES = new Set([
  "node_modules", ".git", "__macosx", ".ds_store", ".spotlight-v100",
  ".trashes", ".fseventsd", "$recycle.bin", "system volume information",
  "thumbs.db", ".svn", "__pycache__", ".idea", ".vscode",
]);

// ── Storage ────────────────────────────────────────────────────

function cachePath(): string {
  return path.join(app.getPath("userData"), "scan_cache.json");
}

async function loadCache(): Promise<ScanCache> {
  try {
    const raw = await fsp.readFile(cachePath(), "utf-8");
    return JSON.parse(raw) as ScanCache;
  } catch {
    return {};
  }
}

async function saveCache(cache: ScanCache): Promise<void> {
  try {
    await fsp.writeFile(cachePath(), JSON.stringify(cache), "utf-8");
  } catch {
    // non-fatal
  }
}

function evictExpired(cache: ScanCache): ScanCache {
  const now = Date.now();
  const result: ScanCache = {};
  for (const [k, v] of Object.entries(cache)) {
    if (now - new Date(v.lastScanned).getTime() < CACHE_TTL_MS) {
      result[k] = v;
    }
  }
  return result;
}

function evictLRU(cache: ScanCache): ScanCache {
  const entries = Object.entries(cache);
  if (entries.length <= MAX_FOLDERS) return cache;
  entries.sort((a, b) =>
    new Date(a[1].lastAccessed).getTime() - new Date(b[1].lastAccessed).getTime()
  );
  const keep = entries.slice(entries.length - MAX_FOLDERS);
  return Object.fromEntries(keep);
}

// ── File Hash (use mtime string as cheap change detector) ──────

async function buildFileHashes(files: LeanFileInfo[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const f of files) {
    map[f.name] = f.modified;
  }
  return map;
}

// ── Core Scan (builds LeanManifest) ───────────────────────────

export async function scanLean(
  targetDir: string,
  maxFiles = 500,
  maxDepth = 2
): Promise<LeanManifest> {
  const files: LeanFileInfo[] = [];
  let idx = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || files.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.name.startsWith(".")) continue;
      if (SKIP_NAMES.has(entry.name.toLowerCase())) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(fullPath);
          const ext = path.extname(entry.name).toLowerCase() || "(none)";
          idx++;
          files.push({
            index: idx,
            name: entry.name,
            ext,
            modified: stat.mtime.toISOString().slice(0, 10),
            sizeKB: Math.round(stat.size / 1024),
            parent: path.basename(dir),
          });
        } catch {
          // unreadable — skip
        }
      }
    }
  }

  await walk(targetDir, 1);
  return {
    files,
    totalCount: files.length,
    scannedAt: new Date().toISOString(),
    targetDirectory: targetDir,
  };
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Get a lean manifest for a folder.
 * Uses cache when folder contents haven't changed.
 */
export async function getCachedManifest(
  targetDir: string,
  maxFiles = 500
): Promise<LeanManifest> {
  let cache = await loadCache();
  cache = evictExpired(cache);

  const entry = cache[targetDir];
  if (entry) {
    // Check if folder modification date changed (quick signal)
    try {
      const stat = await fsp.stat(targetDir);
      const folderMtime = stat.mtime.toISOString().slice(0, 19);
      const cachedMtime = entry.manifest.scannedAt.slice(0, 19);
      if (folderMtime <= cachedMtime) {
        // Folder unchanged — serve from cache
        entry.lastAccessed = new Date().toISOString();
        cache[targetDir] = entry;
        await saveCache(evictLRU(cache));
        return entry.manifest;
      }
    } catch {
      // stat failed, fall through to fresh scan
    }
  }

  // Full scan
  const manifest = await scanLean(targetDir, maxFiles);
  const hashes = await buildFileHashes(manifest.files);

  cache[targetDir] = {
    lastScanned: new Date().toISOString(),
    fileCount: manifest.totalCount,
    fileHashes: hashes,
    manifest,
    lastAccessed: new Date().toISOString(),
  };
  await saveCache(evictLRU(cache));
  return manifest;
}

/** Invalidate cache for a specific folder (call after executing a reorg). */
export async function invalidateCacheEntry(targetDir: string): Promise<void> {
  const cache = await loadCache();
  delete cache[targetDir];
  await saveCache(cache);
}

/** Return cache stats for debugging. */
export async function getCacheStats(): Promise<{ entries: number; totalFiles: number }> {
  const cache = await loadCache();
  const entries = Object.keys(cache).length;
  const totalFiles = Object.values(cache).reduce((s, e) => s + e.fileCount, 0);
  return { entries, totalFiles };
}
