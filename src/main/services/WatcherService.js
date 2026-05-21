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
var WatcherService_exports = {};
__export(WatcherService_exports, {
  addWatchFolder: () => addWatchFolder,
  getWatcherStatus: () => getWatcherStatus,
  initWatcher: () => initWatcher,
  loadConfig: () => loadConfig,
  removeWatchFolder: () => removeWatchFolder,
  setWatcherEnabled: () => setWatcherEnabled
});
module.exports = __toCommonJS(WatcherService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_electron = require("electron");
const CONFIG_FILE = "watcher_config.json";
const DEBOUNCE_MS = 1800;
const COUNTDOWN_MS = 5 * 6e4;
const COUNTDOWN_SECS = 300;
const MIN_FILE_SIZE = 50;
const SKIP_EXT = /* @__PURE__ */ new Set([
  ".tmp",
  ".crdownload",
  ".part",
  ".download",
  ".partial",
  ".DS_Store",
  ".localized",
  ".swp",
  ".swo",
  "~",
  ".lock",
  ".lck"
]);
const watchers = /* @__PURE__ */ new Map();
const debounceTimers = /* @__PURE__ */ new Map();
const countdownTimers = /* @__PURE__ */ new Map();
let organizeCallback = null;
let notifyCallback = null;
let countdownCallback = null;
let destDir = "";
function configPath() {
  return import_path.default.join(import_electron.app.getPath("userData"), CONFIG_FILE);
}
function loadConfig() {
  try {
    const raw = import_fs.default.readFileSync(configPath(), "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") return data;
  } catch {
  }
  return { enabled: false, folders: [] };
}
function saveConfig(cfg) {
  try {
    import_fs.default.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf-8");
  } catch (err) {
    console.error("[Watcher] Failed to save config:", err);
  }
}
function shouldSkip(filePath) {
  const base = import_path.default.basename(filePath);
  const ext = import_path.default.extname(base).toLowerCase();
  if (base.startsWith(".")) return true;
  if (SKIP_EXT.has(ext)) return true;
  if (destDir && filePath.startsWith(destDir)) return true;
  try {
    const stat = import_fs.default.statSync(filePath);
    if (!stat.isFile() || stat.size < MIN_FILE_SIZE) return true;
  } catch {
    return true;
  }
  return false;
}
function cancelCountdown(filePath) {
  if (countdownTimers.has(filePath)) {
    clearTimeout(countdownTimers.get(filePath));
    countdownTimers.delete(filePath);
    console.log(`[Watcher] Countdown cancelled: ${import_path.default.basename(filePath)}`);
  }
}
function startCountdown(filePath) {
  cancelCountdown(filePath);
  const filename = import_path.default.basename(filePath);
  console.log(`[Watcher] Countdown started (5 min): ${filename}`);
  countdownCallback?.(filename, filePath, COUNTDOWN_SECS);
  const timer = setTimeout(async () => {
    countdownTimers.delete(filePath);
    if (shouldSkip(filePath)) {
      console.log(`[Watcher] File gone after countdown, skipping: ${filename}`);
      return;
    }
    if (!organizeCallback) return;
    console.log(`[Watcher] Organizing after countdown: ${filename}`);
    try {
      const event = await organizeCallback(filePath);
      if (event && notifyCallback) notifyCallback(event);
    } catch (err) {
      console.error(`[Watcher] Failed to organize ${filename}:`, err);
    }
  }, COUNTDOWN_MS);
  countdownTimers.set(filePath, timer);
}
function handleFileEvent(filePath, eventType) {
  if (eventType === "rename" && !import_fs.default.existsSync(filePath)) {
    cancelCountdown(filePath);
    if (debounceTimers.has(filePath)) {
      clearTimeout(debounceTimers.get(filePath));
      debounceTimers.delete(filePath);
    }
    return;
  }
  if (debounceTimers.has(filePath)) {
    clearTimeout(debounceTimers.get(filePath));
  }
  const writeTimer = setTimeout(() => {
    debounceTimers.delete(filePath);
    if (shouldSkip(filePath)) {
      cancelCountdown(filePath);
      return;
    }
    startCountdown(filePath);
  }, DEBOUNCE_MS);
  debounceTimers.set(filePath, writeTimer);
}
function startWatchingFolder(folder) {
  if (watchers.has(folder)) return;
  if (!import_fs.default.existsSync(folder)) return;
  console.log(`[Watcher] Watching: ${folder}`);
  try {
    const watcher = import_fs.default.watch(
      folder,
      { recursive: true },
      (eventType, filename) => {
        if (!filename) return;
        const fullPath = import_path.default.join(folder, filename);
        handleFileEvent(fullPath, eventType);
      }
    );
    watcher.on("error", (err) => {
      console.error(`[Watcher] Error on ${folder}:`, err);
      watchers.delete(folder);
    });
    watchers.set(folder, watcher);
  } catch (err) {
    console.error(`[Watcher] Could not watch ${folder}:`, err);
  }
}
function stopWatchingFolder(folder) {
  const watcher = watchers.get(folder);
  if (watcher) {
    try {
      watcher.close();
    } catch {
    }
    watchers.delete(folder);
    console.log(`[Watcher] Stopped watching: ${folder}`);
  }
}
function initWatcher(dest, onOrganize, onNotify, onCountdown) {
  destDir = dest;
  organizeCallback = onOrganize;
  notifyCallback = onNotify;
  countdownCallback = onCountdown ?? null;
  const cfg = loadConfig();
  if (cfg.enabled) {
    for (const folder of cfg.folders) {
      startWatchingFolder(folder);
    }
  }
}
function addWatchFolder(folder) {
  const cfg = loadConfig();
  if (!cfg.folders.includes(folder)) {
    cfg.folders.push(folder);
  }
  cfg.enabled = true;
  saveConfig(cfg);
  startWatchingFolder(folder);
  return cfg;
}
function removeWatchFolder(folder) {
  const cfg = loadConfig();
  cfg.folders = cfg.folders.filter((f) => f !== folder);
  if (cfg.folders.length === 0) cfg.enabled = false;
  saveConfig(cfg);
  stopWatchingFolder(folder);
  return cfg;
}
function setWatcherEnabled(enabled) {
  const cfg = loadConfig();
  cfg.enabled = enabled;
  saveConfig(cfg);
  if (enabled) {
    for (const folder of cfg.folders) startWatchingFolder(folder);
  } else {
    for (const folder of cfg.folders) stopWatchingFolder(folder);
  }
  return cfg;
}
function getWatcherStatus() {
  const cfg = loadConfig();
  return { ...cfg, activeWatchers: watchers.size };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  addWatchFolder,
  getWatcherStatus,
  initWatcher,
  loadConfig,
  removeWatchFolder,
  setWatcherEnabled
});
