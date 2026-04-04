/**
 * EngineManager — Spawns and babysits the local AI inference process.
 *
 * Features:
 *   - Tiered RAM-based model selection (never hard-fails due to memory)
 *   - Auto-restart on crash (2s delay, max 5 consecutive failures)
 *   - Clean shutdown on app quit
 *   - Retry without restarting the app
 *
 * RAM Tiers (free RAM at launch time):
 *   ≥ 4 GB   → llama3.2:3b  (best quality)
 *   1.5–4 GB → llama3.2:1b  (good quality, lighter)
 *   0.6–1.5 GB → llama3.1:8b-instruct-q2_K (ultra-low quantized)
 *   < 0.6 GB → rules-only mode (Bullseye + keyword matching, no AI)
 */

const { spawn, execSync } = require("child_process");
const os   = require("os");
const http = require("http");
const { getEnginePath } = require("./ollamaPath");

// ── Timing ─────────────────────────────────────────────────────────────────
const RESTART_DELAY_MS       = 2000;
const MAX_CONSECUTIVE_CRASHES = 5;
const HEALTH_CHECK_INTERVAL_MS = 15000;

// ── RAM thresholds (MB free RAM required per tier) ──────────────────────────
const RAM_TIER_HIGH_MB = 4096;   // ≥ 4 GB → 3b
const RAM_TIER_MED_MB  = 1536;   // 1.5–4 GB → 1b
const RAM_TIER_LOW_MB  = 600;    // 0.6–1.5 GB → quantized
// < RAM_TIER_LOW_MB → rules-only (Ollama would crash trying to load any model)

// ── Model identifiers ───────────────────────────────────────────────────────
const MODEL_3B        = "llama3.2:3b";
const MODEL_1B        = "llama3.2:1b";
const MODEL_QUANTIZED = "llama3.1:8b-instruct-q2_K";

/**
 * Pick the best model for the current free RAM.
 * Returns { model, tier, rulesOnly }.
 */
function selectModelForRam(freeMB) {
  if (freeMB >= RAM_TIER_HIGH_MB) return { model: MODEL_3B,        tier: "high",  rulesOnly: false };
  if (freeMB >= RAM_TIER_MED_MB)  return { model: MODEL_1B,        tier: "medium", rulesOnly: false };
  if (freeMB >= RAM_TIER_LOW_MB)  return { model: MODEL_QUANTIZED, tier: "low",   rulesOnly: false };
  return { model: null, tier: "none", rulesOnly: true };
}

class EngineManager {
  constructor() {
    this._proc          = null;
    this._alive         = false;
    this._stopping      = false;
    this._crashCount    = 0;
    this._healthTimer   = null;
    this._selectedModel = null;   // set by start() / retry()
    this._rulesOnly     = false;  // true if RAM too low for any model
    this._tier          = "none"; // "high" | "medium" | "low" | "none"
  }

  // ── Resource detection ─────────────────────────────────────────────────────

  /**
   * Returns { totalMB, freeMB, gpuAvailable, gpuName }.
   */
  checkResources() {
    const totalMB = Math.round(os.totalmem() / (1024 * 1024));
    const freeMB  = Math.round(os.freemem()  / (1024 * 1024));

    let gpuAvailable = false;
    let gpuName = "none";

    if (process.platform === "darwin") {
      try {
        const out = execSync("system_profiler SPDisplaysDataType", {
          encoding: "utf8", timeout: 5000,
        });
        if (out.includes("Metal")) {
          gpuAvailable = true;
          const match = out.match(/Chipset Model:\s*(.+)/i);
          gpuName = match ? match[1].trim() : "Metal GPU";
        }
      } catch { /* unavailable */ }
    } else if (process.platform === "linux" || process.platform === "win32") {
      try {
        const out = execSync("nvidia-smi --query-gpu=name --format=csv,noheader", {
          encoding: "utf8", timeout: 5000,
        });
        if (out.trim()) { gpuAvailable = true; gpuName = out.trim().split("\n")[0]; }
      } catch { /* no NVIDIA */ }
    }

    return { totalMB, freeMB, gpuAvailable, gpuName };
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  /** Returns the model name that was (or will be) loaded, or null in rules-only mode. */
  getSelectedModel() { return this._selectedModel; }

  /** True when RAM is too low for any model — app runs with rules-based classification only. */
  isRulesOnly() { return this._rulesOnly; }

  /** "high" | "medium" | "low" | "none" */
  getTier() { return this._tier; }

  /** Check if the server is currently running. */
  isRunning() { return this._alive; }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Start the Ollama server using the RAM-appropriate model tier.
   *
   * Never throws for RAM issues — callers should check isRulesOnly() after
   * awaiting start() to know whether AI is available.
   *
   * Returns { model, tier, rulesOnly }.
   */
  async start() {
    if (this._alive) return { model: this._selectedModel, tier: this._tier, rulesOnly: false };

    const res = this.checkResources();
    const { model, tier, rulesOnly } = selectModelForRam(res.freeMB);

    this._tier = tier;

    if (rulesOnly) {
      // Not enough RAM for any model — flag rules-only mode and return without throwing
      this._rulesOnly     = true;
      this._selectedModel = null;
      console.warn(
        `[Engine] Only ${res.freeMB} MB free RAM — all AI models require at least ${RAM_TIER_LOW_MB} MB. ` +
        `Running in rules-only mode (Bullseye + keyword matching still works).`
      );
      return { model: null, tier: "none", rulesOnly: true };
    }

    this._rulesOnly     = false;
    this._selectedModel = model;

    console.log(
      `[Engine] RAM tier: ${tier} (${res.freeMB} MB free) → loading ${model}`
    );

    this._stopping   = false;
    this._crashCount = 0;

    await this._spawn();
    this._startHealthCheck();

    return { model, tier, rulesOnly: false };
  }

  /**
   * Re-attempt model loading without restarting the app.
   * Called when the user clicks "Retry AI" in the UI.
   * Returns { success, model, tier, rulesOnly, error? }.
   */
  async retry() {
    // Stop any existing process first
    if (this._alive || this._proc) {
      this.stop();
      await new Promise((r) => setTimeout(r, 1500)); // wait for process to die
    }
    this._alive = false;

    try {
      const result = await this.start();
      return { success: !result.rulesOnly, ...result };
    } catch (err) {
      return { success: false, model: null, tier: "none", rulesOnly: true, error: err.message };
    }
  }

  /**
   * Gracefully stop Ollama. Kills the process, clears timers.
   */
  stop() {
    this._stopping = true;
    this._clearHealthCheck();

    if (this._proc) {
      this._proc.kill("SIGTERM");
      setTimeout(() => {
        if (this._proc) {
          try { this._proc.kill("SIGKILL"); } catch { /* already dead */ }
        }
      }, 3000);
    }

    this._alive = false;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  async _spawn() {
    const binPath = getEnginePath();

    return new Promise((resolve, reject) => {
      const appRef    = require("electron").app;
      const modelsDir = appRef.isPackaged
        ? require("path").join(appRef.getPath("userData"), "models")
        : require("path").join(appRef.getAppPath(), "resources", "models");

      const proc = spawn(binPath, ["serve"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, OLLAMA_MODELS: modelsDir },
      });

      this._proc = proc;

      proc.stdout.on("data", (data) => {
        const msg = data.toString();
        if (msg.includes("Listening on")) {
          this._alive      = true;
          this._crashCount = 0;
          resolve();
        }
      });

      proc.stderr.on("data", (data) => {
        const msg = data.toString();

        // Detect RAM-related runtime failure even after the process starts
        const isOomError = /out of memory|not enough memory|cannot allocate/i.test(msg);
        if (isOomError && !this._rulesOnly) {
          console.warn(`[Engine] OOM detected at runtime — falling back to rules-only mode`);
          this._rulesOnly     = true;
          this._selectedModel = null;
        }

        if (msg.includes("Listening on") || msg.includes("listening on")) {
          this._alive      = true;
          this._crashCount = 0;
          resolve();
        }
      });

      proc.on("error", (err) => {
        this._alive = false;
        if (!this._stopping) {
          console.error(`[Engine] Spawn error: ${err.message}`);
          reject(err);
        }
      });

      proc.on("exit", (code, signal) => {
        this._alive = false;
        this._proc  = null;

        if (this._stopping) return;

        this._crashCount++;
        console.warn(
          `[Engine] Process exited (code=${code}, signal=${signal}). ` +
          `Crash #${this._crashCount}/${MAX_CONSECUTIVE_CRASHES}`
        );

        if (this._crashCount < MAX_CONSECUTIVE_CRASHES) {
          setTimeout(() => {
            if (!this._stopping) {
              console.log("[Engine] Restarting...");
              this._spawn().catch((e) =>
                console.error(`[Engine] Restart failed: ${e.message}`)
              );
            }
          }, RESTART_DELAY_MS);
        } else {
          console.error(`[Engine] Max consecutive crashes reached. Giving up.`);
        }
      });

      // Resolve after 10 s even if "Listening" line never appears
      setTimeout(() => {
        if (!this._alive && this._proc) {
          this._alive = true;
          resolve();
        }
      }, 10000);
    });
  }

  _startHealthCheck() {
    this._clearHealthCheck();
    this._healthTimer = setInterval(() => {
      if (!this._alive || this._stopping) return;
      const req = http.get(
        "http://127.0.0.1:11434/api/tags",
        { timeout: 5000 },
        (res) => { res.resume(); }
      );
      req.on("error", () => console.warn("[Engine] Health check failed"));
      req.on("timeout",  () => req.destroy());
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  _clearHealthCheck() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }
}

// Backward-compatible export
module.exports = { EngineManager, OllamaManager: EngineManager };
