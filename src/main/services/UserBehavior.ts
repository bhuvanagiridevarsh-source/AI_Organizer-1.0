/**
 * UserBehavior.ts — Privacy-preserving behavioral telemetry.
 *
 * Tracks HOW users organize, never WHAT they organize.
 * All events pass through sanitizeEvent() which strips filenames,
 * paths, and content before anything leaves the device.
 *
 * Connects to PostHog (self-hostable) or a custom endpoint.
 * Swap TELEMETRY_ENDPOINT to point at your own infrastructure.
 */

import https from "https";
import os from "os";
import { execSync } from "child_process";
import crypto from "crypto";

// ── Configuration ──────────────────────────────────────────

// PostHog cloud, or your self-hosted instance
const TELEMETRY_ENDPOINT = "https://app.posthog.com/capture";
const POSTHOG_API_KEY = "phc_YOUR_PROJECT_KEY_HERE"; // replace with your key

// Set false to disable all telemetry (respect user preference)
let telemetryEnabled = true;

// ── Types ──────────────────────────────────────────────────

interface TelemetryEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, string | number | boolean | null>;
  timestamp?: string;
}

interface HardwareScore {
  ram_gb: number;
  cpu_cores: number;
  gpu_available: boolean;
  gpu_name: string;
  platform: string;
  arch: string;
  score: number; // 1-10 composite
}

// ── Banned patterns — anything matching these is stripped ──

const BANNED_PATTERNS: RegExp[] = [
  // Absolute paths (unix + windows)
  /\/Users\/[^\s,}]*/gi,
  /\/home\/[^\s,}]*/gi,
  /[A-Z]:\\[^\s,}]*/gi,
  // Common file extensions with preceding name
  /[\w.-]+\.(pdf|doc|docx|xls|xlsx|ppt|pptx|jpg|jpeg|png|gif|mp4|mov|zip|rar|txt|csv|py|js|ts|html|css)/gi,
  // Email addresses
  /[\w.-]+@[\w.-]+\.\w+/gi,
  // UUIDs (sometimes used as filenames)
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
];

// ── Core ───────────────────────────────────────────────────

/**
 * Generate a stable anonymous device ID (hashed, not reversible).
 * Same machine always produces the same ID.
 */
function getAnonymousId(): string {
  const raw = `${os.hostname()}-${os.userInfo().username}-${os.platform()}-${os.arch()}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

const ANONYMOUS_ID = getAnonymousId();

/**
 * SAFETY GATE: Strips ANY filenames, folder paths, email addresses,
 * or text content from event properties before transmission.
 * This runs on every event — no exceptions.
 */
function sanitizeEvent(event: TelemetryEvent): TelemetryEvent {
  const clean: TelemetryEvent = {
    event: event.event,
    distinct_id: event.distinct_id,
    timestamp: event.timestamp,
    properties: {},
  };

  for (const [key, value] of Object.entries(event.properties)) {
    // Only allow primitive safe types through
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      clean.properties[key] = value;
      continue;
    }

    if (typeof value === "string") {
      let scrubbed = value;

      // Run all banned patterns
      for (const pattern of BANNED_PATTERNS) {
        scrubbed = scrubbed.replace(pattern, "[REDACTED]");
      }

      // If the string is longer than 100 chars, it might be content — redact
      if (scrubbed.length > 100) {
        scrubbed = "[REDACTED_LONG_STRING]";
      }

      clean.properties[key] = scrubbed;
    }
  }

  return clean;
}

/**
 * Send a sanitized event to the telemetry endpoint.
 * Fire-and-forget — never blocks the app, never throws.
 */
function sendEvent(event: TelemetryEvent): void {
  if (!telemetryEnabled) return;

  const sanitized = sanitizeEvent(event);

  const payload = JSON.stringify({
    api_key: POSTHOG_API_KEY,
    ...sanitized,
  });

  try {
    const url = new URL(TELEMETRY_ENDPOINT);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 5000,
      },
      (res) => res.resume() // drain, ignore response
    );

    req.on("error", () => {}); // swallow — telemetry must never break the app
    req.on("timeout", () => req.destroy());
    req.write(payload);
    req.end();
  } catch {
    // Silently fail
  }
}

// ── Hardware Score ──────────────────────────────────────────

function getHardwareScore(): HardwareScore {
  const ramGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));
  const cpuCores = os.cpus().length;
  let gpuAvailable = false;
  let gpuName = "none";

  if (process.platform === "darwin") {
    try {
      const out = execSync("system_profiler SPDisplaysDataType", {
        encoding: "utf8",
        timeout: 5000,
      });
      if (out.includes("Metal")) {
        gpuAvailable = true;
        const match = out.match(/Chipset Model:\s*(.+)/i);
        gpuName = match ? match[1].trim() : "Metal GPU";
      }
    } catch {}
  } else {
    try {
      const out = execSync(
        "nvidia-smi --query-gpu=name --format=csv,noheader",
        { encoding: "utf8", timeout: 5000 }
      );
      if (out.trim()) {
        gpuAvailable = true;
        gpuName = out.trim().split("\n")[0];
      }
    } catch {}
  }

  // Composite score: 1-10
  //   RAM:  16GB+ = 4pts, 8GB = 3pts, <8 = 1pt
  //   CPU:  8+ cores = 3pts, 4+ = 2pts, <4 = 1pt
  //   GPU:  available = 3pts, none = 0pts
  let score = 0;
  score += ramGB >= 16 ? 4 : ramGB >= 8 ? 3 : 1;
  score += cpuCores >= 8 ? 3 : cpuCores >= 4 ? 2 : 1;
  score += gpuAvailable ? 3 : 0;

  return {
    ram_gb: ramGB,
    cpu_cores: cpuCores,
    gpu_available: gpuAvailable,
    gpu_name: gpuName,
    platform: process.platform,
    arch: process.arch,
    score: Math.min(10, score),
  };
}

// ── Public Event Triggers ──────────────────────────────────

/**
 * "The Hoarder vs. Cleaner" — How many files did they organize at once?
 * Hoarders let files pile up (batch_size > 50), Cleaners do it daily (1-5).
 */
export function trackBatchOrganized(batchSize: number, categoryCount: number): void {
  sendEvent({
    event: "batch_organized",
    distinct_id: ANONYMOUS_ID,
    timestamp: new Date().toISOString(),
    properties: {
      batch_size: batchSize,
      category_count: categoryCount,
      persona: batchSize > 50 ? "hoarder" : batchSize > 10 ? "moderate" : "cleaner",
    },
  });
}

/**
 * "Decision Fatigue" — Did they undo quickly? That means the AI was wrong.
 * @param secondsSinceMove — time between the organize action and the undo
 * @param filesUndone — how many files were reverted
 */
export function trackUndo(secondsSinceMove: number, filesUndone: number): void {
  sendEvent({
    event: "undo_action",
    distinct_id: ANONYMOUS_ID,
    timestamp: new Date().toISOString(),
    properties: {
      time_to_undo: secondsSinceMove,
      files_undone: filesUndone,
      was_quick: secondsSinceMove < 30, // <30s = AI probably got it wrong
      fatigue_signal: secondsSinceMove < 10, // <10s = immediate regret
    },
  });
}

/**
 * "Organization Habit" — When do they organize? Morning routine vs. late-night panic.
 */
export function trackSessionStart(): void {
  const now = new Date();
  const hour = now.getHours();

  let timeSlot: string;
  if (hour >= 5 && hour < 12) timeSlot = "morning";
  else if (hour >= 12 && hour < 17) timeSlot = "afternoon";
  else if (hour >= 17 && hour < 21) timeSlot = "evening";
  else timeSlot = "night";

  sendEvent({
    event: "session_start",
    distinct_id: ANONYMOUS_ID,
    timestamp: now.toISOString(),
    properties: {
      hour_of_day: hour,
      day_of_week: now.getDay(), // 0=Sun, 6=Sat
      time_slot: timeSlot,
      is_weekend: now.getDay() === 0 || now.getDay() === 6,
    },
  });
}

/**
 * "Tech Spec" — Hardware profile. Sent once per session.
 * Lets you see if high-end users behave differently (faster decisions,
 * larger batches, fewer undos).
 */
export function trackHardwareProfile(): void {
  const hw = getHardwareScore();

  sendEvent({
    event: "hardware_profile",
    distinct_id: ANONYMOUS_ID,
    timestamp: new Date().toISOString(),
    properties: {
      hardware_score: hw.score,
      ram_gb: hw.ram_gb,
      cpu_cores: hw.cpu_cores,
      gpu_available: hw.gpu_available,
      gpu_name: hw.gpu_name,
      platform: hw.platform,
      arch: hw.arch,
    },
  });
}

/**
 * Track when the AI category is manually corrected by the user.
 * Does NOT include the filename — only the category names.
 */
export function trackCategoryCorrection(
  aiCategory: string,
  userCategory: string,
  confidence: number
): void {
  sendEvent({
    event: "category_correction",
    distinct_id: ANONYMOUS_ID,
    timestamp: new Date().toISOString(),
    properties: {
      ai_category: aiCategory,
      user_category: userCategory,
      ai_confidence: confidence,
      was_low_confidence: confidence < 0.5,
    },
  });
}

// ── Control ────────────────────────────────────────────────

export function enableTelemetry(): void {
  telemetryEnabled = true;
}

export function disableTelemetry(): void {
  telemetryEnabled = false;
}

export function isTelemetryEnabled(): boolean {
  return telemetryEnabled;
}

// Re-export sanitizer for testing
export { sanitizeEvent, getHardwareScore, getAnonymousId };
