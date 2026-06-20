/**
 * index.js - Electron main process entry point.
 * Wires together: OllamaManager, ModelPuller, LicenseService, FileService.
 */

const path = require("path");

// 1. Point esbuild to the unpacked folder BEFORE it tries to run.
//
//    The native binary location differs by platform:
//      Windows  → @esbuild/win32-{arch}/esbuild.exe   (no bin/ subdir)
//      macOS    → @esbuild/darwin-{arch}/bin/esbuild
//      Linux    → @esbuild/linux-{arch}/bin/esbuild
//
//    Mirrors the logic in esbuild's own pkgAndSubpathForCurrentPlatform().
if (__dirname.includes("app.asar")) {
  const unpackedModules = path.join(
    process.resourcesPath,
    "app.asar.unpacked",
    "node_modules"
  );

  const platform = process.platform; // 'win32' | 'darwin' | 'linux'
  const arch     = process.arch;     // 'x64' | 'arm64' | 'ia32'

  // Map [platform, arch] → @esbuild package name + binary subpath
  const platformMap = {
    // Windows — binary sits at package root, not in bin/
    win32: {
      x64:   { pkg: "@esbuild/win32-x64",   bin: "esbuild.exe" },
      arm64: { pkg: "@esbuild/win32-arm64",  bin: "esbuild.exe" },
      ia32:  { pkg: "@esbuild/win32-ia32",   bin: "esbuild.exe" },
    },
    // macOS
    darwin: {
      x64:   { pkg: "@esbuild/darwin-x64",   bin: path.join("bin", "esbuild") },
      arm64: { pkg: "@esbuild/darwin-arm64",  bin: path.join("bin", "esbuild") },
    },
    // Linux
    linux: {
      x64:   { pkg: "@esbuild/linux-x64",    bin: path.join("bin", "esbuild") },
      arm64: { pkg: "@esbuild/linux-arm64",   bin: path.join("bin", "esbuild") },
      arm:   { pkg: "@esbuild/linux-arm",     bin: path.join("bin", "esbuild") },
    },
  };

  const entry = (platformMap[platform] || {})[arch];
  if (entry) {
    process.env.ESBUILD_BINARY_PATH = path.join(unpackedModules, entry.pkg, entry.bin);
  } else {
    // Fallback — older esbuild layout (pre-0.17, binary inside the main package)
    const ext = platform === "win32" ? ".exe" : "";
    process.env.ESBUILD_BINARY_PATH = path.join(
      unpackedModules, "esbuild", "bin", `esbuild${ext}`
    );
  }

  console.log(`[main] ESBUILD_BINARY_PATH = ${process.env.ESBUILD_BINARY_PATH}`);
}

// 2. Register tsx CJS hook — DEVELOPMENT ONLY.
//
//    In the packaged app (app.asar) all TypeScript service files are
//    pre-compiled to JavaScript by scripts/compile-ts.js before packing,
//    so tsx is never needed at runtime in production.
//
//    In development (plain node_modules, no asar) tsx is still available
//    as a devDependency and is loaded here so .ts files can be required
//    directly without a manual compile step.
if (!__dirname.includes("app.asar")) {
  try {
    require(path.join(__dirname, "..", "..", "node_modules", "tsx", "dist", "cjs", "index.cjs"));
    console.log("[main] tsx CJS hook registered (dev mode)");
  } catch (e) {
    // tsx not installed (e.g. npm ci --omit=dev) — .js files must exist
    console.warn("[main] tsx not available:", e.message);
  }
}

// ── Global crash guards — must be registered before any other code ──────────
// Without these, an unhandled promise rejection anywhere in an IPC handler
// will crash the main process silently and leave the user with a frozen app.

process.on("uncaughtException", (err) => {
  console.error("[main] uncaughtException:", err);
  // Attempt to show a native error dialog if Electron is ready
  try {
    const { dialog: _d, app: _a } = require("electron");
    _d.showErrorBox(
      "AI Organizer — Unexpected Error",
      `An unexpected error occurred and the app needs to restart.\n\n${err.message}\n\nIf this keeps happening, please contact support.`
    );
    _a.exit(1);
  } catch {
    process.exit(1);
  }
});

process.on("unhandledRejection", (reason) => {
  // Log but don't crash — unhandled rejections in non-critical paths
  // (background tasks, optional features) shouldn't kill the whole app.
  const msg = reason instanceof Error ? reason.stack : String(reason);
  console.error("[main] unhandledRejection:", msg);

  // Only show dialog for truly fatal-looking rejections
  // (those whose message contains keywords suggesting core system failure)
  if (typeof msg === "string" && /model|llama|database|corrupt|enoent/i.test(msg)) {
    try {
      const { dialog: _d } = require("electron");
      _d.showErrorBox(
        "AI Organizer — Background Error",
        `A background operation failed.\n\n${msg.slice(0, 300)}\n\nThe app will continue running. If AI features stop working, please restart.`
      );
    } catch { /* dialog not yet available */ }
  }
});

// 3. Load the rest of the dependencies
const os = require("os");
const fs = require("fs");
const https = require("https");
const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, Notification } = require("electron");
const { autoUpdater } = require("electron-updater");
const { buildAppMenu } = require("./appMenu");

// ── Hardcoded destination (computed once in main process) ────
const DEST_DIR = path.join(os.homedir(), "Desktop", "AI_SORTED_FILES");
console.log(`[main] TARGET DIRECTORY: ${DEST_DIR}`);

// Ensure the destination folder exists on startup (clean slate — 0 default subfolders)
if (!fs.existsSync(DEST_DIR)) {
  fs.mkdirSync(DEST_DIR, { recursive: true });
  console.log(`[main] Created destination folder: ${DEST_DIR}`);
}
// Always ensure "Needs Review" fallback folder exists
const needsReviewDir = path.join(DEST_DIR, "Needs Review");
if (!fs.existsSync(needsReviewDir)) {
  fs.mkdirSync(needsReviewDir, { recursive: true });
  console.log(`[main] Created "Needs Review" folder: ${needsReviewDir}`);
}

// ── Dual Mode Architecture ─────────────────────────────────
const PERSONAL_DIR = DEST_DIR;

// Cross-platform Work Mode directory
function resolveWorkDir() {
  if (process.platform === "darwin") {
    // macOS: iCloud Drive
    return path.join(os.homedir(), "Library", "Mobile Documents",
      "com~apple~CloudDocs", "AI_ORGANIZER_PRO");
  } else if (process.platform === "win32") {
    // Windows: AppData or OneDrive if available
    const oneDrive = process.env.OneDrive || process.env.OneDriveConsumer;
    if (oneDrive && fs.existsSync(oneDrive)) {
      return path.join(oneDrive, "AI_ORGANIZER_PRO");
    }
    return path.join(os.homedir(), "Documents", "AI_ORGANIZER_PRO");
  } else {
    // Linux: XDG data home or fallback
    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    return path.join(xdgData, "AI_ORGANIZER_PRO");
  }
}
const WORK_DIR = resolveWorkDir();
let currentBaseDir = PERSONAL_DIR;
let currentMode = "personal";

// ── Disambiguation queue (module-level so IPC handler can access it) ────────
const disambiguationQueue = [];
let disambiguationActive  = false;

function drainDisambiguationQueue() {
  if (disambiguationActive || disambiguationQueue.length === 0) return;
  const item = disambiguationQueue.shift();
  disambiguationActive = true;
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send("watcher:needs-disambiguation", item);
  } else {
    disambiguationActive = false;
    drainDisambiguationQueue();
  }
}

// LAN config: persisted in userData so it survives restarts
const LAN_CONFIG_PATH = path.join(require("electron").app.getPath
  ? require("electron").app.getPath("userData")
  : os.homedir(), "lan_config.json");

function loadLanConfig() {
  try {
    if (fs.existsSync(LAN_CONFIG_PATH)) return JSON.parse(fs.readFileSync(LAN_CONFIG_PATH, "utf-8"));
  } catch { /* ignore */ }
  return { ollamaUrl: "http://127.0.0.1:11434", sharedDriveNote: "" };
}
function saveLanConfig(cfg) {
  fs.writeFileSync(LAN_CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

const { ensureModel, isModelDownloaded, getModelPath } = require("./engine/modelDownloader");
const license = require("./services/licenseService");
const Store   = require("electron-store");
const appSettingsStore = new Store({ name: "app-settings" });
const { spawnSync } = require("child_process");
const { safeMoveFile, scanUserFolders } = require("./services/fileService");

// Active Learning + Classification
const {
  classifyFile,
  classifyBatch,
  submitCorrection,
  findExistingEquivalent,
  disambiguateCategories,
} = require("./services/ClassificationService");

// Background idle-time learner
const {
  startBackgroundLearner,
  pauseLearner,
  resumeLearner,
  stopLearner,
  resetLedger: resetLearnerLedger,
  notifyUserActivity,
  onStatusChange: onLearnerStatusChange,
  getStatus: getLearnerStatus,
} = require("./services/BackgroundLearnerService");

// Chat + File Search
const { handleChatMessage, quickSearch } = require("./services/ChatService");
const { indexFile, searchFiles, searchFilesHybrid, getAllEntries, getFolderSummary, getIndexSize, bulkReindex, needsFullTextUpgrade, upgradeIndexInBackground } = require("./services/SearchIndexService");
const PolicyService = require("./services/PolicyService");

// Enterprise Compliance (Work Mode only)
const {
  initCompliance,
  writeAuditEntry,
  readAuditLog,
  logPIIIncident,
  resolvePIIIncident,
  readPIIIncidents,
  getRetentionRules,
  addRetentionRule,
  deleteRetentionRule,
  scanRetention,
  getComplianceStats,
  buildComplianceReportHTML,
} = require("./services/ComplianceService");

// Folder Watcher (Work Mode auto-organize)
const {
  initWatcher, addWatchFolder, removeWatchFolder,
  setWatcherEnabled, getWatcherStatus,
} = require("./services/WatcherService");

// Workflow Engine (background file workflows — PDF summary, etc.)
const {
  initWorkflowEngine, onFileReady: workflowOnFileReady,
  PREF_PDF_SUMMARY_ENABLED,
} = require("./services/WorkflowEngine");

// AI Batch Rename
const { suggestRename, applyRename } = require("./services/RenameService");

// Cloud Storage Connectors (Google Drive + iCloud)
const {
  initCloudConnectors,
  detectCloudStoragePaths,
  listConnectors,
  enableConnector,
  disableConnector,
  setConnectorPath,
  setConnectorSubfolder,
  getConnectorStatus,
  getEnabledConnectors,
  redetect: redetectCloudProviders,
} = require("./services/CloudConnectorService");
const {
  syncFileToCloud,
  bulkSyncToCloud,
  getSyncLog,
  clearSyncLog,
} = require("./services/CloudSyncService");

// Google Drive API (full two-way integration)
const {
  initGoogleDrive,
  isAuthenticated: isDriveAuthenticated,
  getAuthStatus: getDriveAuthStatus,
  startAuthFlow: startDriveAuth,
  signOut: driveSignOut,
  listFiles: driveListFiles,
  searchFiles: driveSearchFiles,
  downloadFile: driveDownloadFile,
  uploadFile: driveUploadFile,
  createFolder: driveCreateFolder,
  findOrCreateFolder: driveFindOrCreateFolder,
  moveFile: driveMoveFile,
  organizeInDrive: driveOrganizeInDrive,
  getStorageQuota: driveGetQuota,
  cleanupTemp: driveCleanupTemp,
} = require("./services/GoogleDriveService");

const {
  getAllCorrections,
  getStats: getLearningStats,
  clearMemory,
} = require("./services/LearningService");

// Prompt-Based Reorganization
const {
  scanDirectory: prScanDirectory,
  analyzeWithAI: prAnalyzeWithAI,
  buildPreview: prBuildPreview,
  buildPreviewLean: prBuildPreviewLean,
  executePreview: prExecutePreview,
  undoOperation: prUndoOperation,
  getHistory: prGetHistory,
  runFullPipeline: prRunFullPipeline,
  scanLean: prScanLean,
} = require("./services/PromptReorgService");

// Undo Log (persistent, all operations)
const {
  recordOperation: undoLogRecord,
  undoOperation: undoLogUndo,
  getUndoLog,
  clearUndoLog,
} = require("./services/UndoLogService");

// Organization Templates
const {
  getAllTemplates,
  recordTemplateUse,
  saveCustomTemplate,
  deleteCustomTemplate,
} = require("./services/TemplateService");

// Scan Cache
const {
  getCacheStats: getScanCacheStats,
  invalidateCacheEntry: invalidateScanCache,
} = require("./services/ScanCacheService");

// AI Health Monitor
const {
  startHealthMonitor: startAIHealthMonitor,
  stopHealthMonitor: stopAIHealthMonitor,
  getAIStatus,
  markModelReady: aiHealthMarkReady,
  markModelError: aiHealthMarkError,
} = require("./services/AIHealthService");

// Pool Enrichment (wires corrections → pool terms)
const { bulkEnrichFromHistory } = require("./services/PoolEnrichmentService");

// Pool Maintenance (scheduled 7-day decay)
const {
  checkAndRunStartupMaintenance,
  runForcedMaintenance,
  isMaintenanceDue,
} = require("./services/PoolMaintenanceService");

// Knowledge Graph (AI-powered domain vocabulary)
const {
  validateAndApplyKGOnStartup,
  bootstrapNewFolder,
  rebuildAllFolders,
  loadKG,
} = require("./services/KnowledgeGraphService");

// Folder Fingerprinting + Text Extraction + Topic Aliasing
const {
  getFolderContext,
  getFolderContextForPrompt,
  invalidateCache: invalidateFingerprintCache,
  getCachedFingerprints,
  getCachedAliases,
  saveAliasMap,
  isNoiseFolderName,
  getNoiseFolders,
} = require("./services/ContextService");
const {
  checkOCRAvailable,
  checkExtractionCapabilities,
  extractText,
  extractFullText,
  terminateOCRWorker,
} = require("./services/TextExtractionService");

let mainWindow = null;
let tray = null;
let isQuitting = false;

// ── Helper: show a native dialog when the AI model fails to load / download ──
// Called from the model-init block below. Safe to call before the window exists
// because dialog.showErrorBox() works without a parent window.
function _showModelErrorDialog(errorMessage, isDownloadError = false) {
  try {
    const title = isDownloadError
      ? "AI Organizer — Model Download Failed"
      : "AI Organizer — AI Model Error";
    const detail = isDownloadError
      ? `The AI model could not be downloaded.\n\n${errorMessage}\n\nCheck your internet connection and restart the app to try again. If the problem persists, visit the Help menu for support.`
      : `The AI model failed to load.\n\n${errorMessage}\n\nTry restarting the app. If the error continues, reinstall the application or contact support.`;
    dialog.showErrorBox(title, detail);
  } catch (e) {
    console.error("[main] _showModelErrorDialog failed:", e);
  }
}

// ── App lifecycle ────────────────────────────────────────────

app.whenReady().then(async () => {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 720,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Load the renderer
  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  // ── Build application menu with keyboard shortcuts ──
  buildAppMenu(mainWindow);

  // ── System Tray Icon (minimize-to-tray) ──
  const trayIcon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVQ4T2NkYPj/n4EBCBgZGRlBAMQGsUEMDFgASA9YDYgN14xVM2oAbhfgDEe8fgYAqCMSEfSLzCQAAAAASUVORK5CYII="
  );
  tray = new Tray(trayIcon);
  tray.setToolTip("AI Organizer");
  const trayMenu = Menu.buildFromTemplate([
    {
      label: "Show / Hide",
      click: () => {
        if (mainWindow) {
          if (mainWindow.isVisible()) mainWindow.hide();
          else mainWindow.show();
        }
      },
    },
    { type: "separator" },
    {
      label: "Open Files...",
      click: () => mainWindow?.webContents.send("menu:action", "open-files"),
    },
    {
      label: "Sync Cloud",
      click: () => mainWindow?.webContents.send("menu:action", "cloud-sync"),
    },
    { type: "separator" },
    {
      label: "Quit AI Organizer",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(trayMenu);
  tray.on("click", () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else mainWindow.show();
    }
  });

  // ── Minimize to tray on window close (macOS) ──
  mainWindow.on("close", (e) => {
    if (!isQuitting && process.platform === "darwin") {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // ── 1. Load the on-device AI model (node-llama-cpp, no Ollama needed) ──
  try {
    if (isModelDownloaded()) {
      // Model is already on disk — load it immediately
      console.log("[main] Model found — loading into memory …");
      const LlamaService = require("./services/LlamaService");
      LlamaService.initialize().then((result) => {
        if (result.success) {
          console.log("[main] AI model ready.");
          mainWindow?.webContents.send("model:ready");
          aiHealthMarkReady();
          startAIHealthMonitor();
        } else {
          console.error(`[main] Model load failed: ${result.error}`);
          mainWindow?.webContents.send("model:error", result.error);
          aiHealthMarkError();
          _showModelErrorDialog(result.error);
        }
      }).catch((err) => {
        console.error(`[main] Model initialize() threw: ${err.message}`);
        mainWindow?.webContents.send("model:error", err.message);
        aiHealthMarkError();
        _showModelErrorDialog(err.message);
      });
    } else {
      // First launch — download the GGUF then load it
      console.log("[main] Model not found — starting first-launch download …");
      setTimeout(async () => {
        mainWindow?.webContents.send("model:needs-download");
        let result;
        try {
          result = await ensureModel(mainWindow, null);
        } catch (downloadErr) {
          console.error(`[main] ensureModel threw: ${downloadErr.message}`);
          mainWindow?.webContents.send("model:download-error", { message: downloadErr.message });
          _showModelErrorDialog(downloadErr.message, true);
          return;
        }
        if (result.success) {
          const LlamaService = require("./services/LlamaService");
          const loadResult = await LlamaService.initialize();
          if (loadResult.success) {
            mainWindow?.webContents.send("model:ready");
            aiHealthMarkReady();
            startAIHealthMonitor();
          } else {
            mainWindow?.webContents.send("model:error", loadResult.error);
            aiHealthMarkError();
            _showModelErrorDialog(loadResult.error);
          }
        } else {
          mainWindow?.webContents.send("model:download-error", { message: result.error });
          aiHealthMarkError();
          _showModelErrorDialog(result.error, true);
        }
      }, 2000);
    }
  } catch (err) {
    console.error(`[main] AI engine startup failed: ${err.message}`);
    mainWindow?.webContents.send("model:error", err.message);
    _showModelErrorDialog(err.message);
  }

  // ── 2. Init compliance service (Work Mode) ──
  try {
    initCompliance(WORK_DIR);
    console.log("[main] Compliance service initialized");
  } catch (err) {
    console.warn(`[main] Compliance init failed: ${err.message}`);
  }

  // ── 2b. Pool maintenance (7-day scheduled) ──
  try {
    checkAndRunStartupMaintenance(DEST_DIR);
  } catch (err) {
    console.warn(`[main] Pool maintenance check failed: ${err.message}`);
  }

  // ── 2c. Knowledge graph startup validation ──
  try {
    validateAndApplyKGOnStartup(DEST_DIR);
  } catch (err) {
    console.warn(`[main] Knowledge graph startup validation failed: ${err.message}`);
  }

  // ── 2d. Background full-text index upgrade (silent, one-time) ──
  try {
    if (needsFullTextUpgrade()) {
      console.log("[main] Search index missing fullText — starting background upgrade");
      // Delay slightly so the window is ready to receive events
      setTimeout(() => {
        upgradeIndexInBackground(
          (filePath) => extractFullText(filePath),
          (progress) => {
            const win = BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send("search:upgrade-progress", progress);
            }
          }
        ).then(() => {
          console.log("[main] Full-text index upgrade complete");
          const win = BrowserWindow.getAllWindows()[0];
          if (win && !win.isDestroyed()) {
            win.webContents.send("search:upgrade-progress", { done: true });
          }
        }).catch((err) => {
          console.warn("[main] Full-text upgrade error:", err.message);
        });
      }, 5000);
    }
  } catch (err) {
    console.warn(`[main] Full-text upgrade check failed: ${err.message}`);
  }

  // ── 3. Init folder watcher (Work Mode auto-organize) ──
  try {
    initWatcher(
      DEST_DIR,
      // ── 4-Step Disambiguation Pipeline ───────────────────────────────────
      //
      // CONFIDENCE TIERS (designed to minimize confirmation requests):
      //
      //   ≥ 70%  → AUTO-MOVE (silent if ≥90%, toast if 70-89%)
      //   50-69% + runner-up → DISAMBIGUATION CARD (user picks once)
      //   < 50%  → NEEDS REVIEW (silent drop, no interruption)
      //
      // After the user confirms a category ~5 times, pool scores rise and
      // most future files for that category hit the ≥70% tier automatically.
      //
      async (filePath) => {
        const folders = await scanUserFolders(DEST_DIR);
        const result  = await classifyFile(filePath, DEST_DIR, folders);
        if (!result || !result.category) return null;

        const filename = path.basename(filePath);
        const confidence = result.confidence || 0;
        const hasRunnerUp = !!(result.second_category && result.second_category !== result.category);

        // ── Tier 1: Auto-move (≥70% OR no meaningful runner-up) ─────────
        // This covers the vast majority of files after the system has
        // learned a few examples per folder. No user action required.
        const AUTO_MOVE_THRESHOLD = 70;
        const DISAMBIG_FLOOR      = 50;  // below this — just silently route to Needs Review

        if (confidence >= AUTO_MOVE_THRESHOLD || !hasRunnerUp) {
          const dest = path.join(DEST_DIR, result.category, filename);
          await safeMoveFile(filePath, dest);
          try {
            const text = await extractText(filePath);
            indexFile(dest, result.category, text || "");
          } catch { /* non-fatal */ }
          return {
            filename,
            sourcePath: filePath,
            destPath:   dest,
            category:   result.category,
            confidence,
            disambiguated: false,
          };
        }

        // ── Tier 3: Too uncertain even for disambiguation (< 50%) ────────
        // Silently route to Needs Review — don't interrupt the user.
        if (confidence < DISAMBIG_FLOOR) {
          const dest = path.join(DEST_DIR, "Needs Review", filename);
          await safeMoveFile(filePath, dest).catch(() => {});
          return {
            filename,
            sourcePath: filePath,
            destPath:   dest,
            category:   "Needs Review",
            confidence,
            disambiguated: false,
          };
        }

        // ── Tier 2: Disambiguation (50-69% with a real runner-up) ────────
        // Only reaches here when the AI genuinely can't decide between two
        // plausible folders. Queue so multiple uncertain files don't stack.
        const catA = result.category;
        const catB = result.second_category;

        let disambigResult = { catAKeywords: [], catBKeywords: [], reasoning: "" };
        try {
          const text = await extractText(filePath);
          disambigResult = await disambiguateCategories(catA, catB, filename, text || "");
        } catch { /* non-fatal — still show the prompt with empty keywords */ }

        // Push to disambiguation queue — renderer drains it one at a time
        // so the user never sees multiple popups at once.
        disambiguationQueue.push({
          filename,
          filePath,
          catA,
          catAKeywords: disambigResult.catAKeywords,
          catAConfidence: confidence,
          catB,
          catBKeywords: disambigResult.catBKeywords,
          catBConfidence: result.second_confidence || 0,
          reasoning: disambigResult.reasoning,
        });
        drainDisambiguationQueue();

        return null;  // file moved only after user confirms in Step 4
      },
      // onNotify: push event to renderer + native OS notification
      (event) => {
        mainWindow?.webContents.send("watcher:file-organized", event);
        // Native OS notification for background file organization
        if (Notification.isSupported()) {
          const notif = new Notification({
            title: "File Organized",
            body: `${event.filename} → ${event.category}/`,
            silent: true,
          });
          notif.show();
        }
      },
      // onCountdown: file finished writing — 5-minute grace period begins.
      // Also notify WorkflowEngine so background workflows can run immediately
      // (in parallel with the 5-minute grace period before actual organizing).
      (filename, filePath, countdownSeconds) => {
        mainWindow?.webContents.send("watcher:countdown-started", {
          filename,
          filePath,
          countdownSeconds,
        });
        // Workflow Engine hook — purely additive, never interferes with organize
        try { workflowOnFileReady(filename, filePath); } catch { /* non-fatal */ }
      }
    );
    console.log("[main] Folder watcher initialized");
  } catch (err) {
    console.warn(`[main] Folder watcher init failed: ${err.message}`);
  }

  // ── 3a. Init Workflow Engine (background file workflows) ──
  try {
    initWorkflowEngine(
      // Settings getter: reads from electron-store, never throws
      (key, defaultValue) => {
        try { return appSettingsStore.get(key, defaultValue); } catch { return defaultValue; }
      },
      // Renderer notifier: send IPC event to renderer window
      (channel, payload) => {
        mainWindow?.webContents.send(channel, payload);
      }
    );
    console.log("[main] Workflow engine initialized");
  } catch (err) {
    console.warn(`[main] Workflow engine init failed: ${err.message}`);
  }

  // ── 3b. Init cloud storage connectors (Google Drive + iCloud) ──
  try {
    const userDataDir = app.getPath("userData");
    initCloudConnectors(userDataDir);
    console.log("[main] Cloud connectors initialized");
  } catch (err) {
    console.warn(`[main] Cloud connectors init failed: ${err.message}`);
  }

  // ── 3c. Init Google Drive API service ──
  try {
    initGoogleDrive(app.getPath("userData"));
    console.log("[main] Google Drive API service initialized");
  } catch (err) {
    console.warn(`[main] Google Drive API init failed: ${err.message}`);
  }

  // ── 3d. Start idle-time Background Learner ─────────────────────────────
  // Waits 30 s after startup so the app is fully loaded, then begins
  // enriching concept pools from already-organized files during idle time.
  try {
    // Push learner status changes to the renderer so the indicator updates
    onLearnerStatusChange((status) => {
      mainWindow?.webContents.send("learner:status", status);
    });

    // Start after a short delay — don't compete with startup I/O
    setTimeout(() => {
      startBackgroundLearner(currentBaseDir).catch((err) => {
        console.warn("[main] Background learner error:", err.message);
      });
    }, 30_000);

    console.log("[main] Background learner scheduled (starts in 30 s)");
  } catch (err) {
    console.warn(`[main] Background learner init failed: ${err.message}`);
  }

  // ── 3. Auto-update (silent, never crashes the app) ──
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", () => {
      console.log("[updater] Update available — downloading...");
      mainWindow?.webContents.send("update-available");
    });
    autoUpdater.on("update-downloaded", () => {
      console.log("[updater] Update downloaded — ready to install");
      mainWindow?.webContents.send("update-downloaded");
    });
    autoUpdater.on("error", (err) => {
      console.warn(`[updater] Auto-update error: ${err.message}`);
    });

    autoUpdater.checkForUpdatesAndNotify();
  } catch (err) {
    console.warn(`[updater] Auto-update init failed: ${err.message}`);
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  // Release model memory
  try { require("./services/LlamaService").dispose(); } catch {}
  terminateOCRWorker().catch(() => {});
});

app.on("window-all-closed", () => {
  try { require("./services/LlamaService").dispose(); } catch {}
  if (process.platform !== "darwin") app.quit();
});

// ── IPC handlers (called from renderer via preload bridge) ──

// Notify the background learner whenever the user triggers an IPC call.
// This ensures the learner backs off during active usage without needing
// to explicitly wire up every handler.
const _origIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function(channel, listener) {
  return _origIpcHandle(channel, async (event, ...args) => {
    // Ignore status/learner channels to avoid feedback loops
    if (!channel.startsWith("learner:") && !channel.startsWith("watcher:")) {
      notifyUserActivity();
    }
    return listener(event, ...args);
  });
};

// Auto-update — quit and install downloaded update
ipcMain.handle("update:install", () => {
  autoUpdater.quitAndInstall();
});

// Destination path — renderer fetches this on startup
ipcMain.handle("app:get-dest-dir", () => currentBaseDir);

// ── Configurable Destination Path ───────────────────────────
const DEST_CONFIG_PATH = path.join(
  app.getPath("userData"),
  "dest_config.json"
);

function loadDestConfig() {
  try {
    if (fs.existsSync(DEST_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(DEST_CONFIG_PATH, "utf-8"));
    }
  } catch {}
  return { personalDir: null, workDir: null };
}

function saveDestConfig(cfg) {
  fs.writeFileSync(DEST_CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

// Apply saved custom destination on startup (if any)
(function applyCustomDest() {
  const cfg = loadDestConfig();
  if (cfg.personalDir && fs.existsSync(cfg.personalDir)) {
    // Override the default PERSONAL_DIR
    // Note: PERSONAL_DIR is const but currentBaseDir is let — we update currentBaseDir
    if (currentMode === "personal") {
      currentBaseDir = cfg.personalDir;
      console.log(`[main] Custom personal destination loaded: ${cfg.personalDir}`);
    }
  }
})();

/** Let the user pick a custom destination folder. */
ipcMain.handle("app:set-dest-dir", async (_event, mode) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    title: `Choose ${mode === "work" ? "Work" : "Personal"} Destination Folder`,
    defaultPath: currentBaseDir,
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };

  const newDir = result.filePaths[0];
  const cfg = loadDestConfig();

  if (mode === "work") {
    cfg.workDir = newDir;
  } else {
    cfg.personalDir = newDir;
  }
  saveDestConfig(cfg);

  // Apply immediately
  currentBaseDir = newDir;
  ensureDirStructure(newDir, mode);
  invalidateFingerprintCache();

  const folders = await scanUserFolders(newDir);
  console.log(`[main] Custom ${mode} destination set: ${newDir} — ${folders.length} folders`);
  return { ok: true, dir: newDir, folders };
});

/** Reset destination to default. */
ipcMain.handle("app:reset-dest-dir", async (_event, mode) => {
  const cfg = loadDestConfig();
  if (mode === "work") {
    cfg.workDir = null;
    currentBaseDir = WORK_DIR;
  } else {
    cfg.personalDir = null;
    currentBaseDir = PERSONAL_DIR;
  }
  saveDestConfig(cfg);
  ensureDirStructure(currentBaseDir, mode);
  invalidateFingerprintCache();
  const folders = await scanUserFolders(currentBaseDir);
  console.log(`[main] ${mode} destination reset to default: ${currentBaseDir}`);
  return { ok: true, dir: currentBaseDir, folders };
});

// File picker — ABSOLUTE FILE MODE, no openDirectory anywhere
ipcMain.handle("dialog:open-files", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    title: "Select Files to Classify",
    defaultPath: os.homedir(),
    filters: [{ name: "All Files", extensions: ["*"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return [];
  return result.filePaths;
});

ipcMain.handle("dialog:open-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Select a Folder to Classify",
    defaultPath: os.homedir(),
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("file:get-all-files", async (_event, folderPath, recursive = false) => {
  const results = [];
  const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store", "__pycache__"]);
  const MAX_FILES = 500;

  function walk(dir) {
    if (results.length >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= MAX_FILES) return;
      if (entry.name.startsWith(".")) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && recursive) { walk(full); }
      else if (entry.isFile()) { results.push(full); }
    }
  }
  walk(folderPath);
  return results;
});

// License
ipcMain.handle("license:validate", async (_event, key) => {
  return license.validateLicense(key);
});

ipcMain.handle("license:check", () => {
  return license.canOrganizeFiles();
});

ipcMain.handle("license:info", () => {
  return license.getLicenseInfo();
});

ipcMain.handle("license:clear", () => {
  license.clearLicense();
  return true;
});

// File operations
ipcMain.handle("file:move", async (_event, source, destination) => {
  // Gate behind license check
  if (!license.canOrganizeFiles()) {
    throw new Error("License required to organize files");
  }
  const finalPath = await safeMoveFile(source, destination);

  // ── Cloud Sync: fire-and-forget copy to enabled cloud connectors ──
  // Extract the category from the destination path (parent folder name)
  const category = path.basename(path.dirname(destination));
  if (category && category !== path.basename(currentBaseDir)) {
    syncFileToCloud(finalPath, category).catch((err) => {
      console.warn(`[main] Cloud sync failed for ${path.basename(finalPath)}: ${err.message}`);
    });
  }

  return finalPath;
});

// ── Classification (AI + Learning) ──────────────────────────

// targetDir = the user's destination root (e.g. ~/Organized).
// The AI discovers folders dynamically — no hardcoded categories needed.
ipcMain.handle("classify:file", async (_event, filePath, targetDir) => {
  return classifyFile(filePath, targetDir);
});

ipcMain.handle("classify:batch", async (_event, filePaths, targetDir) => {
  return classifyBatch(filePaths, targetDir);
});

// Expose folder discovery directly so the renderer can show
// the user's folder list in the UI (e.g. dropdown, sidebar).
ipcMain.handle("folders:scan", async (_event, targetDir) => {
  return scanUserFolders(targetDir);
});

// Create a new category subfolder inside DEST_DIR and return updated folder list
// Supports hierarchical paths like "Math/Precalculus" — creates nested folders with recursive:true
ipcMain.handle("create-category", async (_event, name) => {
  // Sanitize each segment of the path separately to preserve "/"
  const safe = name
    .split("/")
    .map((seg) => seg.replace(/[<>:"|?*\x00-\x1f]/g, "").trim())
    .filter(Boolean)
    .join("/");
  if (!safe) throw new Error("Invalid category name");

  // ═══ DEDUP: check for equivalent existing folder before creating ═══
  const existingFolders = await scanUserFolders(currentBaseDir);
  const equivalent = findExistingEquivalent(safe, existingFolders);
  if (equivalent && equivalent.toLowerCase() !== safe.toLowerCase()) {
    console.log(`[main] DEDUP: "${safe}" merged into existing "${equivalent}" — no new folder created`);
    return { created: equivalent, folders: existingFolders, merged: true };
  }

  // Also check just the child name against existing hierarchical folders
  if (safe.includes("/")) {
    const childName = safe.split("/").pop();
    const childMatch = existingFolders.find(
      (f) => f.includes("/") && f.split("/").pop().toLowerCase() === childName.toLowerCase()
    );
    if (childMatch && childMatch.toLowerCase() !== safe.toLowerCase()) {
      console.log(`[main] DEDUP: child "${childName}" already exists at "${childMatch}"`);
      return { created: childMatch, folders: existingFolders, merged: true };
    }
  }

  const catDir = path.join(currentBaseDir, safe);
  if (!fs.existsSync(catDir)) {
    fs.mkdirSync(catDir, { recursive: true });
    console.log(`[main] Created category folder: ${catDir}`);
  } else {
    console.log(`[main] Category folder already exists: ${catDir}`);
  }
  // Invalidate fingerprint cache so ClassificationService sees the new folder
  invalidateFingerprintCache();
  // Auto-seed: fire-and-forget Datamuse fetch using the child (most specific) name
  const seedName = safe.includes("/") ? safe.split("/").pop() : safe;
  setImmediate(async () => {
    try {
      const concepts = await fetchDatamuseConcepts(seedName);
      if (concepts.length > 0) {
        const pool = readGlobalPool(currentBaseDir);
        pool[safe] = [...new Set([...(pool[safe] || []), ...concepts])];
        writeGlobalPool(currentBaseDir, pool);
        console.log(`[main] Auto-seeded "${safe}" with ${concepts.length} Datamuse concepts`);
      }
    } catch (err) {
      console.warn(`[main] Auto-seed failed for "${safe}": ${err}`);
    }
  });
  // Return the full updated folder list so the renderer can refresh instantly
  const updatedFolders = await scanUserFolders(currentBaseDir);
  console.log(`[main] Category "${safe}" ready — ${updatedFolders.length} folders: ${updatedFolders.join(", ")}`);
  return { created: safe, folders: updatedFolders };
});

// ── Folder Fingerprinting ───────────────────────────────────

// Get full fingerprint data (keywords, sample counts, timestamps)
ipcMain.handle("context:fingerprints", async (_event, targetDir) => {
  return getFolderContext(targetDir);
});

// Get simplified context map for display: { "Folder": "kw1, kw2, ..." }
ipcMain.handle("context:prompt-map", async (_event, targetDir) => {
  return getFolderContextForPrompt(targetDir);
});

// Force fingerprint refresh (e.g. after user moves files)
ipcMain.handle("context:refresh", () => {
  invalidateFingerprintCache();
  return true;
});

// ── Topic Aliasing ──────────────────────────────────────────

// Get current aliases (for settings UI display)
ipcMain.handle("context:aliases", () => {
  return getCachedAliases();
});

// Save updated aliases (from settings UI)
ipcMain.handle("context:save-aliases", async (_event, targetDir, aliases) => {
  saveAliasMap(targetDir, aliases);
  return true;
});

// ── Noise Folder Detection ─────────────────────────────────

// Check if a folder is a "noise" folder (Archives, Old, Misc, etc.)
ipcMain.handle("context:is-noise-folder", (_event, folderName) => {
  return isNoiseFolderName(folderName);
});

// Get the list of noise folder names
ipcMain.handle("context:noise-folders", () => {
  return getNoiseFolders();
});

// ── Text Extraction / OCR ───────────────────────────────────

// Extract text from any file (for preview in UI)
ipcMain.handle("extract:text", async (_event, filePath) => {
  return extractText(filePath);
});

// Check if Tesseract OCR is installed (legacy)
ipcMain.handle("extract:ocr-status", () => {
  return checkOCRAvailable();
});

// Get full extraction capabilities
ipcMain.handle("extract:capabilities", () => {
  return checkExtractionCapabilities();
});

// ── Learning / Feedback ─────────────────────────────────────

/**
 * Called from the renderer when the user confirms moves.
 * For each file where AI guess ≠ user choice, this records
 * the correction so future prompts learn from it.
 *
 * corrections: Array<{ filename, extension, aiGuess, aiConfidence, userChoice, contentHint? }>
 * targetDir: the destination root directory (for pool enrichment)
 */
ipcMain.handle("learning:record-batch", (_event, corrections, targetDir) => {
  let recorded = 0;
  const newFolders = new Set();

  for (const c of corrections) {
    // contentHint is a short snippet (≤12 words) of the file's content —
    // passed from the renderer when available so future few-shot prompts
    // show the model WHY this file went to this folder.
    submitCorrection(c.filename, c.extension, c.aiGuess, c.aiConfidence, c.userChoice, targetDir, c.contentHint);
    if (c.aiGuess !== c.userChoice) recorded++;
    // Track folders that might be new
    if (c.userChoice) newFolders.add(c.userChoice);
  }

  // Part C: Auto-bootstrap any new folders (fire-and-forget — never blocks the response)
  if (targetDir && newFolders.size > 0) {
    const kg = loadKG(targetDir);
    for (const folder of newFolders) {
      if (!kg.folders[folder]) {
        bootstrapNewFolder(folder, targetDir).catch((err) =>
          console.warn(`[main] KG bootstrap failed for "${folder}": ${err.message}`)
        );
      }
    }
  }

  return { recorded };
});

ipcMain.handle("learning:stats", () => {
  return getLearningStats();
});

ipcMain.handle("learning:history", () => {
  return getAllCorrections();
});

ipcMain.handle("learning:clear", () => {
  clearMemory();
  return true;
});

// ── Dual Mode Switch ─────────────────────────────────────────

function ensureDirStructure(baseDir, mode) {
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
    console.log(`[main] Created ${mode} directory: ${baseDir}`);
  }
  // Always ensure "Needs Review" fallback folder exists
  const reviewDir = path.join(baseDir, "Needs Review");
  if (!fs.existsSync(reviewDir)) {
    fs.mkdirSync(reviewDir, { recursive: true });
  }
  if (mode === "work") {
    const secureDir = path.join(baseDir, "STRICTLY_SECURE");
    if (!fs.existsSync(secureDir)) {
      fs.mkdirSync(secureDir, { recursive: true });
    }
  }
}

// ── AI Engine status / retry ──────────────────────────────────

/**
 * Returns current AI engine status.
 */
ipcMain.handle("ollama:status", () => {
  const LlamaService = require("./services/LlamaService");
  return {
    running:       LlamaService.isReady(),
    rulesOnly:     false,
    selectedModel: "ai-organizer-v2",
    tier:          LlamaService.isReady() ? "custom" : "loading",
  };
});

/**
 * Retry loading the model (e.g. after a first-launch download completes).
 */
ipcMain.handle("ollama:retry", async () => {
  const LlamaService = require("./services/LlamaService");
  if (LlamaService.isReady()) return { success: true };
  const result = await LlamaService.initialize();
  if (result.success) {
    mainWindow?.webContents.send("model:ready");
  }
  return result;
});

// ── Model download (first launch) ────────────────────────────

/** Check if the GGUF model is already on disk. */
ipcMain.handle("model:is-downloaded", async () => {
  return isModelDownloaded();
});

/**
 * Trigger a model download manually (if auto-download on startup was skipped).
 * Streams progress via IPC events already defined in modelDownloader.js.
 */
ipcMain.handle("model:pull", async () => {
  try {
    const result = await ensureModel(mainWindow, null);
    if (result.success) {
      const LlamaService = require("./services/LlamaService");
      await LlamaService.initialize();
      mainWindow?.webContents.send("model:ready");
    }
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ── Workflow Engine Settings ──────────────────────────────────

/** Get the current state of the "auto-summarize new PDFs" toggle. */
ipcMain.handle("workflow:get-pdf-summary-enabled", () => {
  return appSettingsStore.get(PREF_PDF_SUMMARY_ENABLED, false);
});

/** Enable or disable the "auto-summarize new PDFs" workflow. */
ipcMain.handle("workflow:set-pdf-summary-enabled", (_event, enabled) => {
  appSettingsStore.set(PREF_PDF_SUMMARY_ENABLED, !!enabled);
  return !!enabled;
});

// ── First-run / System Requirements ──────────────────────────

/** Has the user seen the system requirements screen? */
ipcMain.handle("app:is-first-run", () => {
  return !appSettingsStore.get("systemCheckSeen", false);
});

/** Mark the system requirements screen as seen. */
ipcMain.handle("app:mark-first-run-seen", () => {
  appSettingsStore.set("systemCheckSeen", true);
  return true;
});

/** Has the user completed the new prompt-first onboarding flow? */
ipcMain.handle("app:has-completed-onboarding", () => {
  return appSettingsStore.get("hasCompletedFirstRun", false);
});

/** Mark the new onboarding flow as completed. */
ipcMain.handle("app:complete-onboarding", () => {
  appSettingsStore.set("hasCompletedFirstRun", true);
  return true;
});

/**
 * Run system requirements checks.
 * Returns { totalRamGB, freeRamGB, diskFreeGB, ollamaInstalled }.
 */
ipcMain.handle("app:system-check", async () => {
  const totalRamGB = +(os.totalmem() / (1024 ** 3)).toFixed(1);
  const freeRamGB  = +(os.freemem()  / (1024 ** 3)).toFixed(1);

  // Disk free space via df (macOS / Linux)
  let diskFreeGB = null;
  try {
    const dfResult = spawnSync("df", ["-k", os.homedir()], { encoding: "utf8", timeout: 5000 });
    if (dfResult.status === 0) {
      const lines = dfResult.stdout.trim().split("\n");
      // df -k output: Filesystem, 1K-blocks, Used, Available, Capacity, Mountpoint
      const parts = lines[1]?.split(/\s+/);
      if (parts && parts.length >= 4) {
        const availableKB = parseInt(parts[3], 10);
        if (!isNaN(availableKB)) diskFreeGB = +(availableKB / (1024 ** 2)).toFixed(1);
      }
    }
  } catch { /* ignore — not critical */ }

  // Is the AI model downloaded and loaded?
  const LlamaService = require("./services/LlamaService");
  const modelReady = LlamaService.isReady();
  const ollamaInstalled = modelReady; // keep key name for renderer compatibility

  return { totalRamGB, freeRamGB, diskFreeGB, ollamaInstalled, modelReady };
});

ipcMain.handle("app:switch-mode", async (_event, mode) => {
  currentMode = mode;
  currentBaseDir = mode === "work" ? WORK_DIR : PERSONAL_DIR;
  ensureDirStructure(currentBaseDir, mode);
  invalidateFingerprintCache();
  const folders = await scanUserFolders(currentBaseDir);
  console.log(`[main] Switched to ${mode} mode — baseDir: ${currentBaseDir}, ${folders.length} folders`);
  return { mode, baseDir: currentBaseDir, folders };
});

ipcMain.handle("app:get-mode", () => ({
  mode: currentMode,
  baseDir: currentBaseDir,
}));

// ── Smart Rules (Association Learning) ───────────────────────

ipcMain.handle("smart-rules:read", () => {
  const rulesPath = path.join(currentBaseDir, "smart_rules.json");
  try {
    if (fs.existsSync(rulesPath)) {
      return JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
    }
  } catch {}
  return {};
});

ipcMain.handle("smart-rules:write", (_event, rules) => {
  const rulesPath = path.join(currentBaseDir, "smart_rules.json");
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2), "utf-8");
  console.log(`[main] Smart rules updated: ${rulesPath}`);
  return true;
});

// ── Audit Log ────────────────────────────────────────────────

ipcMain.handle("audit:write", (_event, entry) => {
  const logPath = path.join(currentBaseDir, "audit_log.txt");
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${entry}\n`;
  fs.appendFileSync(logPath, line, "utf-8");
  return true;
});

ipcMain.handle("audit:read", () => {
  const logPath = path.join(currentBaseDir, "audit_log.txt");
  try {
    if (fs.existsSync(logPath)) {
      return fs.readFileSync(logPath, "utf-8");
    }
  } catch {}
  return "";
});

// ── PII Secure Move (Work Mode) ─────────────────────────────

ipcMain.handle("pii:secure-move", async (_event, source, filename) => {
  if (currentMode !== "work") return { moved: false, reason: "Not in Work mode" };
  const secureDir = path.join(currentBaseDir, "STRICTLY_SECURE");
  if (!fs.existsSync(secureDir)) {
    fs.mkdirSync(secureDir, { recursive: true });
  }
  const dest = path.join(secureDir, filename);
  try {
    await safeMoveFile(source, dest);
    console.log(`[main] PII file secured: ${filename} -> STRICTLY_SECURE/`);
    return { moved: true, dest };
  } catch (err) {
    return { moved: false, reason: String(err.message || err) };
  }
});

// ── Semantic Concept Learning (Datamuse API) ─────────────────
//
// PRIVACY: NO file content is ever uploaded.
// Only the Category Name is sent to the Datamuse "Related Meaning" API.
// All matching happens locally against knowledge_base.json.

// ── Global Concepts Pool helpers ──────────────────────────────

/**
 * Read the global concepts pool from global_concepts.json.
 * Returns { "Category": ["word1", "word2", ...], ... } or {}.
 */
function readGlobalPool(baseDir) {
  const poolPath = path.join(baseDir, "global_concepts.json");
  try {
    if (fs.existsSync(poolPath)) {
      return JSON.parse(fs.readFileSync(poolPath, "utf-8"));
    }
  } catch {}
  return {};
}

/**
 * Write the global concepts pool to global_concepts.json.
 */
function writeGlobalPool(baseDir, pool) {
  const poolPath = path.join(baseDir, "global_concepts.json");
  fs.writeFileSync(poolPath, JSON.stringify(pool, null, 2), "utf-8");
}

// ── Concept Pool Filtering (Anti-Pollution) ───────────────────
// Catches garbage concepts from Datamuse word-association drift.

/**
 * Generic terms that should NEVER appear in a subject-specific pool.
 * These are words Datamuse returns as "related" but carry zero signal.
 */
const POOL_STOP_WORDS = new Set([
  // Generic / structural
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "is", "are", "was", "were", "be", "been", "being",
  "it", "its", "this", "that", "these", "those", "not", "no", "yes",
  "part", "parts", "item", "items", "point", "points", "section", "sections",
  "page", "pages", "chapter", "chapters", "heading", "subheading", "title",
  "index", "category", "component", "figure", "topic", "aspect", "phase",
  "stage", "frame", "subdivision", "division", "dichotomy",
  // Books / publishing (word-association noise)
  "book", "booklet", "binder", "cahier", "scrapbook", "magazine", "notebook",
  "sketchbook", "pamphlet", "bookshop", "bookstore", "manuscript", "brochure",
  "cookbook", "journal", "diary", "guidebook", "edition", "publishing",
  "calligraphy", "written", "editing", "published", "publish", "writing",
  "daybook", "record", "script", "playscript", "ledger", "account book",
  "volume", "reserve", "hold", "leger", "book of account",
  // Sewing / textile (word-association noise from "stitch")
  "sew together", "sewing", "buttonhole", "mesh", "skin", "suture",
  "juncture", "overcasting", "darn", "mend", "baste", "weave", "loop",
  "fasten", "run up", "seam", "tack", "embroider", "knit", "crochet",
  "chainstitch", "overcast", "whipstitch", "lockstitch", "patch", "textile",
  // Body parts (word-association noise from "arm")
  "branch", "sleeve", "gird", "weapon", "fortify", "build up",
  "weapon system", "armpit", "forearm", "forelimb", "limb", "elbow",
  "hand", "tooth", "muscle", "bind",
  // Relationships (word-association noise from "chemistry")
  "interpersonal chemistry", "relationship", "interactions", "relationships",
  "interaction", "friendship", "camaraderie", "personality", "friendships",
  "charisma", "communication", "interrelationship", "charismatic",
  "congeniality", "communicative", "sociability", "sociality",
  "interpersonally", "intercommunication", "interpersonal skills",
  "human relationship", "physical attraction", "social intercourse",
  "personal magnetism", "magnetic attraction", "friendly relationship",
  "communicativeness", "companionability",
  // Screen / image (word-association noise)
  "pickup", "image", "picture", "display", "screen", "capture", "catch",
  "capturing", "screengrab", "snapshot", "screen motion capture",
  "loading screen", "screensaver", "screen-scraper", "workscreen",
  "touch screen", "lock screen", "split screen", "savefile", "desktop picture",
  // Music (word-association noise)
  "composition", "piece", "musical composition", "piece of music",
  "opposite", "opposition", "creation", "oeuvre", "masterpiece",
  "production", "rhapsody", "fantasia", "cantata",
  // Photography (word-association noise)
  "photo", "profile", "portrait", "footage", "photograph", "pictures",
  "form", "photos", "global image", "gram", "graphic", "gifset",
  "'gram", "gravatar", "gimp", "visual", "anigif", "geotag",
  "graymap", "gpmg",
  // Deep / abstract (word-association noise from biology "deep")
  "profound", "large", "distant", "recondite", "heavy", "intense",
  "abstruse", "cryptic", "sound", "cryptical", "low-pitched",
  "mystifying", "inscrutable", "late", "mysterious", "artful",
  "thick", "esoteric", "rich", "bottomless", "incomprehensible",
  "inexplicable", "unfathomed", "unsounded", "wakeless", "unplumbed",
  "colorful",
  // Release / discharge (word-association noise)
  "loose", "liberate", "liberation", "unloose", "expel", "discharge",
  "dismissal", "eject", "unblock", "departure", "exit", "relinquish",
  "give up", "expiration", "waiver", "secrete", "loss", "let go",
  "acquittance", "turn", "bring out", "passing", "issue", "going",
  "outlet", "spillage", "spill", "free", "handout",
  // Offers / proposals (word-association noise)
  "proffer", "offer up", "propose", "provide", "volunteer", "pass",
  "extend", "put up", "tender", "propose marriage", "pop the question",
  "fling", "whirl", "crack", "offeror", "proposition", "proposal",
  "bidding", "afford", "invitation",
  // Space / void (word-association noise)
  "blank", "place", "distance", "topological space", "outer space",
  "quad", "blank space", "outer", "term", "clearance", "empty",
  "upright", "vacuum", "void", "discretion", "placeholder", "espace",
  "opportunity", "seating", "flexibility", "seat", "scope",
  // Elections / candidates (word-association noise)
  "nominee", "campaigner", "prospect", "candidacy", "candidature",
  "election", "membership", "appointment", "appointee", "trainee",
  "nomination", "appellant", "proponent", "nominated", "applicant",
  "eligible", "accession", "bidder", "participant", "received",
  "interviewee", "applying", "investigator", "application",
  // Tests / trials (word-association noise)
  "try out", "examine", "trial", "experimental", "prove", "assay",
  "quiz", "tryout", "empirical", "model", "pilot", "check",
  "mental test", "mental testing", "psychometric test", "inspect", "detect",
  // Page-related (word-association noise)
  "pageboy", "varlet", "acton", "aspects", "beeps", "bellboys",
  "corporate", "headlines", "homepage", "impressions", "leafs", "leaves",
  "length", "listings", "parties", "pubs", "quarters", "screens",
  "seiten", "sheets", "shores", "sides", "site", "sites", "slides",
  // Conversion / change (word-association noise)
  "change over", "change", "exchange", "win over", "convince",
  "commute", "alter", "transform", "transformer", "conversion",
  "transforming", "changeover", "transpose", "convertible", "process",
  // Generic academic
  "academic", "academics", "acad", "acad.", "honor student", "preppy",
  "highschool", "high school", "upper school", "prep school",
  // Common noise words
  "management", "the", "general", "related", "department", "continued",
  "depending", "considered", "engaged", "activities", "applies",
]);

/**
 * Filter concepts: remove stop words, too-short terms, and cross-category duplicates.
 * @param {string} category - The category name
 * @param {string[]} concepts - Raw concepts to filter
 * @param {Object} fullPool - The entire pool (for cross-category dedup)
 * @returns {string[]} Filtered concepts
 */
function filterPoolConcepts(category, concepts, fullPool) {
  const catLower = category.toLowerCase();

  // Build cross-category frequency map
  const crossFreq = {};
  for (const [cat, catConcepts] of Object.entries(fullPool)) {
    if (cat.toLowerCase() === catLower) continue;
    for (const c of catConcepts) {
      const k = c.toLowerCase();
      crossFreq[k] = (crossFreq[k] || 0) + 1;
    }
  }

  return concepts.filter((concept) => {
    const lower = concept.toLowerCase().trim();

    // Remove empty or too-short
    if (lower.length < 3) return false;

    // Remove stop words
    if (POOL_STOP_WORDS.has(lower)) return false;

    // Remove single generic words that appear in 3+ OTHER categories
    if ((crossFreq[lower] || 0) >= 3 && !lower.includes(" ")) return false;

    // Remove concepts that are just numbers
    if (/^\d+$/.test(lower)) return false;

    return true;
  });
}

/**
 * Use Ollama to validate concepts for a category.
 * Sends concepts in a batch and asks the LLM which ones are actually relevant.
 * Falls back to basic filtering if Ollama is unavailable.
 */
async function filterConceptsWithAI(category, concepts) {
  // Only filter if we have a reasonable number of concepts
  if (concepts.length === 0) return concepts;

  // Batch into chunks of 80 to avoid prompt size issues
  const BATCH_SIZE = 80;
  const validated = [];

  for (let i = 0; i < concepts.length; i += BATCH_SIZE) {
    const batch = concepts.slice(i, i + BATCH_SIZE);
    const numbered = batch.map((c, idx) => `${idx + 1}. ${c}`).join("\n");

    const prompt = `You are a strict academic concept validator. Given the subject "${category}", determine which of these terms are DIRECTLY relevant to studying or working with "${category}".

TERMS:
${numbered}

RULES:
- KEEP terms that are specific to "${category}" (subtopics, key concepts, techniques, vocabulary)
- REMOVE terms that are generic (e.g., "management", "study", "school", "book")
- REMOVE terms that belong to unrelated fields
- REMOVE terms that are nonsensical or word-association noise
- REMOVE terms in foreign languages unless they are standard terminology for "${category}"
- REMOVE terms related to body parts, sewing, photography, music, relationships unless directly relevant

Respond with ONLY a JSON array of the KEPT term numbers. Example: [1, 3, 5, 8]
If none are relevant, respond: []`;

    try {
      const LlamaService = require("./services/LlamaService");
      const result = LlamaService.isReady()
        ? await LlamaService.generate(prompt, { maxTokens: 500, temperature: 0.1, timeoutMs: 30_000 })
        : "";

      // Parse the response — extract the JSON array of indices
      const match = String(result).match(/\[[\d,\s]*\]/);
      if (match) {
        const indices = JSON.parse(match[0]);
        for (const idx of indices) {
          if (typeof idx === "number" && idx >= 1 && idx <= batch.length) {
            validated.push(batch[idx - 1]);
          }
        }
      } else {
        // AI response wasn't parseable — keep the batch (filtered by basic rules)
        validated.push(...batch);
      }
    } catch {
      // Model unavailable — keep the batch
      validated.push(...batch);
    }
  }

  console.log(`[main] AI Filter: "${category}" — ${concepts.length} → ${validated.length} concepts (${concepts.length - validated.length} removed)`);
  return validated;
}

// ── Stopwords for Wikipedia keyword extraction ────────────────
const WIKI_STOP_WORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with","by",
  "from","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","shall","may","might",
  "can","this","that","these","those","it","its","i","me","my","we","our",
  "you","your","he","him","his","she","her","they","them","their","not",
  "no","so","if","then","than","when","where","how","what","which","who",
  "all","each","every","both","few","more","most","some","any","many",
  "much","such","very","just","also","into","over","after","before",
  "about","as","up","out","one","two","new","used","first","other",
  "known","often","well","part","may","use","between","since","while",
]);

/**
 * Fetch Wikipedia summary for a category and extract keywords.
 * Uses the Wikipedia REST API (page/summary endpoint).
 * PRIVACY: Only the category name is sent.
 */
function fetchWikipediaConcepts(category) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(category.replace(/\s+/g, "_"));
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`;

    https.get(url, { headers: { "User-Agent": "AIOrganizer/1.0" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const extract = parsed.extract || "";
          // Split extract into words, filter stopwords, keep words >= 3 chars
          const words = extract
            .toLowerCase()
            .replace(/[^a-z\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length >= 3 && !WIKI_STOP_WORDS.has(w));
          // Deduplicate
          const unique = [...new Set(words)];
          console.log(
            `[main] Wikipedia returned ${unique.length} keywords for "${category}": ` +
            `[${unique.slice(0, 10).join(", ")}${unique.length > 10 ? "..." : ""}]`
          );
          resolve(unique);
        } catch {
          resolve([]);
        }
      });
      res.on("error", () => resolve([]));
    }).on("error", () => resolve([]));
  });
}

/**
 * Concept Expansion: expand short/abbreviated category names to full-form.
 * Uses Datamuse "sp" (spelled like) + "ml" (means like) to find
 * longer-form candidates for short inputs (e.g. "Bio" → "Biology").
 *
 * PRIVACY: Only the category name is sent to Datamuse.
 * Safeguard: If API fails, returns the original name unchanged.
 */
function expandCategoryName(shortName) {
  return new Promise((resolve) => {
    // If the name is already long (>= 6 chars), skip expansion
    if (shortName.length >= 6) {
      resolve(shortName);
      return;
    }

    const encoded = encodeURIComponent(shortName);
    const url = `https://api.datamuse.com/words?sp=${encoded}*&ml=${encoded}&max=10`;

    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (!Array.isArray(parsed) || parsed.length === 0) {
            resolve(shortName);
            return;
          }
          // Pick the highest-score candidate that starts with the short name (case-insensitive)
          const prefix = shortName.toLowerCase();
          const candidates = parsed
            .filter((e) => e.word && e.word.toLowerCase().startsWith(prefix) && e.word.length > shortName.length)
            .sort((a, b) => (b.score || 0) - (a.score || 0));

          if (candidates.length > 0) {
            // Capitalize first letter
            const expanded = candidates[0].word.charAt(0).toUpperCase() + candidates[0].word.slice(1);
            console.log(`[main] Concept Expansion: "${shortName}" → "${expanded}"`);
            resolve(expanded);
          } else {
            resolve(shortName);
          }
        } catch {
          resolve(shortName);
        }
      });
      res.on("error", () => resolve(shortName));
    }).on("error", () => resolve(shortName));
  });
}

/**
 * Academic Acronym Expansion: expand academic abbreviations via Wikipedia.
 * "APUSH" → Wikipedia search → "AP United States History"
 * Uses Wikipedia's REST API which handles redirects automatically.
 *
 * PRIVACY: Only the category name is sent to Wikipedia.
 * Safeguard: If API fails, falls back to expandCategoryName() (Datamuse).
 */
function expandAcademicName(name) {
  return new Promise((resolve) => {
    // If the name is already long (>= 12 chars), skip academic expansion
    if (name.length >= 12) {
      resolve(name);
      return;
    }

    const encoded = encodeURIComponent(name.replace(/\s+/g, "_"));
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`;

    https.get(url, { headers: { "User-Agent": "AIOrganizer/1.0" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          // Wikipedia returns the canonical title, which resolves redirects
          // e.g., "APUSH" redirects to "AP United States History"
          const title = parsed.title || "";
          if (
            title &&
            title.toLowerCase() !== name.toLowerCase() &&
            title.length > name.length
          ) {
            console.log(`[main] Academic Expansion: "${name}" → "${title}" (via Wikipedia)`);
            resolve(title);
            return;
          }
          // No useful expansion from Wikipedia — fall through
          resolve(null);
        } catch {
          resolve(null);
        }
      });
      res.on("error", () => resolve(null));
    }).on("error", () => resolve(null));
  });
}

/**
 * Deep Recursive Search: Force-expand a category until the pool has >100 keywords.
 *
 * PIPELINE:
 *   Pass 1 — Fetch top 30 related concepts for the category (the "trunk").
 *   Pass 2 (The Expander) — Take the top 5 results from Pass 1 and run
 *     each as a NEW query, biased by the original category topic.
 *     This is Level 2 expansion.
 *
 * CONTEXT FILTER: Pass 2 queries use Datamuse's `topics` parameter set to
 *   the original category, so results stay within the relevant domain
 *   (e.g., "Marketing" biased by "FBLA" returns business marketing, not medical).
 *
 * TARGET: Do not stop until the pool has >100 unique keywords (or Level 2 exhausted).
 * SAFEGUARD: Depth limit = Level 2. Max 5 expansion branches. Max 30 per query.
 * PRIVACY: Only the category name and derived sub-terms are sent to Datamuse API.
 *          NO file content is ever uploaded.
 *
 * @param {string} category — The category name (already expanded if applicable).
 * @param {function} onProgress — Callback(currentCount, target) for live progress.
 * @returns {Promise<string[]>} — Flat deduplicated array of concepts.
 */
async function fetchDeepRecursiveSearch(category, onProgress) {
  const TARGET = 100;
  const allConcepts = new Set();

  // Helper: fetch from Datamuse with optional topic bias for context filtering
  function fetchBiased(term, max, topic) {
    return new Promise((resolve) => {
      let url = `https://api.datamuse.com/words?ml=${encodeURIComponent(term)}&max=${max}`;
      if (topic) url += `&topics=${encodeURIComponent(topic)}`;
      https.get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(Array.isArray(parsed) ? parsed.map((e) => e.word).filter(Boolean) : []);
          } catch { resolve([]); }
        });
        res.on("error", () => resolve([]));
      }).on("error", () => resolve([]));
    });
  }

  // ── Pass 1: Fetch 30 broad concepts (the trunk) ──
  const pass1 = await fetchBiased(category, 30, null);
  for (const w of pass1) allConcepts.add(w.toLowerCase());
  console.log(`[main] Deep Recursive Pass 1 for "${category}": ${pass1.length} concepts`);
  if (onProgress) onProgress(allConcepts.size, TARGET);

  if (allConcepts.size >= TARGET) return [...allConcepts];

  // ── Pass 2 (The Expander): Top 5 from Pass 1 → new queries ──
  // Each sub-query is biased by the original category for context filtering.
  // DEPTH LIMIT: Level 2. We do NOT recurse further.
  const expandTerms = pass1
    .filter((w) => w.toLowerCase() !== category.toLowerCase() && w.length >= 4)
    .slice(0, 5);

  console.log(`[main] Deep Recursive Pass 2 — expanding: [${expandTerms.join(", ")}]`);

  for (const term of expandTerms) {
    const pass2 = await fetchBiased(term, 30, category);
    for (const w of pass2) allConcepts.add(w.toLowerCase());
    if (onProgress) onProgress(allConcepts.size, TARGET);
    console.log(`[main]   "${term}" → +${pass2.length} concepts (total: ${allConcepts.size})`);
    if (allConcepts.size >= TARGET) break;
  }

  // DEPTH LIMIT REACHED (Level 2). Stop recursive expansion.
  if (onProgress) onProgress(allConcepts.size, TARGET);
  console.log(
    `[main] Deep Recursive Search complete for "${category}": ${allConcepts.size} concepts ` +
    `(target: ${TARGET}, ${allConcepts.size >= TARGET ? "REACHED" : "best effort"})`
  );

  return [...allConcepts];
}

/**
 * Semantic Web Download: fetch 3 layers of keywords for a category.
 *   Layer 1 — Synonyms (rel_syn): "Biology" → "life science", "bioscience"
 *   Layer 2 — Components/Triggers (rel_trg): "Biology" → "cell", "dna", "tissue"
 *   Layer 3 — Associated Adjectives (rel_jja): "Biology" → "molecular", "marine"
 *
 * All 3 queries run in parallel. Returns a flat deduplicated array.
 * PRIVACY: Only the expanded category name is sent.
 */
function fetchSemanticWeb(expandedName) {
  function fetchDatamuseRel(rel, term) {
    return new Promise((resolve) => {
      const encoded = encodeURIComponent(term);
      const url = `https://api.datamuse.com/words?${rel}=${encoded}&max=30`;
      https.get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            const words = Array.isArray(parsed)
              ? parsed.map((e) => e.word).filter(Boolean)
              : [];
            resolve(words);
          } catch { resolve([]); }
        });
        res.on("error", () => resolve([]));
      }).on("error", () => resolve([]));
    });
  }

  return Promise.all([
    fetchDatamuseRel("rel_syn", expandedName),  // Synonyms
    fetchDatamuseRel("rel_trg", expandedName),  // Components / triggers
    fetchDatamuseRel("rel_jja", expandedName),  // Associated adjectives
  ]).then(([synonyms, components, adjectives]) => {
    const all = [...new Set([...synonyms, ...components, ...adjectives])];
    console.log(
      `[main] Semantic Web for "${expandedName}": synonyms=${synonyms.length}, ` +
      `components=${components.length}, adjectives=${adjectives.length}, combined=${all.length}`
    );
    return all;
  });
}

/**
 * Fetch semantically related words from Datamuse for a given category name.
 * Uses the "ml" (means like) parameter for related-meaning lookup.
 * Returns an array of word strings (max 50).
 */
function fetchDatamuseConcepts(category) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(category);
    const url = `https://api.datamuse.com/words?ml=${encoded}&max=50`;

    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          // Datamuse returns [{ word: "...", score: N }, ...]
          const words = Array.isArray(parsed)
            ? parsed.map((entry) => entry.word).filter(Boolean)
            : [];
          console.log(
            `[main] Datamuse returned ${words.length} concepts for "${category}": ` +
            `[${words.slice(0, 10).join(", ")}${words.length > 10 ? "..." : ""}]`
          );
          resolve(words);
        } catch (err) {
          reject(err);
        }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * Learn semantic concepts for a category and save to knowledge_base.json.
 * The knowledge base is stored inside the current baseDir so
 * Personal rules stay on Desktop and Work rules stay in iCloud.
 */
ipcMain.handle("knowledge:learn-category", async (_event, category) => {
  try {
    // Check pool first — if already has >= 100 concepts, skip API calls (target met)
    const pool = readGlobalPool(currentBaseDir);
    if (pool[category] && pool[category].length >= 100) {
      console.log(`[main] Pool already knows "${category}" (${pool[category].length} concepts, >=100) — skipping re-research`);
      return { category, concepts: pool[category], saved: true, alreadyKnown: true, expandedName: null };
    }

    // ── Step 1a: Academic Expansion (acronyms → full form via Wikipedia) ──
    // "APUSH" → "AP United States History", "FBLA" → "Future Business Leaders of America"
    let expandedName = await expandAcademicName(category);

    // ── Step 1b: Concept Expansion fallback (short names → full form via Datamuse) ──
    // "Bio" → "Biology", "Gov" → "Government", etc.
    if (!expandedName) {
      expandedName = await expandCategoryName(category);
    }
    const wasExpanded = expandedName !== category;
    if (wasExpanded) {
      console.log(`[main] Expansion: "${category}" → "${expandedName}"`);
    }

    // ── Step 2: Deep Recursive Search (Pass 1: 30, Pass 2: top 5 × 30, target >100) ──
    // PRIVACY: Only the category name and derived sub-terms are sent to Datamuse.
    // DEPTH LIMIT: Level 2. No infinite recursion.
    const treeConcepts = await fetchDeepRecursiveSearch(expandedName, (current, target) => {
      // Emit progress to renderer for live visual feedback
      mainWindow?.webContents.send("deep-dive-progress", current, target);
    });

    // ── Step 3: Semantic Web Download (3 layers in parallel) ──
    // Synonyms + Components/Triggers + Associated Adjectives
    const semanticWebConcepts = await fetchSemanticWeb(expandedName);

    // ── Step 4: Deep Dive (Datamuse ml + Wikipedia) using expanded name ──
    const [datamuseConcepts, wikiConcepts] = await Promise.all([
      fetchDatamuseConcepts(expandedName),
      fetchWikipediaConcepts(expandedName),
    ]);

    // Merge ALL sources (deduplicate) — save under ORIGINAL short name
    const rawCombined = [...new Set([...treeConcepts, ...semanticWebConcepts, ...datamuseConcepts, ...wikiConcepts])];
    console.log(
      `[main] Deep Dive: Tree=${treeConcepts.length}, SemanticWeb=${semanticWebConcepts.length}, ` +
      `Datamuse=${datamuseConcepts.length}, Wikipedia=${wikiConcepts.length}, raw=${rawCombined.length}`
    );

    if (!rawCombined.length) {
      console.log(`[main] No concepts returned for "${category}" (expanded: "${expandedName}")`);
      return { category, concepts: [], saved: false, expandedName: wasExpanded ? expandedName : null };
    }

    // ── QUALITY FILTER: remove stop words + cross-category noise ──
    const basicFiltered = filterPoolConcepts(category, rawCombined, pool);
    console.log(`[main] Basic filter: ${rawCombined.length} → ${basicFiltered.length} concepts`);

    // ── AI FILTER: use Ollama to validate relevance ──
    const combined = await filterConceptsWithAI(category, basicFiltered);
    console.log(`[main] AI filter: ${basicFiltered.length} → ${combined.length} concepts`);

    // Save under the ORIGINAL category name (user's short name)
    const existingPool = pool[category] || [];
    const mergedPool = [...new Set([...existingPool, ...combined])];
    pool[category] = mergedPool;
    writeGlobalPool(currentBaseDir, pool);
    console.log(
      `[main] global_concepts.json updated: "${category}" now has ${mergedPool.length} concepts`
    );

    // Also write to knowledge_base.json for backward compatibility
    const kbPath = path.join(currentBaseDir, "knowledge_base.json");
    let kb = {};
    try {
      if (fs.existsSync(kbPath)) {
        kb = JSON.parse(fs.readFileSync(kbPath, "utf-8"));
      }
    } catch {}
    const existingKb = kb[category] || [];
    kb[category] = [...new Set([...existingKb, ...combined])];
    fs.writeFileSync(kbPath, JSON.stringify(kb, null, 2), "utf-8");

    return {
      category,
      concepts: mergedPool,
      saved: true,
      alreadyKnown: false,
      expandedName: wasExpanded ? expandedName : null,
    };
  } catch (err) {
    console.warn(`[main] Deep Dive failed for "${category}": ${err}`);
    return { category, concepts: [], saved: false, error: String(err), expandedName: null };
  }
});

ipcMain.handle("knowledge:read", () => {
  const kbPath = path.join(currentBaseDir, "knowledge_base.json");
  try {
    if (fs.existsSync(kbPath)) {
      return JSON.parse(fs.readFileSync(kbPath, "utf-8"));
    }
  } catch {}
  return {};
});

// Read the global concepts pool (for Boss Dashboard)
ipcMain.handle("knowledge:read-pool", () => {
  return readGlobalPool(currentBaseDir);
});

// Reinforce: add keywords to a category in the pool (for "Needs Review" learning)
// Uses universal-pool-manager validation to prevent pollution.
ipcMain.handle("knowledge:reinforce", (_event, category, keywords) => {
  try {
    const { addTermsToPool } = getPoolManager();
    const added = addTermsToPool(keywords, category, currentBaseDir);
    const pool = readGlobalPool(currentBaseDir);
    const totalConcepts = (pool[category] || []).length;
    console.log(`[main] Reinforced "${category}" with ${added} validated keywords (${keywords.length} submitted) — pool now has ${totalConcepts} concepts`);
    return { category, totalConcepts, added };
  } catch (err) {
    // Fallback: raw write if pool manager fails
    console.warn(`[main] Pool manager unavailable, falling back to raw write: ${err}`);
    const pool = readGlobalPool(currentBaseDir);
    const existing = pool[category] || [];
    const merged = [...new Set([...existing, ...keywords])];
    pool[category] = merged;
    writeGlobalPool(currentBaseDir, pool);
    console.log(`[main] Reinforced "${category}" with ${keywords.length} keywords — pool now has ${merged.length} concepts`);
    return { category, totalConcepts: merged.length };
  }
});

// Export the full pool as JSON string (for download)
ipcMain.handle("knowledge:export-pool", () => {
  const pool = readGlobalPool(currentBaseDir);
  return JSON.stringify(pool, null, 2);
});

/**
 * Clean the entire concept pool: remove garbage, run AI validation.
 * Returns stats about what was removed.
 */
ipcMain.handle("knowledge:clean-pool", async (_event) => {
  const pool = readGlobalPool(currentBaseDir);
  const categories = Object.keys(pool);
  if (categories.length === 0) return { cleaned: 0, removed: 0 };

  const stats = { cleaned: 0, totalRemoved: 0, details: {} };

  // First pass: basic filtering (stop words + cross-category dedup)
  for (const cat of categories) {
    const before = pool[cat].length;
    pool[cat] = filterPoolConcepts(cat, pool[cat], pool);
    const afterBasic = pool[cat].length;
    stats.details[cat] = { before, afterBasic };
  }

  // Second pass: AI validation (category by category)
  for (const cat of categories) {
    const beforeAI = pool[cat].length;
    try {
      pool[cat] = await filterConceptsWithAI(cat, pool[cat]);
    } catch (err) {
      console.warn(`[main] AI filter failed for "${cat}": ${err}`);
    }
    const afterAI = pool[cat].length;
    stats.details[cat].afterAI = afterAI;
    stats.details[cat].removed = stats.details[cat].before - afterAI;
    stats.totalRemoved += stats.details[cat].removed;
    stats.cleaned++;

    console.log(
      `[main] Clean pool: "${cat}" — ${stats.details[cat].before} → ${afterAI} concepts (removed ${stats.details[cat].removed})`
    );

    // Emit progress
    mainWindow?.webContents.send("pool-clean-progress", stats.cleaned, categories.length, cat);
  }

  // Also deduplicate category names (merge "PreCalc" + "Precalculus")
  const { findExistingEquivalent } = require("./services/ClassificationService");
  const processedCats = [];
  for (const cat of categories) {
    const equiv = findExistingEquivalent(cat, processedCats);
    if (equiv) {
      // Merge into existing
      const merged = [...new Set([...pool[equiv], ...pool[cat]])];
      pool[equiv] = merged;
      delete pool[cat];
      console.log(`[main] Clean pool: merged duplicate "${cat}" into "${equiv}" (${merged.length} concepts)`);
    } else {
      processedCats.push(cat);
    }
  }

  writeGlobalPool(currentBaseDir, pool);

  // Also update knowledge_base.json
  const kbPath = path.join(currentBaseDir, "knowledge_base.json");
  try {
    fs.writeFileSync(kbPath, JSON.stringify(pool, null, 2), "utf-8");
  } catch {}

  console.log(`[main] Pool cleanup complete: ${stats.cleaned} categories, ${stats.totalRemoved} concepts removed`);
  return stats;
});

// ── Universal Pool Manager — Pool Health & Sanitization ────────────────────

// Lazily import pool manager (TypeScript, needs tsx).
function getPoolManager() {
  return require("./intelligence/universal-pool-manager");
}

function getAccuracyMonitor() {
  return require("./validation/accuracy-monitor");
}

/**
 * Get pool health metrics for all folders.
 * Used by the Pool Health Dashboard in the UI.
 */
ipcMain.handle("pool:health", () => {
  try {
    const { getPoolHealthReport } = getPoolManager();
    return getPoolHealthReport(currentBaseDir);
  } catch (err) {
    console.error("[main] pool:health error:", err);
    return [];
  }
});

/**
 * Sanitize concept pools — remove generic + cross-contaminated terms.
 * Statistical only (no AI). Safe to run multiple times.
 * Returns SanitizationStats.
 */
ipcMain.handle("pool:sanitize", () => {
  try {
    const { sanitizePoolFiles } = getPoolManager();
    const stats = sanitizePoolFiles(currentBaseDir);
    console.log(
      `[main] pool:sanitize complete — ${stats.genericRemoved + stats.crossContaminationRemoved} terms removed`
    );
    return stats;
  } catch (err) {
    console.error("[main] pool:sanitize error:", err);
    return { error: String(err) };
  }
});

/**
 * Run bulk pool enrichment from all past corrections.
 * Useful on first run to bootstrap concept pools from existing learning history.
 * Returns { termsAdded: number }.
 */
ipcMain.handle("pool:enrich-from-history", () => {
  try {
    const added = bulkEnrichFromHistory(currentBaseDir);
    return { termsAdded: added };
  } catch (err) {
    console.error("[main] pool:enrich-from-history error:", err);
    return { termsAdded: 0, error: String(err) };
  }
});

/**
 * Run forced pool maintenance (bypasses 7-day schedule).
 * Used by the maintenance UI button in settings.
 */
ipcMain.handle("pool:maintenance", () => {
  try {
    const report = runForcedMaintenance(currentBaseDir);
    return report;
  } catch (err) {
    console.error("[main] pool:maintenance error:", err);
    return { error: String(err), skipped: true };
  }
});

/**
 * Check whether scheduled maintenance is due.
 */
ipcMain.handle("pool:maintenance-due", () => {
  try {
    return { due: isMaintenanceDue() };
  } catch (err) {
    return { due: false };
  }
});

// ── Knowledge Graph IPC ────────────────────────────────────────────────────

/**
 * Rebuild the knowledge graph for all folders.
 * Streams progress events to the renderer while running.
 * Returns { folderCount, termsAdded } when complete.
 */
ipcMain.handle("knowledge-graph:rebuild", async (_event) => {
  let folderCount = 0;
  let termsAdded  = 0;

  try {
    const kg = await rebuildAllFolders(currentBaseDir, (progress) => {
      if (!mainWindow?.isDestroyed()) {
        mainWindow.webContents.send("knowledge-graph:progress", progress);
      }
      if (progress.status === "done") {
        folderCount++;
        termsAdded += progress.termCount ?? 0;
      }
    });

    console.log(`[main] knowledge-graph:rebuild complete — ${folderCount} folders, ${termsAdded} terms`);
    return { folderCount, termsAdded, folders: Object.keys(kg.folders) };
  } catch (err) {
    console.error("[main] knowledge-graph:rebuild error:", err);
    return { error: String(err), folderCount, termsAdded };
  }
});

/**
 * Return the current knowledge graph (or null if not yet built).
 */
ipcMain.handle("knowledge-graph:get", () => {
  try {
    const kg = loadKG(currentBaseDir);
    return Object.keys(kg.folders).length > 0 ? kg : null;
  } catch {
    return null;
  }
});

/**
 * Get accuracy stats — tier breakdown, confusion pairs.
 * Used by the accuracy dashboard in the UI.
 */
ipcMain.handle("accuracy:stats", () => {
  try {
    const { getAccuracyStats } = getAccuracyMonitor();
    return getAccuracyStats();
  } catch (err) {
    console.error("[main] accuracy:stats error:", err);
    return null;
  }
});

/**
 * Get pending disambiguation pairs (confusion pairs that need rules).
 */
ipcMain.handle("accuracy:pending-disambig", () => {
  try {
    const { getPendingDisambiguationPairs } = getAccuracyMonitor();
    return getPendingDisambiguationPairs();
  } catch (err) {
    console.error("[main] accuracy:pending-disambig error:", err);
    return [];
  }
});

/**
 * Generate a disambiguation rule for a confused folder pair.
 * Called by the UI after user confirms they want auto-disambiguation.
 */
ipcMain.handle("accuracy:generate-disambig", (_event, folderA, folderB) => {
  try {
    const { generateDisambiguationRule } = getAccuracyMonitor();
    const { readMergedPool } = getPoolManager();
    const pools = readMergedPool(currentBaseDir);
    const poolA = pools[folderA] || [];
    const poolB = pools[folderB] || [];
    const rule = generateDisambiguationRule(folderA, folderB, poolA, poolB);
    return rule;
  } catch (err) {
    console.error("[main] accuracy:generate-disambig error:", err);
    return null;
  }
});

/**
 * Reset accuracy tracking data.
 * Called when the user clears their learning history.
 */
ipcMain.handle("accuracy:reset", () => {
  try {
    const { resetAccuracyData } = getAccuracyMonitor();
    resetAccuracyData();
    return { success: true };
  } catch (err) {
    console.error("[main] accuracy:reset error:", err);
    return { success: false, error: String(err) };
  }
});

/**
 * Manually disable a disambiguation rule.
 * Exposed for user-triggered rule management in the UI.
 */
ipcMain.handle("accuracy:disable-rule", (_event, folderA, folderB) => {
  try {
    const { disableDisambiguationRule } = getAccuracyMonitor();
    const disabled = disableDisambiguationRule(folderA, folderB);
    return { success: disabled };
  } catch (err) {
    console.error("[main] accuracy:disable-rule error:", err);
    return { success: false, error: String(err) };
  }
});

// ── Step 4: Disambiguation Choice Handler ──────────────────────────────────
//
// Called by the renderer when the user picks a folder from the disambiguation
// prompt. Moves the file to the chosen folder, saves a JSONL learning example
// to the "Learning Data" folder, and records the correction in memory.
//
// Payload: { filePath, filename, chosenCategory, otherCategory, catAKeywords, catBKeywords, aiConfidence }

ipcMain.handle("watcher:disambiguation-choice", async (_event, payload) => {
  try {
    const {
      filePath,
      filename,
      chosenCategory,
      otherCategory,
      catAKeywords = [],
      catBKeywords = [],
      aiConfidence = 0,
    } = payload;

    if (!filePath || !chosenCategory) return { success: false, error: "Missing filePath or chosenCategory" };

    // ── Move the file ───────────────────────────────────────────────────
    const dest = path.join(currentBaseDir, chosenCategory, filename);
    await safeMoveFile(filePath, dest);

    // ── Index for chat search ───────────────────────────────────────────
    try {
      const text = await extractText(filePath);
      indexFile(dest, chosenCategory, text || "");
    } catch { /* non-fatal */ }

    // ── Record correction in learning memory ────────────────────────────
    const ext = path.extname(filename).toLowerCase();
    submitCorrection(
      filename,
      ext,
      otherCategory || chosenCategory,  // what AI guessed (the ambiguous candidate)
      aiConfidence,
      chosenCategory,                   // what user confirmed
      currentBaseDir,
      catAKeywords.slice(0, 6).join(", ") || filename
    );

    // ── Step 4: Save to Learning Data folder ────────────────────────────
    // Write a JSONL training example that future fine-tunes can consume.
    try {
      const learningDir = path.join(currentBaseDir, "Learning Data");
      if (!fs.existsSync(learningDir)) fs.mkdirSync(learningDir, { recursive: true });

      const example = {
        timestamp: new Date().toISOString(),
        filename,
        chosen_category: chosenCategory,
        rejected_category: otherCategory || "",
        chosen_keywords: catAKeywords,
        rejected_keywords: catBKeywords,
        ai_confidence: aiConfidence,
        source: "user_disambiguation",
        training_pair: {
          messages: [
            {
              role: "system",
              content: "You are a file organizer. Classify the file into the correct folder."
            },
            {
              role: "user",
              content: `File: "${filename}"\nKeywords found: ${catAKeywords.concat(catBKeywords).join(", ")}`
            },
            {
              role: "assistant",
              content: chosenCategory
            }
          ]
        }
      };

      const learningFile = path.join(learningDir, "disambiguation_examples.jsonl");
      fs.appendFileSync(learningFile, JSON.stringify(example) + "\n", "utf-8");
    } catch (writeErr) {
      console.warn("[main] Could not write Learning Data:", writeErr.message);
    }

    // ── Notify renderer that the file has been moved ─────────────────────
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send("watcher:file-organized", {
        filename,
        sourcePath: filePath,
        destPath: dest,
        category: chosenCategory,
        confidence: 100,   // user confirmed = 100% certainty
        disambiguated: true,
      });
    }

    return { success: true, destPath: dest };
  } catch (err) {
    console.error("[main] watcher:disambiguation-choice error:", err);
    return { success: false, error: String(err) };
  } finally {
    // Always unblock the queue — even on error, the next pending file can proceed
    disambiguationActive = false;
    drainDisambiguationQueue();
  }
});

/**
 * Skip — user dismissed the disambiguation card without choosing.
 * Releases the queue lock so the next pending file can proceed.
 */
ipcMain.handle("watcher:disambiguation-skip", () => {
  disambiguationActive = false;
  drainDisambiguationQueue();
  return { ok: true };
});

// ── Background Learner IPC ──────────────────────────────────────────────────

/** Get current learner status (running, paused, stats). */
ipcMain.handle("learner:status", () => {
  try { return getLearnerStatus(); } catch { return null; }
});

/** Pause the background learner. */
ipcMain.handle("learner:pause", () => {
  try { pauseLearner(); return { ok: true }; } catch { return { ok: false }; }
});

/** Resume the background learner after a manual pause. */
ipcMain.handle("learner:resume", () => {
  try { resumeLearner(); return { ok: true }; } catch { return { ok: false }; }
});

/**
 * Reset the processed-files ledger — the learner will re-scan
 * all files from scratch on the next idle cycle.
 * Useful after importing a large batch of pre-organized files.
 */
ipcMain.handle("learner:reset", () => {
  try {
    resetLearnerLedger(currentBaseDir);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/**
 * Get all disambiguation rules (including disabled ones) for the settings UI.
 */
ipcMain.handle("accuracy:rules", () => {
  try {
    const { getDisambiguationRules } = getAccuracyMonitor();
    return getDisambiguationRules();
  } catch (err) {
    console.error("[main] accuracy:rules error:", err);
    return [];
  }
});

/**
 * Prune disambiguation rules for folders that no longer exist.
 * Called after folder renames/deletions.
 */
ipcMain.handle("accuracy:prune-rules", async (_event) => {
  try {
    const { pruneRulesForDeletedFolders } = getAccuracyMonitor();
    const { scanUserFolders: scan } = require("./services/fileService");
    const folders = await scan(currentBaseDir);
    const removed = pruneRulesForDeletedFolders(folders);
    return { removed };
  } catch (err) {
    console.error("[main] accuracy:prune-rules error:", err);
    return { removed: 0, error: String(err) };
  }
});

// ── Priority Rules (Conflict Resolution Learning) ──────────────
//
// When 2+ categories score >75% and the user resolves the conflict,
// save a priority rule so the same pattern auto-resolves next time.
// Stored in priority_rules.json per mode.
//
// Format: [{ keywords: ["FBLA", "Business Law"], winner: "Business Law", loser: "FBLA", timestamp }]

function readPriorityRules(baseDir) {
  const rulesPath = path.join(baseDir, "priority_rules.json");
  try {
    if (fs.existsSync(rulesPath)) {
      return JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
    }
  } catch {}
  return [];
}

function writePriorityRules(baseDir, rules) {
  const rulesPath = path.join(baseDir, "priority_rules.json");
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2), "utf-8");
}

// Save a priority rule when user resolves a conflict
ipcMain.handle("knowledge:save-priority", (_event, conflictCategories, chosenCategory, keywords) => {
  const rules = readPriorityRules(currentBaseDir);
  // conflictCategories: ["FBLA", "Business Law"], chosenCategory: "Business Law"
  const losers = conflictCategories.filter((c) => c !== chosenCategory);
  const rule = {
    keywords: keywords || [],
    winner: chosenCategory,
    losers,
    conflictCategories,
    timestamp: Date.now(),
  };
  rules.push(rule);
  writePriorityRules(currentBaseDir, rules);
  console.log(`[main] Priority rule saved: ${conflictCategories.join(" vs ")} → winner: "${chosenCategory}"`);
  return { saved: true, totalRules: rules.length };
});

// Read all priority rules (for ClassificationService conflict resolution)
ipcMain.handle("knowledge:read-priorities", () => {
  return readPriorityRules(currentBaseDir);
});

// ── Chat / File Search ───────────────────────────────────────────────────────

/**
 * Send a chat message to the AI. Searches the file index for relevant files,
 * builds a context prompt, and streams the response token by token to the
 * renderer via "chat:token" and "chat:done" IPC events.
 *
 * history: Array<{ role: "user" | "assistant", content: string }>
 */
ipcMain.handle("chat:send", async (_event, message, history) => {
  const window = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (!window) return { error: "No window available" };
  try {
    await handleChatMessage(message, history || [], window);
    return { ok: true };
  } catch (err) {
    console.error("[chat:send] Error:", err);
    return { error: String(err) };
  }
});

/**
 * Quick keyword search across indexed files — no AI, instant results.
 * Returns up to 8 matching file entries for the search-as-you-type feature.
 */
ipcMain.handle("chat:search", (_event, query) => {
  return searchFiles(query, 8);
});

// ── Prompt Enhancer + Namespace Isolation ────────────────────────────────────
// The namespace system ensures that Company A's files never influence prompts
// about Company B. Each folder gets tagged to a namespace (entity/project/personal)
// and context is scoped to only that namespace at enhancement time.

const NamespaceService = require("./services/NamespaceService");

ipcMain.handle("prompt:enhance", async (_event, userPrompt, preferredNamespaceId, appliedConstraints) => {
  try {
    const LlamaService = require("./services/LlamaService");
    if (!LlamaService.isReady()) {
      return { enhanced: null, error: "AI engine is still loading. Please wait a moment and try again." };
    }

    const kg = (() => { try { return loadKG(currentBaseDir); } catch { return null; } })();

    // Determine which namespace to use
    let namespaceId = preferredNamespaceId || null;
    let namespaceName = null;

    if (!namespaceId && kg) {
      namespaceId = NamespaceService.detectPromptNamespace(userPrompt);
    }

    // Build context — ONLY from the detected namespace if one is found
    let contextBlock = "\nNo file context available yet. Enhance based on general best practices only.\n";

    if (kg && Object.keys(kg.folders || {}).length > 0) {
      if (namespaceId) {
        // Scoped: only this namespace's folders
        const scoped = NamespaceService.getContextForNamespace(namespaceId, kg);
        const ns = NamespaceService.listNamespaces().find(n => n.id === namespaceId);
        namespaceName = ns?.label || namespaceId;
        contextBlock = scoped
          ? `\nContext (scoped to "${namespaceName}" only — no other data included):\n${scoped}\n`
          : `\nNo context yet for "${namespaceName}". Enhance based on the prompt alone.\n`;
      } else {
        // No namespace detected — use general context but warn about scope
        const folderNames = Object.keys(kg.folders).slice(0, 15).join(", ");
        contextBlock = `\nGeneral file context (namespace could not be determined — using broad context):\nFile categories: ${folderNames}\n`;
      }
    }

    // Constraints the user explicitly approved (RAG policy toggles) — these are
    // HARD requirements that must be honored in the rewrite. This is what turns
    // "cookies for the office" into "gluten-free cookies for the office".
    let constraintBlock = "";
    const cleanConstraints = Array.isArray(appliedConstraints)
      ? appliedConstraints.map(c => String(c || "").trim()).filter(Boolean)
      : [];
    if (cleanConstraints.length > 0) {
      constraintBlock =
        `\nMUST-FOLLOW constraints from the user's workplace (weave every one of these naturally into the rewrite — do not list them separately, do not drop any):\n` +
        cleanConstraints.map(c => `- ${c}`).join("\n") + "\n";
    }

    // ── User identity block ──
    // A compact, person-level "About the user" block (role, projects, expertise,
    // writing style) inferred locally by UserProfileService. This is the missing
    // context layer: it travels with every prompt regardless of namespace, so the
    // downstream model knows WHO is asking — without leaking any company's
    // confidential policies (those stay namespace-scoped above).
    let profileBlock = "";
    try {
      const UserProfileService = require("./services/UserProfileService");
      const block = UserProfileService.getProfileForPrompt();
      if (block) profileBlock = "\n" + block;
    } catch (e) {
      console.warn("[prompt:enhance] profile block unavailable:", e?.message);
    }

    const fullPrompt =
      `You are a personal prompt enhancer. Rewrite the user's prompt to be more specific, detailed, and context-aware using ONLY the context below. Do not invent facts. If context is irrelevant, just make the prompt clearer.` +
      profileBlock +
      contextBlock +
      constraintBlock +
      `\nUser's original prompt:\n${userPrompt}\n\nImproved prompt (output ONLY the rewritten prompt — no explanation, no preamble, no quotes):`;

    const result = await LlamaService.generate(fullPrompt, {
      maxTokens: 512,
      temperature: 0.3,
      timeoutMs: 30000,
    });

    const enhanced = (result || "").trim();
    if (!enhanced) return { enhanced: null, error: "AI returned an empty response. Please try again." };

    return { enhanced, namespaceId, namespaceName };
  } catch (err) {
    console.error("[prompt:enhance] error:", err?.message);
    return { enhanced: null, error: err?.message ?? "Enhancement failed." };
  }
});

// ── Smart Starters: file-aware prompt suggestions ─────────────────────────────
// Returns a few ready-to-use starter prompts grounded in the user's ACTUAL
// folders and namespaces. This runs instantly off the knowledge graph — no LLM
// call — so it's reliable even while the model is still loading. This is the
// differentiator: suggestions no cloud tool can make, because they're built
// from the user's local files. Purely additive; never throws to the renderer.
function buildSmartStarters(kg, namespaces) {
  const GENERIC_SKIP = new Set([
    "needs review", "misc", "miscellaneous", "other", "uncategorized",
    "untitled", "new folder", "downloads", "desktop", "documents",
  ]);

  // Real folder names, richest first (more terms ≈ more substantial folder)
  const folders = kg && kg.folders ? Object.entries(kg.folders) : [];
  const ranked = folders
    .map(([name, g]) => ({ name, weight: (g && g.terms ? g.terms.length : 0) }))
    .filter((f) => f.name && !GENERIC_SKIP.has(f.name.trim().toLowerCase()))
    .sort((a, b) => b.weight - a.weight)
    .map((f) => f.name);

  const nsList = Array.isArray(namespaces) ? namespaces.filter((n) => n && n.label) : [];
  const out = [];
  const push = (text, scope) => {
    if (text && !out.some((s) => s.text === text)) out.push({ text, scope: scope || "general" });
  };

  // Namespace-scoped starter (the strongest "your data" framing)
  if (nsList.length > 0) {
    const ns = nsList[0];
    push(`Using only my ${ns.label} files, write a short status update on where things stand.`, ns.label);
  }

  // Single-folder starters
  if (ranked[0]) {
    push(`Summarize the key documents in my "${ranked[0]}" folder into a one-page brief.`, ranked[0]);
  }
  if (ranked[1]) {
    push(`Turn the files in my "${ranked[1]}" folder into a prioritized to-do list.`, ranked[1]);
  } else if (ranked[0]) {
    push(`What should I do next with what's in my "${ranked[0]}" folder?`, ranked[0]);
  }

  // Two-folder comparison
  if (ranked[0] && ranked[1]) {
    push(`Compare what's in "${ranked[0]}" and "${ranked[1]}" and tell me what's missing or out of date.`, "cross-folder");
  }

  // Generic, still-useful fallbacks if the library is thin
  push("Turn my rough notes into a structured plan with clear steps and deadlines.", "general");
  push("Rewrite this to be clearer, more specific, and ready to send: (paste your draft)", "general");

  return out.slice(0, 3);
}

ipcMain.handle("prompt:suggestions", async () => {
  try {
    const kg = (() => { try { return loadKG(currentBaseDir); } catch { return null; } })();
    let namespaces = [];
    try { namespaces = NamespaceService.listNamespaces() || []; } catch { /* none yet */ }
    const suggestions = buildSmartStarters(kg, namespaces);
    const hasContext = !!(kg && kg.folders && Object.keys(kg.folders).length > 0);
    return { suggestions, hasContext };
  } catch (err) {
    console.error("[prompt:suggestions] error:", err?.message);
    return { suggestions: [], hasContext: false };
  }
});

// ── RAG agent: namespace-scoped retrieval for prompt enhancement ──────────────

/** Count indexed files per namespace (folder → namespace via assignments). */
function fileCountByNamespace() {
  const counts = {};
  try {
    for (const e of getAllEntries()) {
      const nsId = NamespaceService.getNamespaceForFolder(e.folder) || "unassigned";
      counts[nsId] = (counts[nsId] || 0) + 1;
    }
  } catch { /* index empty */ }
  return counts;
}

/** Indexed entries whose folder belongs to a given namespace. */
function entriesForNamespace(namespaceId) {
  if (!namespaceId) return [];
  try {
    return getAllEntries().filter(
      (e) => NamespaceService.getNamespaceForFolder(e.folder) === namespaceId
    );
  } catch { return []; }
}

/**
 * prompt:rag-context — the heart of the RAG agent.
 *
 * Given the user's draft prompt, it (1) decides which company the prompt is
 * about — defaulting ambient "office" prompts to the confirmed employer and
 * NEVER to a client/competitor; (2) pulls durable policy cards relevant to the
 * prompt; (3) retrieves supporting file passages, scoped to that namespace only.
 * Returns toggle-ready constraint candidates with source citations. The user
 * approves which ones apply before the rewrite ("suggest as toggles first").
 */
ipcMain.handle("prompt:rag-context", async (_event, userPrompt) => {
  const empty = { namespaceId: null, namespaceName: null, isEmployer: false, constraints: [], passages: [] };
  try {
    const prompt = String(userPrompt || "").trim();
    if (!prompt) return empty;

    // 1. Which company is this about?
    let namespaceId = NamespaceService.detectPromptNamespace(prompt);
    const employer = NamespaceService.getEmployerNamespace();
    if (!namespaceId && employer) namespaceId = employer.id;
    if (!namespaceId) return empty;

    const ns = NamespaceService.listNamespaces().find(n => n.id === namespaceId) || null;
    const isEmployer = !!(employer && employer.id === namespaceId);

    // 2. Relevant durable policy cards (the high-signal constraints)
    const policyCards = PolicyService.searchPolicies(namespaceId, prompt, 5);
    const constraints = policyCards.map(p => ({
      id: p.id,
      text: p.text,
      category: p.category || "general",
      source: p.sourceFile || (p.manual ? "added by you" : "your files"),
      kind: "policy",
    }));

    // 3. Supporting passages, scoped to this namespace only (no cross-company leak)
    let passages = [];
    try {
      const hits = await searchFilesHybrid(prompt, 12);
      passages = hits
        .filter(h => NamespaceService.getNamespaceForFolder(h.folder) === namespaceId)
        .slice(0, 3)
        .map(h => ({
          filename: h.filename,
          folder: h.folder,
          snippet: (h.snippet || h.fullText || "").slice(0, 200),
        }));
    } catch { /* retrieval unavailable */ }

    return {
      namespaceId,
      namespaceName: ns ? ns.label : namespaceId,
      isEmployer,
      constraints,
      passages,
    };
  } catch (err) {
    console.error("[prompt:rag-context] error:", err?.message);
    return empty;
  }
});

// ── Unified RAG-enhance workflow ──────────────────────────────────────────────
// One call that runs the whole pipeline: ensure the user profile exists, detect
// the namespace, RAG-retrieve the specifics relevant to THIS prompt (policy cards
// + file passages, scoped to that namespace), then rewrite. This is the
// "files → understanding → context-aware enhancement" workflow end to end.

/** Build the profile-inference inputs from current app state. */
function gatherProfileInputs() {
  const kg = (() => { try { return loadKG(currentBaseDir); } catch { return null; } })();
  let namespaces = [];
  try { namespaces = NamespaceService.listNamespaces() || []; } catch { /* none */ }
  const employer = (() => { try { return NamespaceService.getEmployerNamespace(); } catch { return null; } })();
  let entries = [];
  try { entries = getAllEntries() || []; } catch { /* index empty */ }
  return { kg, namespaces, employer, entries };
}

ipcMain.handle("prompt:enhance-smart", async (_event, userPrompt, preferredNamespaceId) => {
  try {
    const LlamaService = require("./services/LlamaService");
    const PromptWorkflowService = require("./services/PromptWorkflowService");
    const UserProfileService = require("./services/UserProfileService");

    if (!LlamaService.isReady()) {
      return { enhanced: null, error: "AI engine is still loading. Please wait a moment and try again." };
    }

    // 1. Ensure an identity profile exists. First-ever run: build it now so the
    //    very first enhancement is already personalized. Merely stale: refresh in
    //    the background and proceed with what we have (keeps latency low).
    try {
      const inputs = gatherProfileInputs();
      if (UserProfileService.isEmpty()) {
        await UserProfileService.buildProfile(inputs);
      } else if (UserProfileService.isStale()) {
        UserProfileService.buildProfile(inputs).catch(() => {});
      }
    } catch (e) {
      console.warn("[prompt:enhance-smart] profile ensure failed:", e?.message);
    }

    // 2. RAG retrieval wrapper — hybrid search, scoped to the namespace so no
    //    cross-company leakage reaches the rewrite.
    const retrieve = async (query, namespaceId) => {
      try {
        const hits = await searchFilesHybrid(query, 12);
        const scoped = namespaceId
          ? hits.filter((h) => NamespaceService.getNamespaceForFolder(h.folder) === namespaceId)
          : hits;
        return scoped.slice(0, PromptWorkflowService.MAX_PASSAGES).map((h) => ({
          filename: h.filename,
          folder: h.folder,
          snippet: (h.snippet || h.fullText || "").slice(0, 220),
        }));
      } catch { return []; }
    };

    const kg = (() => { try { return loadKG(currentBaseDir); } catch { return null; } })();

    const result = await PromptWorkflowService.runEnhancement(
      userPrompt,
      { preferredNamespaceId: preferredNamespaceId || null },
      {
        llama: LlamaService,
        namespaceService: NamespaceService,
        policyService: PolicyService,
        userProfileService: UserProfileService,
        retrieve,
        kg,
      }
    );
    return result;
  } catch (err) {
    console.error("[prompt:enhance-smart] error:", err?.message);
    return { enhanced: null, error: err?.message ?? "Enhancement failed." };
  }
});

// ── Employer identity IPC ─────────────────────────────────────────────────────

/** Current employer + scored candidates so the UI can suggest/confirm one. */
ipcMain.handle("namespace:employer-get", () => {
  try {
    const kg = (() => { try { return loadKG(currentBaseDir); } catch { return null; } })();
    const { suggestedId, candidates } = NamespaceService.detectEmployerCandidate(kg, fileCountByNamespace());
    const employer = NamespaceService.getEmployerNamespace();
    return { employerId: employer ? employer.id : null, confirmed: !!employer, suggestedId, candidates };
  } catch (err) {
    console.error("[namespace:employer-get]", err?.message);
    return { employerId: null, confirmed: false, suggestedId: null, candidates: [] };
  }
});

/** Confirm which namespace is the employer. */
ipcMain.handle("namespace:employer-set", (_event, namespaceId) => {
  try {
    const ns = NamespaceService.setEmployerNamespace(namespaceId);
    return ns ? { ok: true, employer: ns } : { ok: false, error: "Namespace not found" };
  } catch (err) {
    return { ok: false, error: err?.message };
  }
});

// ── Policy memory IPC ─────────────────────────────────────────────────────────

/** List policy cards for a namespace. */
ipcMain.handle("policy:list", (_event, namespaceId) => {
  try { return PolicyService.getPolicies(namespaceId); }
  catch { return []; }
});

/** Add a manual policy card. */
ipcMain.handle("policy:add", (_event, namespaceId, text, category) => {
  try { return PolicyService.addManualPolicy(namespaceId, text, category || "general"); }
  catch (e) { return null; }
});

/** Remove a policy card. */
ipcMain.handle("policy:remove", (_event, namespaceId, policyId) => {
  try { return { ok: PolicyService.removePolicy(namespaceId, policyId) }; }
  catch (e) { return { ok: false }; }
});

/**
 * policy:build — (re)learn the policy cards for a namespace from its indexed
 * files. Safe to call anytime; no-op if the model isn't ready or there are no
 * files. Defaults to the employer namespace when none is given.
 */
ipcMain.handle("policy:build", async (_event, namespaceId) => {
  try {
    let nsId = namespaceId;
    if (!nsId) {
      const employer = NamespaceService.getEmployerNamespace();
      nsId = employer ? employer.id : null;
    }
    if (!nsId) return { added: 0, total: 0, skipped: true, error: "No namespace" };
    const entries = entriesForNamespace(nsId);
    return await PolicyService.extractPoliciesForNamespace(nsId, entries);
  } catch (err) {
    console.error("[policy:build]", err?.message);
    return { added: 0, total: 0, skipped: true, error: err?.message };
  }
});

// ── User identity profile IPC ──────────────────────────────────────────────────
// The identity layer ("who is this person"): role, active projects, expertise,
// writing style — inferred locally and injected into prompt:enhance so the
// downstream model knows who's asking. Invisible by default, inspectable/clearable
// here so the user is never surprised by what the app has learned.

const UserProfileService = require("./services/UserProfileService");

/** Get the stored profile (for an inspect/"what the app knows" view). */
ipcMain.handle("profile:get", () => {
  try { return UserProfileService.getProfile(); }
  catch (e) { console.error("[profile:get]", e?.message); return UserProfileService.emptyProfile(); }
});

/** Lightweight status: built?, when, stale?, encrypted-at-rest?, counts. */
ipcMain.handle("profile:status", () => {
  try { return UserProfileService.getStatus(); }
  catch (e) { console.error("[profile:status]", e?.message); return { built: false }; }
});

/**
 * Build (or refresh) the identity profile from local signals: indexed files,
 * knowledge graph, namespaces, and the confirmed employer. On-device only.
 */
ipcMain.handle("profile:build", async () => {
  try {
    const kg = (() => { try { return loadKG(currentBaseDir); } catch { return null; } })();
    let namespaces = [];
    try { namespaces = NamespaceService.listNamespaces() || []; } catch { /* none */ }
    const employer = (() => { try { return NamespaceService.getEmployerNamespace(); } catch { return null; } })();
    let entries = [];
    try { entries = getAllEntries() || []; } catch { /* index empty */ }

    const profile = await UserProfileService.buildProfile({ entries, kg, employer, namespaces });
    return { ok: true, status: UserProfileService.getStatus(), profile };
  } catch (e) {
    console.error("[profile:build]", e?.message);
    return { ok: false, error: e?.message };
  }
});

/** Wipe the profile (both encrypted + any plaintext copy). */
ipcMain.handle("profile:clear", () => {
  try { return { ok: UserProfileService.clearProfile() }; }
  catch (e) { return { ok: false, error: e?.message }; }
});

// ── Tester feedback ────────────────────────────────────────────────────────────
// Lightweight local feedback log so testers can send notes during the prelaunch
// test. Appends to userData/feedback.json with app version + platform context.
ipcMain.handle("feedback:submit", (_event, message) => {
  try {
    const text = String(message || "").trim();
    if (!text) return { ok: false, error: "Empty feedback" };
    const fp = path.join(app.getPath("userData"), "feedback.json");
    let list = [];
    try { list = JSON.parse(fs.readFileSync(fp, "utf-8")); if (!Array.isArray(list)) list = []; } catch { list = []; }
    list.push({
      text,
      at: new Date().toISOString(),
      version: app.getVersion(),
      platform: `${process.platform} ${process.arch}`,
    });
    fs.writeFileSync(fp, JSON.stringify(list, null, 2), "utf-8");
    return { ok: true, count: list.length };
  } catch (e) {
    console.error("[feedback:submit]", e?.message);
    return { ok: false, error: e?.message };
  }
});

// ── Namespace management IPC ──────────────────────────────────────────────────

/** List all known namespaces. */
ipcMain.handle("namespace:list", () => {
  try { return NamespaceService.listNamespaces(); }
  catch (e) { console.error("[namespace:list]", e?.message); return []; }
});

/** Get folder→namespace assignment map. */
ipcMain.handle("namespace:folder-assignments", () => {
  try { return NamespaceService.getFolderAssignments(); }
  catch (e) { return {}; }
});

/** Manually create or update a namespace. */
ipcMain.handle("namespace:upsert", (_event, id, label, color, entityNames) => {
  try { return NamespaceService.upsertNamespace(id, label, color, entityNames); }
  catch (e) { console.error("[namespace:upsert]", e?.message); return null; }
});

/** Assign a folder to a namespace. */
ipcMain.handle("namespace:assign-folder", (_event, folderName, namespaceId) => {
  try {
    NamespaceService.assignFolderToNamespace(folderName, namespaceId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message };
  }
});

/**
 * Sync namespaces from the knowledge graph.
 * Call this after file organization completes — it auto-detects entity names
 * from folder names and keywords, creates namespaces, and assigns folders.
 */
ipcMain.handle("namespace:sync", async () => {
  try {
    const kg = loadKG(currentBaseDir);
    if (!kg) return { created: [], assigned: [] };
    const result = await NamespaceService.syncNamespacesFromKG(kg);
    console.log(`[namespace:sync] Created: ${result.created.join(", ") || "none"}, Assigned: ${result.assigned.length} folders`);
    return result;
  } catch (e) {
    console.error("[namespace:sync]", e?.message);
    return { created: [], assigned: [], error: e?.message };
  }
});

/**
 * Manually index a file (called after a successful file move).
 * filePath: destination path, folder: category name, text: extracted content
 */
ipcMain.handle("chat:index-file", (_event, filePath, folder, text) => {
  try {
    indexFile(filePath, folder, text || "");
    return { ok: true };
  } catch (err) {
    console.error("[chat:index-file] Error:", err);
    return { error: String(err) };
  }
});

/**
 * Get stats about the search index — total files, folder breakdown.
 */
ipcMain.handle("chat:index-stats", () => {
  return { totalFiles: getIndexSize(), folders: getFolderSummary() };
});

/**
 * Bulk reindex all files already sitting in the organized-files destination.
 * Streams progress events so the renderer can show a live progress bar.
 * The caller-supplied extractText function is the same one used for classification.
 */
ipcMain.handle("chat:reindex-all", async (_event) => {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];

  try {
    const result = await bulkReindex(
      DEST_DIR,
      (filePath) => extractFullText(filePath),
      (progress) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send("chat:reindex-progress", progress);
        }
      }
    );
    return { ok: true, ...result };
  } catch (err) {
    console.error("[chat:reindex-all] Error:", err);
    return { ok: false, error: String(err) };
  }
});

// ══════════════════════════════════════════════════════════════════
//  FOLDER WATCHER IPC
// ══════════════════════════════════════════════════════════════════

ipcMain.handle("watcher:status", () => getWatcherStatus());

ipcMain.handle("watcher:add-folder", async (_event, folder) => {
  try {
    return { ok: true, config: addWatchFolder(folder) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle("watcher:remove-folder", (_event, folder) => {
  try {
    return { ok: true, config: removeWatchFolder(folder) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle("watcher:set-enabled", (_event, enabled) => {
  try {
    return { ok: true, config: setWatcherEnabled(enabled) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle("watcher:pick-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Choose a folder to watch",
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ══════════════════════════════════════════════════════════════════
//  AI RENAME IPC
// ══════════════════════════════════════════════════════════════════

/** Suggest a clean filename for one file. */
ipcMain.handle("rename:suggest", async (_event, filePath, textContent) => {
  try {
    const suggestion = await suggestRename(filePath, textContent || "");
    return { ok: true, suggestion };
  } catch (err) {
    console.error("[rename:suggest] Error:", err);
    return { ok: false, error: String(err) };
  }
});

/** Actually rename the file on disk. Returns new path. */
ipcMain.handle("rename:apply", (_event, originalPath, newName) => {
  try {
    const newPath = applyRename(originalPath, newName);
    return { ok: true, newPath };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ══════════════════════════════════════════════════════════════════
//  UNDO / REDO IPC
// ══════════════════════════════════════════════════════════════════

/** Reverse a file move: move file from dest back to source. */
ipcMain.handle("file:undo-move", async (_event, from, to) => {
  try {
    await safeMoveFile(to, from);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ══════════════════════════════════════════════════════════════════
//  ENTERPRISE COMPLIANCE IPC  (Work Mode only — personal untouched)
// ══════════════════════════════════════════════════════════════════

/** Write a structured audit entry. Only meaningful in Work Mode. */
ipcMain.handle("compliance:write-entry", (_event, action, fields) => {
  if (currentMode !== "work") return null;
  return writeAuditEntry(action, fields);
});

ipcMain.handle("compliance:read-log", () => {
  if (currentMode !== "work") return [];
  return readAuditLog();
});

ipcMain.handle("compliance:stats", () => {
  if (currentMode !== "work") return null;
  return getComplianceStats();
});

/** Log a PII incident. Work Mode only. */
ipcMain.handle("compliance:pii-incident", (_event, filename, fullPath, types, action) => {
  if (currentMode !== "work") return null;
  return logPIIIncident(filename, fullPath, types || [], action || "flagged");
});

ipcMain.handle("compliance:pii-incidents", () => {
  if (currentMode !== "work") return [];
  return readPIIIncidents();
});

ipcMain.handle("compliance:resolve-pii", (_event, id) => {
  if (currentMode !== "work") return false;
  return resolvePIIIncident(id);
});

/** Retention rules CRUD. Work Mode only. */
ipcMain.handle("compliance:get-retention-rules", () => {
  if (currentMode !== "work") return [];
  return getRetentionRules();
});

ipcMain.handle("compliance:add-retention-rule", (_event, folder, maxAgeDays, label) => {
  if (currentMode !== "work") return null;
  return addRetentionRule(folder, maxAgeDays, label);
});

ipcMain.handle("compliance:delete-retention-rule", (_event, id) => {
  if (currentMode !== "work") return;
  deleteRetentionRule(id);
});

ipcMain.handle("compliance:scan-retention", () => {
  if (currentMode !== "work") return [];
  return scanRetention();
});

/**
 * Generate and save a compliance PDF report.
 * Uses a hidden BrowserWindow + printToPDF so no extra deps are needed.
 */
ipcMain.handle("compliance:export-pdf", async () => {
  if (currentMode !== "work") return { ok: false, error: "Work Mode only" };

  try {
    const html = buildComplianceReportHTML();

    // Ask user where to save
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "Save Compliance Report",
      defaultPath: path.join(os.homedir(), `compliance_report_${new Date().toISOString().slice(0, 10)}.pdf`),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (canceled || !filePath) return { ok: false, error: "Cancelled" };

    // Spin up a hidden window, load HTML, print to PDF
    const reportWin = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    await reportWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    const pdfBuffer = await reportWin.webContents.printToPDF({
      printBackground: true,
      pageSize: "Letter",
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
    });
    reportWin.destroy();

    fs.writeFileSync(filePath, pdfBuffer);
    console.log(`[Compliance] PDF saved: ${filePath}`);
    return { ok: true, filePath };
  } catch (err) {
    console.error("[compliance:export-pdf]", err);
    return { ok: false, error: String(err) };
  }
});

// ══════════════════════════════════════════════════════════════════
//  LAN CONFIG IPC  (Work Mode multi-seat)
// ══════════════════════════════════════════════════════════════════

ipcMain.handle("enterprise:get-lan-config", () => loadLanConfig());

ipcMain.handle("enterprise:save-lan-config", (_event, cfg) => {
  saveLanConfig(cfg);
  return { ok: true };
});

ipcMain.handle("enterprise:get-folders", () => {
  // Returns available folders in the current work dir for retention rule setup
  if (currentMode !== "work") return [];
  try {
    return fs.readdirSync(currentBaseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => !n.startsWith("."));
  } catch { return []; }
});

// ══════════════════════════════════════════════════════════════════
//  CLOUD STORAGE CONNECTORS IPC  (Google Drive + iCloud)
//  Works in BOTH Personal and Work modes.
// ══════════════════════════════════════════════════════════════════

/** Auto-detect available cloud storage providers. */
ipcMain.handle("cloud:detect", () => {
  return redetectCloudProviders();
});

/** List all configured cloud connectors with current status. */
ipcMain.handle("cloud:list", () => {
  return listConnectors();
});

/** Enable a cloud connector by provider ID ("icloud" or "googledrive"). */
ipcMain.handle("cloud:enable", (_event, id) => {
  try {
    return { ok: true, connector: enableConnector(id) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/** Disable a cloud connector. Files in cloud are NOT deleted. */
ipcMain.handle("cloud:disable", (_event, id) => {
  try {
    return { ok: true, connector: disableConnector(id) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/** Set a custom path for a cloud connector (overrides auto-detection). */
ipcMain.handle("cloud:set-path", async (_event, id, customPath) => {
  // If no path provided, open a folder picker
  if (!customPath) {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: `Select ${id === "icloud" ? "iCloud Drive" : "Google Drive"} folder`,
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, error: "Cancelled" };
    customPath = result.filePaths[0];
  }
  try {
    return { ok: true, connector: setConnectorPath(id, customPath) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/** Set the subfolder within cloud storage for organized files. */
ipcMain.handle("cloud:set-subfolder", (_event, id, subfolder) => {
  try {
    return { ok: true, connector: setConnectorSubfolder(id, subfolder) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/** Get health/status for a specific connector. */
ipcMain.handle("cloud:status", (_event, id) => {
  return getConnectorStatus(id);
});

/**
 * Manually trigger a bulk sync — copies all organized files to enabled cloud connectors.
 * Streams progress events so the renderer can show a live progress indicator.
 */
ipcMain.handle("cloud:sync-now", async () => {
  const connectors = getEnabledConnectors();
  if (connectors.length === 0) {
    return { ok: false, error: "No cloud connectors enabled" };
  }
  try {
    const result = await bulkSyncToCloud(
      currentBaseDir,
      (current, total) => {
        mainWindow?.webContents.send("cloud:sync-progress", current, total);
      }
    );
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/** Get the recent cloud sync log. */
ipcMain.handle("cloud:sync-log", () => {
  return getSyncLog();
});

/** Clear the cloud sync log. */
ipcMain.handle("cloud:clear-log", () => {
  clearSyncLog();
  return true;
});

// ═══════════════════════════════════════════════════════════════
//  GOOGLE DRIVE API — Two-way Drive integration IPC handlers
// ═══════════════════════════════════════════════════════════════

/** Get Google Drive auth status */
ipcMain.handle("gdrive:auth-status", () => {
  return getDriveAuthStatus();
});



/** Start OAuth2 login flow */
ipcMain.handle("gdrive:auth-login", async () => {
  return startDriveAuth();
});

/** Sign out of Google Drive */
ipcMain.handle("gdrive:auth-logout", () => {
  driveSignOut();
  return { ok: true };
});

/** List files in a Drive folder */
ipcMain.handle("gdrive:list-files", async (_e, folderId, pageSize) => {
  return driveListFiles(folderId || "root", pageSize || 100);
});

/** Search files in Drive */
ipcMain.handle("gdrive:search", async (_e, query) => {
  return driveSearchFiles(query);
});

/** Download a file from Drive to local temp */
ipcMain.handle("gdrive:download", async (_e, fileId, fileName) => {
  return driveDownloadFile(fileId, fileName);
});

/** Upload a local file to Drive */
ipcMain.handle("gdrive:upload", async (_e, localPath, parentFolderId, fileName) => {
  return driveUploadFile(localPath, parentFolderId || "root", fileName);
});

/** Create a folder in Drive */
ipcMain.handle("gdrive:create-folder", async (_e, name, parentId) => {
  return driveCreateFolder(name, parentId || "root");
});

/** Organize a file in Drive (classify + move to category folder) */
ipcMain.handle("gdrive:organize", async (_e, fileId, currentParentId, category) => {
  return driveOrganizeInDrive(fileId, currentParentId, category);
});

/** Get storage quota */
ipcMain.handle("gdrive:quota", async () => {
  return driveGetQuota();
});

/** Clean up temp files */
ipcMain.handle("gdrive:cleanup", async () => {
  return driveCleanupTemp();
});

/** Full classify-and-organize flow for a Drive file */
ipcMain.handle("gdrive:classify-and-organize", async (_e, fileId, fileName, currentParentId) => {
  // 1. Download file to local temp
  const localPath = await driveDownloadFile(fileId, fileName);

  // 2. Classify using the local AI
  const result = await classifyFile(localPath, currentBaseDir);

  // 3. If classified successfully, organize in Drive
  if (result.category && result.category !== "Needs Review") {
    const organized = await driveOrganizeInDrive(fileId, currentParentId, result.category);
    return {
      ...result,
      organized: true,
      driveFolder: organized.folder,
      driveFile: organized.file,
    };
  }

  return {
    ...result,
    organized: false,
  };
});

// ── Prompt-Based Reorganization ──────────────────────────────

ipcMain.handle("prompt-reorg:scan", async (_e, targetDir) => {
  notifyUserActivity();
  try {
    // Use lean scan with caching
    return await prScanLean(targetDir);
  } catch (err) {
    console.error("[main] prompt-reorg:scan failed:", err?.message);
    return { files: [], totalCount: 0, scannedAt: new Date().toISOString(), targetDirectory: targetDir };
  }
});

ipcMain.handle("prompt-reorg:analyze", async (_e, userPrompt, manifest) => {
  notifyUserActivity();
  return prAnalyzeWithAI(userPrompt, manifest);
});

ipcMain.handle("prompt-reorg:preview", async (_e, userPrompt, targetDirectory, manifest, plan) => {
  notifyUserActivity();
  // Use lean preview builder if manifest has lean files (index field present)
  if (manifest?.files?.[0]?.index !== undefined) {
    return prBuildPreviewLean(userPrompt, targetDirectory, manifest, plan);
  }
  return prBuildPreview(userPrompt, targetDirectory, manifest, plan);
});

ipcMain.handle("prompt-reorg:execute", async (_e, preview) => {
  notifyUserActivity();
  const result = await prExecutePreview(preview);
  // Notify renderer for post-operation toast
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send("prompt-reorg:executed", {
      moved: result.moved,
      failed: result.failed.length,
      operationId: result.operationId,
      undoLogId: result.undoLogId,
      prompt: preview.prompt,
    });
  }
  return result;
});

ipcMain.handle("prompt-reorg:get-history", async () => {
  return prGetHistory();
});

ipcMain.handle("prompt-reorg:undo", async (_e, operationId) => {
  notifyUserActivity();
  return prUndoOperation(operationId);
});

/** Full pipeline: scan + analyze + reasons + preview in one call with progress events. */
ipcMain.handle("prompt-reorg:run-pipeline", async (_e, userPrompt, targetDirectory) => {
  notifyUserActivity();
  return prRunFullPipeline(userPrompt, targetDirectory);
});

// ── Undo Log ──────────────────────────────────────────────────

ipcMain.handle("undo-log:get", async () => {
  return getUndoLog();
});

ipcMain.handle("undo-log:undo", async (_e, operationId) => {
  notifyUserActivity();
  return undoLogUndo(operationId);
});

ipcMain.handle("undo-log:clear", async () => {
  return clearUndoLog();
});

// ── Organization Templates ─────────────────────────────────────

ipcMain.handle("templates:get-all", async (_e, category) => {
  return getAllTemplates(category);
});

ipcMain.handle("templates:use", async (_e, templateId) => {
  await recordTemplateUse(templateId);
  return { ok: true };
});

ipcMain.handle("templates:save-custom", async (_e, name, prompt, icon, category) => {
  return saveCustomTemplate(name, prompt, icon, category);
});

ipcMain.handle("templates:delete-custom", async (_e, id) => {
  return deleteCustomTemplate(id);
});

// ── Scan Cache ─────────────────────────────────────────────────

ipcMain.handle("scan-cache:stats", async () => {
  return getScanCacheStats();
});

ipcMain.handle("scan-cache:invalidate", async (_e, folderPath) => {
  await invalidateScanCache(folderPath);
  return { ok: true };
});

// ── AI Health ─────────────────────────────────────────────────

ipcMain.handle("ai:status", () => {
  return getAIStatus();
});
