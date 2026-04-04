/**
 * WatcherService.ts — Background folder watcher for Work Mode auto-organize.
 *
 * Watches user-configured folders (e.g. Downloads, Desktop) using the Node.js
 * native fs.watch API (recursive mode, macOS/Windows compatible).
 *
 * TWO-STAGE DELAY:
 *   Stage 1 — Write detection: 1800 ms debounce resets on every fs event.
 *              Ensures the file has finished writing before we touch it.
 *   Stage 2 — 5-minute countdown: starts after Stage 1 fires.
 *              Gives the user a chance to move/delete the file themselves.
 *              Cancelled automatically if the file disappears.
 *              Fires a "watcher:countdown-started" IPC event at the start.
 *
 * After both stages pass, the file is classified and moved to DEST_DIR/<category>.
 * A "watcher:file-organized" event is sent so the renderer can toast the user.
 *
 * Watched folder list is persisted to userData/watcher_config.json.
 */

import fs   from "fs";
import path from "path";
import { app } from "electron";

// ── Types ──────────────────────────────────────────────────────────────────

export interface WatcherConfig {
  enabled: boolean;
  folders: string[];  // Absolute paths to watch
}

export interface WatcherEvent {
  filename: string;
  sourcePath: string;
  destPath: string;
  category: string;
  confidence: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const CONFIG_FILE      = "watcher_config.json";
const DEBOUNCE_MS      = 1800;          // Stage 1: write-complete quiet period (ms)
const COUNTDOWN_MS     = 5 * 60_000;   // Stage 2: 5-minute grace period (ms)
const COUNTDOWN_SECS   = 300;          // Seconds sent in countdown-started event
const MIN_FILE_SIZE    = 50;           // Skip empty/partial files (bytes)

// Extensions to skip outright (system files, temp files, etc.)
const SKIP_EXT = new Set([
  ".tmp", ".crdownload", ".part", ".download", ".partial",
  ".DS_Store", ".localized", ".swp", ".swo", "~",
  ".lock", ".lck",
]);

// ── State ──────────────────────────────────────────────────────────────────

// Map of folder path → fs.FSWatcher instance
const watchers = new Map<string, fs.FSWatcher>();

// Stage 1 debounce timers: filePath → timer (write-complete detection)
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Stage 2 countdown timers: filePath → timer (5-minute grace period)
const countdownTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Callback injected by index.js — called when a file needs processing
type OrganizeCallback = (filePath: string) => Promise<WatcherEvent | null>;
let organizeCallback: OrganizeCallback | null = null;

// Callback for pushing organized-file events to the renderer
type NotifyCallback = (event: WatcherEvent) => void;
let notifyCallback: NotifyCallback | null = null;

// Callback fired when a 5-minute countdown begins for a file
type CountdownCallback = (filename: string, filePath: string, countdownSeconds: number) => void;
let countdownCallback: CountdownCallback | null = null;

// The organized-files destination root — files inside it are never re-watched
let destDir = "";

// ── Config persistence ─────────────────────────────────────────────────────

function configPath(): string {
  return path.join(app.getPath("userData"), CONFIG_FILE);
}

export function loadConfig(): WatcherConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") return data as WatcherConfig;
  } catch { /* first run */ }
  return { enabled: false, folders: [] };
}

function saveConfig(cfg: WatcherConfig): void {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf-8");
  } catch (err) {
    console.error("[Watcher] Failed to save config:", err);
  }
}

// ── File validation ────────────────────────────────────────────────────────

function shouldSkip(filePath: string): boolean {
  const base = path.basename(filePath);
  const ext  = path.extname(base).toLowerCase();

  // Skip hidden files and macOS junk
  if (base.startsWith(".")) return true;
  if (SKIP_EXT.has(ext))   return true;

  // Skip files already inside the destination tree
  if (destDir && filePath.startsWith(destDir)) return true;

  // Must exist and be a real file
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < MIN_FILE_SIZE) return true;
  } catch {
    return true;
  }

  return false;
}

// ── Core watch logic ────────────────────────────────────────────────────────

/**
 * Cancel any pending Stage-2 countdown for a file.
 * Called when the file is moved or deleted before the countdown fires.
 */
function cancelCountdown(filePath: string): void {
  if (countdownTimers.has(filePath)) {
    clearTimeout(countdownTimers.get(filePath)!);
    countdownTimers.delete(filePath);
    console.log(`[Watcher] Countdown cancelled: ${path.basename(filePath)}`);
  }
}

/**
 * Start the Stage-2 five-minute countdown for a file.
 * Fires the countdownCallback immediately so the renderer can show a notice.
 * After 5 minutes, validates the file still exists then organizes it.
 */
function startCountdown(filePath: string): void {
  cancelCountdown(filePath); // Reset if re-triggered

  const filename = path.basename(filePath);
  console.log(`[Watcher] Countdown started (5 min): ${filename}`);

  // Notify renderer immediately so it can display the countdown
  countdownCallback?.(filename, filePath, COUNTDOWN_SECS);

  const timer = setTimeout(async () => {
    countdownTimers.delete(filePath);

    // Re-validate: file may have been moved/deleted during the wait
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

/**
 * Handle an fs.watch event for a file.
 *
 * Stage 1 — Write detection (DEBOUNCE_MS = 1800 ms):
 *   Reset the debounce timer on every event. When the file goes quiet, the
 *   timer fires and starts Stage 2.
 *
 * Rename/delete events cancel any pending countdown for that file.
 *
 * @param filePath  Absolute path to the changed file
 * @param eventType "rename" | "change" from fs.watch
 */
function handleFileEvent(filePath: string, eventType?: string): void {
  // If the file no longer exists (moved or deleted), cancel its countdown
  if (eventType === "rename" && !fs.existsSync(filePath)) {
    cancelCountdown(filePath);
    // Also clear any pending write-debounce
    if (debounceTimers.has(filePath)) {
      clearTimeout(debounceTimers.get(filePath)!);
      debounceTimers.delete(filePath);
    }
    return;
  }

  // Stage 1: reset write-detection debounce
  if (debounceTimers.has(filePath)) {
    clearTimeout(debounceTimers.get(filePath)!);
  }

  const writeTimer = setTimeout(() => {
    debounceTimers.delete(filePath);

    if (shouldSkip(filePath)) {
      cancelCountdown(filePath);
      return;
    }

    // File is done writing — start the 5-minute Stage-2 countdown
    startCountdown(filePath);
  }, DEBOUNCE_MS);

  debounceTimers.set(filePath, writeTimer);
}

function startWatchingFolder(folder: string): void {
  if (watchers.has(folder)) return; // Already watching
  if (!fs.existsSync(folder))       return; // Folder doesn't exist

  console.log(`[Watcher] Watching: ${folder}`);

  try {
    const watcher = fs.watch(
      folder,
      { recursive: true },
      (eventType, filename) => {
        if (!filename) return;
        const fullPath = path.join(folder, filename);
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

function stopWatchingFolder(folder: string): void {
  const watcher = watchers.get(folder);
  if (watcher) {
    try { watcher.close(); } catch { /* ignore */ }
    watchers.delete(folder);
    console.log(`[Watcher] Stopped watching: ${folder}`);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize the watcher service.
 * Called once from index.js after the window is ready.
 *
 * @param dest            The organized-files root (DEST_DIR)
 * @param onOrganize      Async callback that classifies + moves a file
 * @param onNotify        Callback to send WatcherEvent to renderer
 * @param onCountdown     Optional: called when a 5-minute countdown begins
 *                        Arguments: (filename, filePath, countdownSeconds)
 */
export function initWatcher(
  dest: string,
  onOrganize: OrganizeCallback,
  onNotify: NotifyCallback,
  onCountdown?: CountdownCallback
): void {
  destDir           = dest;
  organizeCallback  = onOrganize;
  notifyCallback    = onNotify;
  countdownCallback = onCountdown ?? null;

  // Resume watching if previously enabled
  const cfg = loadConfig();
  if (cfg.enabled) {
    for (const folder of cfg.folders) {
      startWatchingFolder(folder);
    }
  }
}

/** Add a folder to the watch list and start watching it immediately. */
export function addWatchFolder(folder: string): WatcherConfig {
  const cfg = loadConfig();
  if (!cfg.folders.includes(folder)) {
    cfg.folders.push(folder);
  }
  cfg.enabled = true;
  saveConfig(cfg);
  startWatchingFolder(folder);
  return cfg;
}

/** Remove a folder from the watch list and stop watching it. */
export function removeWatchFolder(folder: string): WatcherConfig {
  const cfg = loadConfig();
  cfg.folders = cfg.folders.filter((f) => f !== folder);
  if (cfg.folders.length === 0) cfg.enabled = false;
  saveConfig(cfg);
  stopWatchingFolder(folder);
  return cfg;
}

/** Enable or disable all watching without removing folder list. */
export function setWatcherEnabled(enabled: boolean): WatcherConfig {
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

/** Get current config + running status. */
export function getWatcherStatus(): WatcherConfig & { activeWatchers: number } {
  const cfg = loadConfig();
  return { ...cfg, activeWatchers: watchers.size };
}
