/**
 * AIHealthService.ts — Monitors the on-device AI engine (LlamaService).
 *
 * Runs a health check every 30 seconds. If the engine is unresponsive,
 * attempts a re-initialize. After 3 failed restarts, notifies the renderer
 * with a user-friendly (no jargon) error message.
 */

import { BrowserWindow } from "electron";

// ── Types ──────────────────────────────────────────────────────

export interface AIStatus {
  running: boolean;
  modelReady: boolean;
  modelName: string;
  lastChecked: string;
  restartAttempts: number;
}

// ── State ──────────────────────────────────────────────────────

let _status: AIStatus = {
  running: false,
  modelReady: false,
  modelName: "unknown",
  lastChecked: new Date().toISOString(),
  restartAttempts: 0,
};

let _healthInterval: ReturnType<typeof setInterval> | null = null;
const MAX_RESTART_ATTEMPTS = 3;
const HEALTH_INTERVAL_MS = 30_000;

// ── Internal ───────────────────────────────────────────────────

function getWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows();
  return wins.length > 0 && !wins[0].isDestroyed() ? wins[0] : null;
}

function sendStatus(event: string, payload?: unknown): void {
  const win = getWindow();
  if (win) win.webContents.send(event, payload);
}

async function checkLlama(): Promise<boolean> {
  try {
    const LlamaService = require("./LlamaService");
    return LlamaService.isReady();
  } catch {
    return false;
  }
}

async function tryRestart(): Promise<boolean> {
  try {
    const LlamaService = require("./LlamaService");
    const result = await LlamaService.initialize();
    return result?.success === true;
  } catch {
    return false;
  }
}

async function runHealthCheck(): Promise<void> {
  const ready = await checkLlama();
  _status.lastChecked = new Date().toISOString();
  _status.modelReady = ready;
  _status.running = ready;

  if (!ready) {
    _status.restartAttempts++;
    console.warn(`[AIHealth] Model not ready — restart attempt ${_status.restartAttempts}/${MAX_RESTART_ATTEMPTS}`);

    if (_status.restartAttempts <= MAX_RESTART_ATTEMPTS) {
      sendStatus("ai:restarting");
      const ok = await tryRestart();
      if (ok) {
        _status.restartAttempts = 0;
        _status.modelReady = true;
        _status.running = true;
        sendStatus("ai:recovered");
        console.log("[AIHealth] Model recovered after restart.");
      } else if (_status.restartAttempts >= MAX_RESTART_ATTEMPTS) {
        sendStatus("ai:failed", {
          message: "The AI engine hit a snag. Try restarting the app.",
        });
        console.error("[AIHealth] Model could not recover after 3 attempts.");
        stopHealthMonitor();
      }
    }
  } else {
    _status.restartAttempts = 0;
  }
}

// ── Public API ─────────────────────────────────────────────────

/** Start periodic health monitoring. Call once after model initializes. */
export function startHealthMonitor(): void {
  if (_healthInterval) return;
  _status.modelReady = true;
  _status.running = true;
  _status.restartAttempts = 0;
  _healthInterval = setInterval(runHealthCheck, HEALTH_INTERVAL_MS);
  console.log("[AIHealth] Health monitor started (30s interval).");
}

/** Stop health monitoring (e.g., on app quit). */
export function stopHealthMonitor(): void {
  if (_healthInterval) {
    clearInterval(_healthInterval);
    _healthInterval = null;
  }
}

/** Get current AI status snapshot. */
export function getAIStatus(): AIStatus {
  return { ..._status };
}

/** Mark model as ready (called from main process after successful initialize). */
export function markModelReady(modelName?: string): void {
  _status.modelReady = true;
  _status.running = true;
  _status.restartAttempts = 0;
  if (modelName) _status.modelName = modelName;
  _status.lastChecked = new Date().toISOString();
}

/** Mark model as not ready (called on error). */
export function markModelError(): void {
  _status.modelReady = false;
  _status.running = false;
  _status.lastChecked = new Date().toISOString();
}
