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
var CloudSyncService_exports = {};
__export(CloudSyncService_exports, {
  bulkSyncToCloud: () => bulkSyncToCloud,
  clearSyncLog: () => clearSyncLog,
  getSyncLog: () => getSyncLog,
  syncFileToCloud: () => syncFileToCloud
});
module.exports = __toCommonJS(CloudSyncService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_CloudConnectorService = require("./CloudConnectorService");
const fsp = import_fs.default.promises;
let _syncLog = [];
const MAX_SYNC_LOG = 500;
async function syncFileToCloud(localDestPath, category) {
  const connectors = (0, import_CloudConnectorService.getEnabledConnectors)();
  if (connectors.length === 0) return [];
  const filename = import_path.default.basename(localDestPath);
  const results = [];
  for (const connector of connectors) {
    try {
      const cloudCategoryDir = import_path.default.join(connector.destPath, category);
      await fsp.mkdir(cloudCategoryDir, { recursive: true });
      const cloudDest = import_path.default.join(cloudCategoryDir, filename);
      const finalDest = await resolveUniqueCloudPath(cloudDest);
      await fsp.copyFile(localDestPath, finalDest);
      const [srcStat, dstStat] = await Promise.all([
        fsp.stat(localDestPath),
        fsp.stat(finalDest)
      ]);
      if (srcStat.size !== dstStat.size) {
        await fsp.unlink(finalDest).catch(() => {
        });
        throw new Error(
          `Size mismatch: expected ${srcStat.size} bytes, got ${dstStat.size}`
        );
      }
      const result = {
        provider: connector.id,
        label: connector.label,
        sourcePath: localDestPath,
        destPath: finalDest,
        success: true
      };
      results.push(result);
      appendSyncLog(result);
      console.log(
        `[CloudSync] \u2713 ${filename} \u2192 ${connector.label}/${category}/`
      );
    } catch (err) {
      const result = {
        provider: connector.id,
        label: connector.label,
        sourcePath: localDestPath,
        destPath: "",
        success: false,
        error: String(err.message || err)
      };
      results.push(result);
      appendSyncLog(result);
      console.warn(
        `[CloudSync] \u2717 ${filename} \u2192 ${connector.label}: ${err.message || err}`
      );
    }
  }
  return results;
}
async function bulkSyncToCloud(localBaseDir, onProgress) {
  const connectors = (0, import_CloudConnectorService.getEnabledConnectors)();
  if (connectors.length === 0) {
    return { totalFiles: 0, synced: 0, failed: 0, results: [] };
  }
  const files = await discoverFiles(localBaseDir);
  const total = files.length * connectors.length;
  let current = 0;
  let synced = 0;
  let failed = 0;
  const allResults = [];
  for (const fileInfo of files) {
    for (const connector of connectors) {
      try {
        const cloudCategoryDir = import_path.default.join(connector.destPath, fileInfo.category);
        await fsp.mkdir(cloudCategoryDir, { recursive: true });
        const cloudDest = import_path.default.join(cloudCategoryDir, fileInfo.filename);
        if (await fileExistsWithSize(cloudDest, fileInfo.size)) {
          synced++;
          current++;
          if (onProgress) onProgress(current, total);
          continue;
        }
        const finalDest = await resolveUniqueCloudPath(cloudDest);
        await fsp.copyFile(fileInfo.fullPath, finalDest);
        const result = {
          provider: connector.id,
          label: connector.label,
          sourcePath: fileInfo.fullPath,
          destPath: finalDest,
          success: true
        };
        allResults.push(result);
        synced++;
      } catch (err) {
        const result = {
          provider: connector.id,
          label: connector.label,
          sourcePath: fileInfo.fullPath,
          destPath: "",
          success: false,
          error: String(err.message || err)
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
function getSyncLog() {
  return [..._syncLog];
}
function clearSyncLog() {
  _syncLog = [];
}
async function resolveUniqueCloudPath(dest) {
  try {
    await fsp.access(dest);
  } catch {
    return dest;
  }
  const dir = import_path.default.dirname(dest);
  const ext = import_path.default.extname(dest);
  const base = import_path.default.basename(dest, ext);
  let counter = 1;
  let candidate;
  do {
    candidate = import_path.default.join(dir, `${base}_${counter}${ext}`);
    counter++;
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
  } while (counter < 1e4);
  throw new Error(`Cannot find unique name for ${dest} after 10000 attempts`);
}
async function fileExistsWithSize(filePath, expectedSize) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() && stat.size === expectedSize;
  } catch {
    return false;
  }
}
async function discoverFiles(baseDir) {
  const files = [];
  const SKIP = /* @__PURE__ */ new Set([".ds_store", ".git", "node_modules", "__pycache__"]);
  try {
    const categories = await fsp.readdir(baseDir, { withFileTypes: true });
    for (const catEntry of categories) {
      if (!catEntry.isDirectory()) continue;
      if (catEntry.name.startsWith(".")) continue;
      if (SKIP.has(catEntry.name.toLowerCase())) continue;
      const catDir = import_path.default.join(baseDir, catEntry.name);
      try {
        const entries = await fsp.readdir(catDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (entry.name.startsWith(".")) continue;
          const fullPath = import_path.default.join(catDir, entry.name);
          try {
            const stat = await fsp.stat(fullPath);
            files.push({
              fullPath,
              filename: entry.name,
              category: catEntry.name,
              size: stat.size
            });
          } catch {
          }
        }
      } catch {
      }
    }
  } catch (err) {
    console.warn(`[CloudSync] Failed to discover files in ${baseDir}: ${err}`);
  }
  return files;
}
function appendSyncLog(result) {
  _syncLog.push(result);
  if (_syncLog.length > MAX_SYNC_LOG) {
    _syncLog = _syncLog.slice(-MAX_SYNC_LOG);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  bulkSyncToCloud,
  clearSyncLog,
  getSyncLog,
  syncFileToCloud
});
