/**
 * preload.js — Context bridge between renderer and main process.
 *
 * Exposes a safe `window.api` object that the React frontend
 * uses to call main-process services (classification, learning,
 * file moves, licensing).
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // ── App ────────────────────────────────────────────
  /** Get the hardcoded destination path (computed in main process using os.homedir()). */
  getDestDir: () => ipcRenderer.invoke("app:get-dest-dir"),
  /** Let the user choose a custom destination folder for the current mode. */
  setDestDir: (mode) => ipcRenderer.invoke("app:set-dest-dir", mode),
  /** Reset destination to default for the given mode. */
  resetDestDir: (mode) => ipcRenderer.invoke("app:reset-dest-dir", mode),

  // ── Ollama engine ─────────────────────────────────────
  ollama: {
    /** Retry loading the AI model without restarting the app. Returns { success, model, tier, rulesOnly }. */
    retry: () => ipcRenderer.invoke("ollama:retry"),
    /** Current engine status: { running, rulesOnly, selectedModel, tier }. */
    status: () => ipcRenderer.invoke("ollama:status"),
  },

  // ── System requirements / first-run ──────────────────
  system: {
    /** True if this is the first launch (user hasn't seen system requirements screen). */
    isFirstRun: () => ipcRenderer.invoke("app:is-first-run"),
    /** Mark the system requirements screen as seen. */
    markFirstRunSeen: () => ipcRenderer.invoke("app:mark-first-run-seen"),
    /** Run system checks: RAM, disk, Ollama presence. */
    check: () => ipcRenderer.invoke("app:system-check"),
    /** True if the user hasn't completed the new prompt-first onboarding. */
    hasCompletedOnboarding: () => ipcRenderer.invoke("app:has-completed-onboarding"),
    /** Mark the new onboarding as completed. */
    completeOnboarding: () => ipcRenderer.invoke("app:complete-onboarding"),
  },

  // ── Model download ────────────────────────────────────
  model: {
    /** Check if a model is already cached locally. */
    isDownloaded: (modelName) => ipcRenderer.invoke("model:is-downloaded", modelName),
    /** Pull a model from Ollama registry. Progress via on.modelPullProgress. */
    pull: (modelName) => ipcRenderer.invoke("model:pull", modelName),
  },

  // ── Dialogs ─────────────────────────────────────────
  dialog: {
    /** Open native file picker (multi-select, ALL file types). Returns string[] or []. */
    openFiles: () => ipcRenderer.invoke("dialog:open-files"),
    openFolder: () => ipcRenderer.invoke("dialog:open-folder"),
  },

  // ── Scan ────────────────────────────────────────────
  scan: {
    allFiles: (folderPath, recursive) =>
      ipcRenderer.invoke("file:get-all-files", folderPath, recursive),
  },

  // ── License ──────────────────────────────────────────
  license: {
    validate: (key) => ipcRenderer.invoke("license:validate", key),
    check: () => ipcRenderer.invoke("license:check"),
    info: () => ipcRenderer.invoke("license:info"),
    clear: () => ipcRenderer.invoke("license:clear"),
  },

  // ── File operations ──────────────────────────────────
  file: {
    move:     (source, dest) => ipcRenderer.invoke("file:move", source, dest),
    undoMove: (from, to)     => ipcRenderer.invoke("file:undo-move", from, to),
  },

  // ── Classification ───────────────────────────────────
  classify: {
    /**
     * Classify a single file using full production intelligence pipeline:
     *   - Folder fingerprints with AI expansion (Cold Start Fix)
     *   - Noise folder penalty (Archives, Old, Misc → -30% confidence)
     *   - OCR extraction for scanned PDFs
     *   - Chain-of-thought reasoning with concept abstraction
     *
     * Returns: {
     *   category: string,
     *   confidence: number (0-100),
     *   reasoning: string,
     *   isNewFolder: boolean,
     *   detected_concepts: string[],
     *   concept_abstraction: string,  // High-level domain description
     *   requires_review: boolean,     // true if confidence < 60
     *   was_noise_penalized: boolean  // true if category was a noise folder
     * }
     */
    file: (filePath, targetDir) =>
      ipcRenderer.invoke("classify:file", filePath, targetDir),

    /** Classify multiple files against the same target directory. */
    batch: (filePaths, targetDir) =>
      ipcRenderer.invoke("classify:batch", filePaths, targetDir),
  },

  // ── Folder Discovery ───────────────────────────────────
  folders: {
    /** Scan target directory and return existing subfolder names. */
    scan: (targetDir) => ipcRenderer.invoke("folders:scan", targetDir),
    /** Create a new category subfolder. Returns sanitized name. */
    create: (name) => ipcRenderer.invoke("create-category", name),
  },

  // ── Folder Fingerprinting + Topic Aliasing ──────────────
  context: {
    /**
     * Get full fingerprints: { folder: { keywords, coreTopics, sampleCount,
     *                                    isAIExpanded, isNoiseFolder, updatedAt } }
     */
    fingerprints: (targetDir) => ipcRenderer.invoke("context:fingerprints", targetDir),

    /**
     * Get rich context for prompt: { folder: { autoKeywords, coreTopics,
     *                                          description, isNoiseFolder } }
     */
    promptMap: (targetDir) => ipcRenderer.invoke("context:prompt-map", targetDir),

    /** Force fingerprint refresh after file moves. */
    refresh: () => ipcRenderer.invoke("context:refresh"),

    /** Get current topic aliases: { "FolderName": "topic1, topic2, ..." } */
    aliases: () => ipcRenderer.invoke("context:aliases"),

    /**
     * Save topic aliases to alias_map.json.
     * aliases: { "FolderName": "topic1, topic2, ..." }
     */
    saveAliases: (targetDir, aliases) =>
      ipcRenderer.invoke("context:save-aliases", targetDir, aliases),

    /** Check if a folder name is a "noise" folder (Archives, Old, Misc, etc.) */
    isNoiseFolder: (folderName) => ipcRenderer.invoke("context:is-noise-folder", folderName),

    /** Get the list of noise folder names (for settings UI). */
    noiseFolders: () => ipcRenderer.invoke("context:noise-folders"),
  },

  // ── Text Extraction / OCR ──────────────────────────────
  extract: {
    /** Extract text from any file (for UI preview). Returns string (up to 2000 words). */
    text: (filePath) => ipcRenderer.invoke("extract:text", filePath),

    /** Legacy: Check if Tesseract OCR is available. */
    ocrStatus: () => ipcRenderer.invoke("extract:ocr-status"),

    /**
     * Get full extraction capabilities:
     * { pdfParse: true, pdfImgConvert: true, tesseractJs: true, mammoth: true, admZip: true }
     */
    capabilities: () => ipcRenderer.invoke("extract:capabilities"),
  },

  // ── Learning / Feedback ──────────────────────────────
  learning: {
    /**
     * Record user corrections in batch.
     * corrections: Array<{ filename, extension, aiGuess, aiConfidence, userChoice }>
     * Only corrections where aiGuess !== userChoice are actually stored.
     */
    recordBatch: (corrections) =>
      ipcRenderer.invoke("learning:record-batch", corrections),

    /** Get learning stats (total corrections, unique categories, etc.) */
    stats: () => ipcRenderer.invoke("learning:stats"),

    /** Get full correction history (for settings/debug). */
    history: () => ipcRenderer.invoke("learning:history"),

    /** Clear all learning data. */
    clear: () => ipcRenderer.invoke("learning:clear"),
  },

  // ── Semantic Concept Learning (Datamuse + Wikipedia) ──────
  knowledge: {
    /** Deep Dive: fetch related concepts from Datamuse + Wikipedia and save to global pool. */
    learnCategory: (category) => ipcRenderer.invoke("knowledge:learn-category", category),
    /** Read the full knowledge base. */
    read: () => ipcRenderer.invoke("knowledge:read"),
    /** Read the global concepts pool. */
    readPool: () => ipcRenderer.invoke("knowledge:read-pool"),
    /** Reinforce a category with additional keywords (from user corrections). */
    reinforce: (category, keywords) => ipcRenderer.invoke("knowledge:reinforce", category, keywords),
    /** Export the full pool as JSON string (for download). */
    exportPool: () => ipcRenderer.invoke("knowledge:export-pool"),
    /** Clean the entire pool: remove garbage concepts using AI + stop-word filtering. */
    cleanPool: () => ipcRenderer.invoke("knowledge:clean-pool"),
    /** Save a priority rule when user resolves a conflict. */
    savePriority: (conflictCategories, chosenCategory, keywords) =>
      ipcRenderer.invoke("knowledge:save-priority", conflictCategories, chosenCategory, keywords),
    /** Read all priority rules. */
    readPriorities: () => ipcRenderer.invoke("knowledge:read-priorities"),
  },

  // ── Pool Health & Sanitization (Universal Pool Manager) ──────────────────
  pool: {
    /** Get pool health metrics for all folders (pollution ratio, distinctiveness, etc.). */
    health: () => ipcRenderer.invoke("pool:health"),
    /**
     * Sanitize concept pools: remove generic terms (≥40% of folders) and
     * cross-contaminated terms (shared between unrelated folders).
     * Statistical only — no AI needed. Returns SanitizationStats.
     */
    sanitize: () => ipcRenderer.invoke("pool:sanitize"),
    /**
     * Run forced pool maintenance (prune stale/low-quality terms).
     * Bypasses the 7-day schedule. Returns MaintenanceReport.
     */
    maintenance: () => ipcRenderer.invoke("pool:maintenance"),
    /** Check whether scheduled maintenance is due. Returns { due: boolean }. */
    maintenanceDue: () => ipcRenderer.invoke("pool:maintenance-due"),
    /**
     * Bulk-enrich pools from all existing learning history.
     * Run once to bootstrap concept pools from past corrections.
     * Returns { termsAdded: number }.
     */
    enrichFromHistory: () => ipcRenderer.invoke("pool:enrich-from-history"),
  },

  // ── Knowledge Graph ───────────────────────────────────────────────────────
  knowledgeGraph: {
    /**
     * Rebuild the AI knowledge graph for all folders.
     * Uses Ollama two-phase prompting to generate domain-specific term lists.
     * Returns { folderCount, termsAdded, folders } when complete.
     * Listen to on.knowledgeGraphProgress for live updates.
     */
    rebuild: () => ipcRenderer.invoke("knowledge-graph:rebuild"),
    /** Return the current knowledge graph JSON, or null if not yet built. */
    get: () => ipcRenderer.invoke("knowledge-graph:get"),
  },

  // ── Accuracy Monitor ──────────────────────────────────────────────────────
  accuracy: {
    /** Get overall accuracy stats: tier breakdown, confusion pairs, etc. */
    stats: () => ipcRenderer.invoke("accuracy:stats"),
    /** Get confusion pairs that need disambiguation rules generated. */
    pendingDisambig: () => ipcRenderer.invoke("accuracy:pending-disambig"),
    /**
     * Generate a disambiguation rule for a folder pair that has been
     * confused 10+ times. Call this when the user approves auto-disambiguation.
     */
    generateDisambig: (folderA, folderB) =>
      ipcRenderer.invoke("accuracy:generate-disambig", folderA, folderB),
    /** Reset all accuracy tracking data (called with learning:clear). */
    reset: () => ipcRenderer.invoke("accuracy:reset"),
    /** Get all disambiguation rules (including disabled) for the rules UI. */
    rules: () => ipcRenderer.invoke("accuracy:rules"),
    /** Manually disable a disambiguation rule. Returns { success: boolean }. */
    disableRule: (folderA, folderB) =>
      ipcRenderer.invoke("accuracy:disable-rule", folderA, folderB),
    /**
     * Prune disambiguation rules for folders that no longer exist.
     * Returns { removed: number }.
     */
    pruneRules: () => ipcRenderer.invoke("accuracy:prune-rules"),
  },

  // ── Dual Mode ────────────────────────────────────────────
  mode: {
    switch: (mode) => ipcRenderer.invoke("app:switch-mode", mode),
    get: () => ipcRenderer.invoke("app:get-mode"),
  },

  // ── Smart Rules (Association Learning) ───────────────────
  smartRules: {
    read: () => ipcRenderer.invoke("smart-rules:read"),
    write: (rules) => ipcRenderer.invoke("smart-rules:write", rules),
  },

  // ── Audit Log ────────────────────────────────────────────
  audit: {
    write: (entry) => ipcRenderer.invoke("audit:write", entry),
    read: () => ipcRenderer.invoke("audit:read"),
  },

  // ── PII Secure Move ──────────────────────────────────────
  pii: {
    secureMove: (source, filename) => ipcRenderer.invoke("pii:secure-move", source, filename),
  },

  // ── Auto-Update ─────────────────────────────────────────
  update: {
    install: () => ipcRenderer.invoke("update:install"),
  },

  // ── Chat / File Search ───────────────────────────────
  chat: {
    /**
     * Send a message to the AI. Streams response via chat:token / chat:done events.
     * history: Array<{ role: "user"|"assistant", content: string }>
     */
    send: (message, history) => ipcRenderer.invoke("chat:send", message, history),

    /** Instant keyword search across indexed files. Returns matching file entries. */
    search: (query) => ipcRenderer.invoke("chat:search", query),

    /** Index a file after it has been moved. */
    indexFile: (filePath, folder, text) =>
      ipcRenderer.invoke("chat:index-file", filePath, folder, text),

    /** Get search index stats. */
    stats: () => ipcRenderer.invoke("chat:index-stats"),
    /** Bulk reindex all files already in the organized destination folder. */
    reindexAll: () => ipcRenderer.invoke("chat:reindex-all"),
  },

  // ── Enterprise Compliance (Work Mode only) ───────────
  compliance: {
    writeEntry:       (action, fields)              => ipcRenderer.invoke("compliance:write-entry", action, fields),
    readLog:          ()                            => ipcRenderer.invoke("compliance:read-log"),
    stats:            ()                            => ipcRenderer.invoke("compliance:stats"),
    piiIncident:      (filename, path, types, act)  => ipcRenderer.invoke("compliance:pii-incident", filename, path, types, act),
    piiIncidents:     ()                            => ipcRenderer.invoke("compliance:pii-incidents"),
    resolvePII:       (id)                          => ipcRenderer.invoke("compliance:resolve-pii", id),
    getRetentionRules:()                            => ipcRenderer.invoke("compliance:get-retention-rules"),
    addRetentionRule: (folder, days, label)         => ipcRenderer.invoke("compliance:add-retention-rule", folder, days, label),
    deleteRetentionRule:(id)                        => ipcRenderer.invoke("compliance:delete-retention-rule", id),
    scanRetention:    ()                            => ipcRenderer.invoke("compliance:scan-retention"),
    exportPDF:        ()                            => ipcRenderer.invoke("compliance:export-pdf"),
  },

  // ── Enterprise LAN Config ─────────────────────────────
  enterprise: {
    getLanConfig:    ()    => ipcRenderer.invoke("enterprise:get-lan-config"),
    saveLanConfig:   (cfg) => ipcRenderer.invoke("enterprise:save-lan-config", cfg),
    getFolders:      ()    => ipcRenderer.invoke("enterprise:get-folders"),
  },

  // ── Folder Watcher ───────────────────────────────────
  watcher: {
    status:      ()         => ipcRenderer.invoke("watcher:status"),
    addFolder:   (folder)   => ipcRenderer.invoke("watcher:add-folder", folder),
    removeFolder:(folder)   => ipcRenderer.invoke("watcher:remove-folder", folder),
    setEnabled:  (enabled)  => ipcRenderer.invoke("watcher:set-enabled", enabled),
    pickFolder:  ()         => ipcRenderer.invoke("watcher:pick-folder"),
    /**
     * Step 4 of the disambiguation pipeline.
     * Called when the user picks a folder from the disambiguation card.
     * Payload: { filePath, filename, chosenCategory, otherCategory,
     *            catAKeywords, catBKeywords, aiConfidence }
     */
    disambiguationChoice: (payload) =>
      ipcRenderer.invoke("watcher:disambiguation-choice", payload),
    /**
     * Called when the user skips (dismisses) the disambiguation card
     * without making a choice. Releases the queue lock so the next
     * pending file can be shown.
     */
    disambiguationSkip: () =>
      ipcRenderer.invoke("watcher:disambiguation-skip"),
  },

  // ── Background Learner ───────────────────────────────
  learner: {
    status:  ()  => ipcRenderer.invoke("learner:status"),
    pause:   ()  => ipcRenderer.invoke("learner:pause"),
    resume:  ()  => ipcRenderer.invoke("learner:resume"),
    /** Reset ledger — force re-scan of all organized files. */
    reset:   ()  => ipcRenderer.invoke("learner:reset"),
  },

  // ── AI Rename ────────────────────────────────────────
  rename: {
    suggest: (filePath, text) => ipcRenderer.invoke("rename:suggest", filePath, text),
    apply:   (filePath, name) => ipcRenderer.invoke("rename:apply", filePath, name),
  },

  // ── Cloud Storage Connectors (Google Drive + iCloud) ────
  cloud: {
    /** Auto-detect available cloud storage providers. */
    detect:       ()                => ipcRenderer.invoke("cloud:detect"),
    /** List all configured connectors with current status. */
    list:         ()                => ipcRenderer.invoke("cloud:list"),
    /** Enable a connector by ID ("icloud" or "googledrive"). */
    enable:       (id)              => ipcRenderer.invoke("cloud:enable", id),
    /** Disable a connector (files in cloud are NOT deleted). */
    disable:      (id)              => ipcRenderer.invoke("cloud:disable", id),
    /** Set a custom path for a connector (opens folder picker if no path given). */
    setPath:      (id, customPath)  => ipcRenderer.invoke("cloud:set-path", id, customPath),
    /** Set the subfolder name within the cloud root. */
    setSubfolder: (id, subfolder)   => ipcRenderer.invoke("cloud:set-subfolder", id, subfolder),
    /** Get health/status for a specific connector. */
    status:       (id)              => ipcRenderer.invoke("cloud:status", id),
    /** Trigger a bulk sync of all organized files to enabled cloud connectors. */
    syncNow:      ()                => ipcRenderer.invoke("cloud:sync-now"),
    /** Get the recent sync log. */
    syncLog:      ()                => ipcRenderer.invoke("cloud:sync-log"),
    /** Clear the sync log. */
    clearLog:     ()                => ipcRenderer.invoke("cloud:clear-log"),
  },

  // ── Google Drive API ──────────────────────────────────
  gdrive: {
    /** Get auth status (isAuthenticated, needsRefresh) */
    authStatus: () => ipcRenderer.invoke("gdrive:auth-status"),
    /** Start OAuth login flow (opens browser) */
    login: () => ipcRenderer.invoke("gdrive:auth-login"),
    /** Sign out */
    logout: () => ipcRenderer.invoke("gdrive:auth-logout"),
    /** List files in a folder (default: root) */
    listFiles: (folderId, pageSize) =>
      ipcRenderer.invoke("gdrive:list-files", folderId, pageSize),
    /** Search files across Drive */
    search: (query) => ipcRenderer.invoke("gdrive:search", query),
    /** Download file to local temp (returns local path) */
    download: (fileId, fileName) =>
      ipcRenderer.invoke("gdrive:download", fileId, fileName),
    /** Upload local file to Drive folder */
    upload: (localPath, parentFolderId, fileName) =>
      ipcRenderer.invoke("gdrive:upload", localPath, parentFolderId, fileName),
    /** Create a folder in Drive */
    createFolder: (name, parentId) =>
      ipcRenderer.invoke("gdrive:create-folder", name, parentId),
    /** Organize a file (classify locally + move in Drive) */
    classifyAndOrganize: (fileId, fileName, currentParentId) =>
      ipcRenderer.invoke("gdrive:classify-and-organize", fileId, fileName, currentParentId),
    /** Get storage quota */
    quota: () => ipcRenderer.invoke("gdrive:quota"),
    /** Clean up temp files */
    cleanup: () => ipcRenderer.invoke("gdrive:cleanup"),
  },

  // ── Prompt-Based Reorganization ───────────────────────
  promptReorg: {
    /** Scan a directory and return a LeanManifest (cached, lean format). */
    scan: (targetDir) => ipcRenderer.invoke("prompt-reorg:scan", targetDir),
    /** Send manifest + user prompt to AI. Returns { plan, error? }. */
    analyze: (userPrompt, manifest) => ipcRenderer.invoke("prompt-reorg:analyze", userPrompt, manifest),
    /** Build a ReorgPreview (full move list) from a plan. Returns ReorgPreview. */
    preview: (userPrompt, targetDirectory, manifest, plan) =>
      ipcRenderer.invoke("prompt-reorg:preview", userPrompt, targetDirectory, manifest, plan),
    /** Execute approved moves in a preview. Returns { moved, failed, operationId, undoLogId }. */
    execute: (preview) => ipcRenderer.invoke("prompt-reorg:execute", preview),
    /** Get reorganization history. Returns { operations: ReorgOperation[] }. */
    getHistory: () => ipcRenderer.invoke("prompt-reorg:get-history"),
    /** Undo a past operation by ID. Returns { restored, errors }. */
    undo: (operationId) => ipcRenderer.invoke("prompt-reorg:undo", operationId),
    /** Full pipeline: scan + analyze + reasons + preview. Emits prompt-reorg:progress events. */
    runPipeline: (userPrompt, targetDirectory) =>
      ipcRenderer.invoke("prompt-reorg:run-pipeline", userPrompt, targetDirectory),
  },

  // ── Undo Log ──────────────────────────────────────────
  undoLog: {
    /** Get all undo operations (last 50). */
    get: () => ipcRenderer.invoke("undo-log:get"),
    /** Undo an operation by ID. Returns { restored, skipped, errors }. */
    undo: (operationId) => ipcRenderer.invoke("undo-log:undo", operationId),
    /** Clear all undo history. */
    clear: () => ipcRenderer.invoke("undo-log:clear"),
  },

  // ── Organization Templates ────────────────────────────
  templates: {
    /** Get all templates, optionally filtered by category. Sorted by popularity. */
    getAll: (category) => ipcRenderer.invoke("templates:get-all", category),
    /** Increment popularity counter for a template. */
    use: (templateId) => ipcRenderer.invoke("templates:use", templateId),
    /** Save a user-created custom template. */
    saveCustom: (name, prompt, icon, category) =>
      ipcRenderer.invoke("templates:save-custom", name, prompt, icon, category),
    /** Delete a custom template. */
    deleteCustom: (id) => ipcRenderer.invoke("templates:delete-custom", id),
  },

  // ── AI Health ─────────────────────────────────────────
  aiHealth: {
    /** Get current AI engine status. */
    status: () => ipcRenderer.invoke("ai:status"),
  },

  // ── Events from main process ─────────────────────────
  on: {
    updateAvailable: (callback) =>
      ipcRenderer.on("update-available", () => callback()),
    updateDownloaded: (callback) =>
      ipcRenderer.on("update-downloaded", () => callback()),
    ollamaError: (callback) =>
      ipcRenderer.on("ollama-error", (_e, msg) => callback(msg)),
    /** Ollama couldn't load any model due to low RAM — show friendly banner. */
    ollamaLowRam: (callback) =>
      ipcRenderer.on("ollama-low-ram", (_e, data) => callback(data)),
    /** Ollama retry succeeded — model is now loaded. */
    ollamaModelReady: (callback) =>
      ipcRenderer.on("ollama-model-ready", (_e, data) => callback(data)),
    /** Deep Dive progress: emitted during fetchDeepRecursiveSearch. */
    deepDiveProgress: (callback) => {
      ipcRenderer.removeAllListeners("deep-dive-progress");
      ipcRenderer.on("deep-dive-progress", (_e, current, target) => callback(current, target));
    },
    /** Chat: progress while reading full file contents for retrieval. */
    chatReadingFiles: (callback) => {
      ipcRenderer.removeAllListeners("chat:reading-files");
      ipcRenderer.on("chat:reading-files", (_e, progress) => callback(progress));
    },
    /** Chat: receive a streamed token from the AI response. */
    chatToken: (callback) => {
      ipcRenderer.removeAllListeners("chat:token");
      ipcRenderer.on("chat:token", (_e, token) => callback(token));
    },
    /** Chat: AI has finished streaming its response. */
    chatDone: (callback) => {
      ipcRenderer.removeAllListeners("chat:done");
      ipcRenderer.on("chat:done", () => callback());
    },
    /** Chat: an error occurred during streaming. */
    chatError: (callback) => {
      ipcRenderer.removeAllListeners("chat:error");
      ipcRenderer.on("chat:error", (_e, msg) => callback(msg));
    },
    /**
     * Chat: source files used to generate the answer.
     * Fired after chat:done. Payload: (sources[], query)
     * sources: Array<{ filename, folder, fullPath, snippet }>
     */
    chatSources: (callback) => {
      ipcRenderer.removeAllListeners("chat:sources");
      ipcRenderer.on("chat:sources", (_e, sources, query) => callback(sources, query));
    },
    /** Reindex progress: fired for each file during chat:reindex-all. */
    reindexProgress: (callback) => {
      ipcRenderer.removeAllListeners("chat:reindex-progress");
      ipcRenderer.on("chat:reindex-progress", (_e, progress) => callback(progress));
    },
    /** Watcher: a file was auto-organized in the background. */
    watcherOrganized: (callback) => {
      ipcRenderer.removeAllListeners("watcher:file-organized");
      ipcRenderer.on("watcher:file-organized", (_e, event) => callback(event));
    },
    /** Watcher: a file finished writing and its 5-minute countdown has begun. */
    watcherCountdownStarted: (callback) => {
      ipcRenderer.removeAllListeners("watcher:countdown-started");
      ipcRenderer.on("watcher:countdown-started", (_e, data) => callback(data));
    },
    /**
     * Watcher: confidence < 80% with two plausible categories.
     * The main process asks the renderer to show the disambiguation prompt.
     * Payload: { filename, filePath, catA, catAKeywords, catAConfidence,
     *            catB, catBKeywords, catBConfidence, reasoning }
     */
    watcherNeedsDisambiguation: (callback) => {
      ipcRenderer.removeAllListeners("watcher:needs-disambiguation");
      ipcRenderer.on("watcher:needs-disambiguation", (_e, data) => callback(data));
    },
    /** Background learner status push: { running, paused, filesProcessed, termsAdded, currentFolder }. */
    learnerStatus: (callback) => {
      ipcRenderer.removeAllListeners("learner:status");
      ipcRenderer.on("learner:status", (_e, status) => callback(status));
    },
    /** Knowledge Graph: progress update during rebuild. */
    knowledgeGraphProgress: (callback) => {
      ipcRenderer.removeAllListeners("knowledge-graph:progress");
      ipcRenderer.on("knowledge-graph:progress", (_e, progress) => callback(progress));
    },
    /** Cloud Sync: progress update during bulk sync. */
    cloudSyncProgress: (callback) => {
      ipcRenderer.removeAllListeners("cloud:sync-progress");
      ipcRenderer.on("cloud:sync-progress", (_e, current, total) => callback(current, total));
    },
    /** Menu bar actions (keyboard shortcuts, menu clicks). */
    menuAction: (callback) => {
      ipcRenderer.removeAllListeners("menu:action");
      ipcRenderer.on("menu:action", (_e, action) => callback(action));
    },
    /** Model pull progress: { pct, model } — fired during first-launch download. */
    modelPullProgress: (callback) => {
      ipcRenderer.removeAllListeners("model:pull-progress");
      ipcRenderer.on("model:pull-progress", (_e, data) => callback(data));
    },
    /** Model pull completed successfully: { model }. */
    modelPullDone: (callback) => {
      ipcRenderer.removeAllListeners("model:pull-done");
      ipcRenderer.on("model:pull-done", (_e, data) => callback(data));
    },
    /** Model pull failed: { error, model }. */
    modelPullError: (callback) => {
      ipcRenderer.removeAllListeners("model:pull-error");
      ipcRenderer.on("model:pull-error", (_e, data) => callback(data));
    },
    /** Model needs to be downloaded (sent after Ollama starts, model not cached): { model, tier }. */
    modelNeedsDownload: (callback) => {
      ipcRenderer.removeAllListeners("model:needs-download");
      ipcRenderer.on("model:needs-download", (_e, data) => callback(data));
    },
    /**
     * Search index background upgrade progress.
     * Payload: { current, total, done? }
     * When done === true, upgrade is complete.
     */
    searchUpgradeProgress: (callback) => {
      ipcRenderer.removeAllListeners("search:upgrade-progress");
      ipcRenderer.on("search:upgrade-progress", (_e, data) => callback(data));
    },
    /**
     * Prompt reorg pipeline progress.
     * Payload: { stage, pct, message, batchCurrent?, batchTotal? }
     */
    promptReorgProgress: (callback) => {
      ipcRenderer.removeAllListeners("prompt-reorg:progress");
      ipcRenderer.on("prompt-reorg:progress", (_e, data) => callback(data));
    },
    /**
     * Prompt reorg executed — fired after execute completes.
     * Payload: { moved, failed, operationId, undoLogId, prompt }
     */
    promptReorgExecuted: (callback) => {
      ipcRenderer.removeAllListeners("prompt-reorg:executed");
      ipcRenderer.on("prompt-reorg:executed", (_e, data) => callback(data));
    },
    /** AI engine is attempting a restart after health check failure. */
    aiRestarting: (callback) => {
      ipcRenderer.removeAllListeners("ai:restarting");
      ipcRenderer.on("ai:restarting", () => callback());
    },
    /** AI engine recovered after restart. */
    aiRecovered: (callback) => {
      ipcRenderer.removeAllListeners("ai:recovered");
      ipcRenderer.on("ai:recovered", () => callback());
    },
    /** AI engine failed after max restart attempts. Payload: { message }. */
    aiFailed: (callback) => {
      ipcRenderer.removeAllListeners("ai:failed");
      ipcRenderer.on("ai:failed", (_e, data) => callback(data));
    },
    /** PDF summary workflow completed. Payload: { filename, sourcePath, summaryPath }. */
    pdfSummaryDone: (callback) => {
      ipcRenderer.removeAllListeners("workflow:pdf-summary-done");
      ipcRenderer.on("workflow:pdf-summary-done", (_e, data) => callback(data));
    },
  },

  // ── Workflow Engine ──────────────────────────────────
  workflows: {
    /** Get whether the auto-summarize PDF workflow is enabled. */
    getPdfSummaryEnabled: () =>
      ipcRenderer.invoke("workflow:get-pdf-summary-enabled"),
    /** Enable or disable the auto-summarize PDF workflow. */
    setPdfSummaryEnabled: (enabled) =>
      ipcRenderer.invoke("workflow:set-pdf-summary-enabled", enabled),
  },

  // ── Prompt Enhancer ──────────────────────────────────
  promptEnhancer: {
    /**
     * Enhance a prompt using context from the user's local files.
     * Pass an optional namespaceId to force a specific context scope.
     * Returns { enhanced, namespaceId?, namespaceName?, error? }.
     */
    enhance: (userPrompt, namespaceId) =>
      ipcRenderer.invoke("prompt:enhance", userPrompt, namespaceId || null),
  },

  // ── Namespace isolation ───────────────────────────────
  namespace: {
    /** List all known namespaces (id, label, color, entityNames, ...). */
    list: () => ipcRenderer.invoke("namespace:list"),
    /** Get folder→namespace assignment map. */
    folderAssignments: () => ipcRenderer.invoke("namespace:folder-assignments"),
    /** Create or update a namespace manually. */
    upsert: (id, label, color, entityNames) =>
      ipcRenderer.invoke("namespace:upsert", id, label, color, entityNames),
    /** Assign a folder to a namespace. */
    assignFolder: (folderName, namespaceId) =>
      ipcRenderer.invoke("namespace:assign-folder", folderName, namespaceId),
    /**
     * Auto-detect namespaces from the knowledge graph.
     * Call after file organization to keep namespaces up to date.
     */
    sync: () => ipcRenderer.invoke("namespace:sync"),
  },
});
