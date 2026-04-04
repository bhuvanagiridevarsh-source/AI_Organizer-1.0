/**
 * CloudSyncService.ts — Sync orchestration for cloud storage connectors.
 *
 * After files are organized locally, this service COPIES them to
 * enabled cloud destinations. Files are never moved — local org is untouched.
 *
 * Features:
 *   - Mirrors local folder structure in cloud destinations
 *   - Duplicate-safe naming (appends _1, _2, etc.)
 *   - Error isolation: cloud sync failures never block local operations
 *   - Sync logging for audit trail
 *   - Manual "sync now" for bulk operations
 *
 * SAFETY: All operations are fire-and-forget copies. If a cloud provider
 *         is temporarily unavailable, files remain safely organized locally.
 */

import fs   from "fs";
import path from "path";

const fsp = fs.promises;
import { getEnabledConnectors, CloudProviderID } from "./CloudConnectorService";

// ── Types ─────────────────────────────────────────────────────────

export interface SyncResult {
  provider: CloudProviderID;
  label: string;
  sourcePath: string;
  destPath: string;
  success: boolean;
  error?: string;
}

export interface BulkSyncResult {
  totalFiles: number;
  synced: number;
  failed: number;
  results: SyncResult[];
}

// ── Internal state ────────────────────────────────────────────────

let _syncLog: SyncResult[] = [];
const MAX_SYNC_LOG = 500;

// ── Public API ────────────────────────────────────────────────────

/**
 * Sync a single organized file to all enabled cloud connectors.
 *
 * Call this after a file has been successfully moved to its local
 * organized destination (e.g., ~/Desktop/AI_SORTED_FILES/Finance/invoice.pdf).
 *
 * @param localDestPath — Full path to the organized file
 * @param category — The category/folder name (e.g., "Finance")
 * @returns Array of sync results (one per enabled connector)
 */
export async function syncFileToCloud(
  localDestPath: string,
  category: string
): Promise<SyncResult[]> {
  const connectors = getEnabledConnectors();
  if (connectors.length === 0) return [];

  const filename = path.basename(localDestPath);
  const results: SyncResult[] = [];

  for (const connector of connectors) {
    try {
      // Mirror the category folder structure in cloud destination
      const cloudCategoryDir = path.join(connector.destPath, category);
      await fsp.mkdir(cloudCategoryDir, { recursive: true });

      const cloudDest = path.join(cloudCategoryDir, filename);
      const finalDest = await resolveUniqueCloudPath(cloudDest);

      // Copy the file (never move)
      await fsp.copyFile(localDestPath, finalDest);

      // Verify copy integrity
      const [srcStat, dstStat] = await Promise.all([
        fsp.stat(localDestPath),
        fsp.stat(finalDest),
      ]);

      if (srcStat.size !== dstStat.size) {
        // Clean up corrupt copy
        await fsp.unlink(finalDest).catch(() => {});
        throw new Error(
          `Size mismatch: expected ${srcStat.size} bytes, got ${dstStat.size}`
        );
      }

      const result: SyncResult = {
        provider: connector.id as CloudProviderID,
        label: connector.label,
        sourcePath: localDestPath,
        destPath: finalDest,
        success: true,
      };
      results.push(result);
      appendSyncLog(result);

      console.log(
        `[CloudSync] ✓ ${filename} → ${connector.label}/${category}/`
      );
    } catch (err: any) {
      const result: SyncResult = {
        provider: connector.id as CloudProviderID,
        label: connector.label,
        sourcePath: localDestPath,
        destPath: "",
        success: false,
        error: String(err.message || err),
      };
      results.push(result);
      appendSyncLog(result);

      console.warn(
        `[CloudSync] ✗ ${filename} → ${connector.label}: ${err.message || err}`
      );
    }
  }

  return results;
}

/**
 * Bulk sync: copy all files from a local organized directory
 * to all enabled cloud connectors.
 *
 * Use this for "Sync Now" — copies everything that hasn't been synced yet.
 *
 * @param localBaseDir — The local organized base dir (e.g., ~/Desktop/AI_SORTED_FILES)
 * @param onProgress — Optional callback(current, total) for progress updates
 */
export async function bulkSyncToCloud(
  localBaseDir: string,
  onProgress?: (current: number, total: number) => void
): Promise<BulkSyncResult> {
  const connectors = getEnabledConnectors();
  if (connectors.length === 0) {
    return { totalFiles: 0, synced: 0, failed: 0, results: [] };
  }

  // Discover all files in the local organized directory
  const files = await discoverFiles(localBaseDir);
  const total = files.length * connectors.length;
  let current = 0;
  let synced = 0;
  let failed = 0;
  const allResults: SyncResult[] = [];

  for (const fileInfo of files) {
    for (const connector of connectors) {
      try {
        const cloudCategoryDir = path.join(connector.destPath, fileInfo.category);
        await fsp.mkdir(cloudCategoryDir, { recursive: true });

        const cloudDest = path.join(cloudCategoryDir, fileInfo.filename);

        // Skip if file already exists in cloud with same size
        if (await fileExistsWithSize(cloudDest, fileInfo.size)) {
          synced++;
          current++;
          if (onProgress) onProgress(current, total);
          continue;
        }

        const finalDest = await resolveUniqueCloudPath(cloudDest);
        await fsp.copyFile(fileInfo.fullPath, finalDest);

        const result: SyncResult = {
          provider: connector.id as CloudProviderID,
          label: connector.label,
          sourcePath: fileInfo.fullPath,
          destPath: finalDest,
          success: true,
        };
        allResults.push(result);
        synced++;
      } catch (err: any) {
        const result: SyncResult = {
          provider: connector.id as CloudProviderID,
          label: connector.label,
          sourcePath: fileInfo.fullPath,
          destPath: "",
          success: false,
          error: String(err.message || err),
        };
        allResults.push(result);
        failed++;
      }

      current++;
      if (onProgress) onProgress(current, total);
    }
  }

  return { totalFiles: files.length, synced, failed, results: allResults };
}

/**
 * Get the recent sync log.
 */
export function getSyncLog(): SyncResult[] {
  return [..._syncLog];
}

/**
 * Clear the sync log.
 */
export function clearSyncLog(): void {
  _syncLog = [];
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Resolve a unique path in cloud storage (no overwrite).
 * Same logic as fileService.resolveUniquePath but async.
 */
async function resolveUniqueCloudPath(dest: string): Promise<string> {
  try {
    await fsp.access(dest);
  } catch {
    return dest; // doesn't exist — safe to use
  }

  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const base = path.basename(dest, ext);

  let counter = 1;
  let candidate: string;
  do {
    candidate = path.join(dir, `${base}_${counter}${ext}`);
    counter++;
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
  } while (counter < 10000);

  throw new Error(`Cannot find unique name for ${dest} after 10000 attempts`);
}

/**
 * Check if a file exists at the given path with the expected size.
 * Used to skip re-syncing files that are already in cloud.
 */
async function fileExistsWithSize(filePath: string, expectedSize: number): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() && stat.size === expectedSize;
  } catch {
    return false;
  }
}

interface FileInfo {
  fullPath: string;
  filename: string;
  category: string;
  size: number;
}

/**
 * Discover all files in the organized directory (one level of category folders).
 */
async function discoverFiles(baseDir: string): Promise<FileInfo[]> {
  const files: FileInfo[] = [];
  const SKIP = new Set([".ds_store", ".git", "node_modules", "__pycache__"]);

  try {
    const categories = await fsp.readdir(baseDir, { withFileTypes: true });

    for (const catEntry of categories) {
      if (!catEntry.isDirectory()) continue;
      if (catEntry.name.startsWith(".")) continue;
      if (SKIP.has(catEntry.name.toLowerCase())) continue;

      const catDir = path.join(baseDir, catEntry.name);

      try {
        const entries = await fsp.readdir(catDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (entry.name.startsWith(".")) continue;

          const fullPath = path.join(catDir, entry.name);
          try {
            const stat = await fsp.stat(fullPath);
            files.push({
              fullPath,
              filename: entry.name,
              category: catEntry.name,
              size: stat.size,
            });
          } catch { /* skip unreadable files */ }
        }
      } catch { /* skip unreadable folders */ }
    }
  } catch (err) {
    console.warn(`[CloudSync] Failed to discover files in ${baseDir}: ${err}`);
  }

  return files;
}

function appendSyncLog(result: SyncResult): void {
  _syncLog.push(result);
  if (_syncLog.length > MAX_SYNC_LOG) {
    _syncLog = _syncLog.slice(-MAX_SYNC_LOG);
  }
}
