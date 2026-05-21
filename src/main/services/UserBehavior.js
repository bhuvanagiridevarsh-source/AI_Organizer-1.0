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
var UserBehavior_exports = {};
__export(UserBehavior_exports, {
  disableTelemetry: () => disableTelemetry,
  enableTelemetry: () => enableTelemetry,
  getAnonymousId: () => getAnonymousId,
  getHardwareScore: () => getHardwareScore,
  isTelemetryEnabled: () => isTelemetryEnabled,
  sanitizeEvent: () => sanitizeEvent,
  trackBatchOrganized: () => trackBatchOrganized,
  trackCategoryCorrection: () => trackCategoryCorrection,
  trackHardwareProfile: () => trackHardwareProfile,
  trackSessionStart: () => trackSessionStart,
  trackUndo: () => trackUndo
});
module.exports = __toCommonJS(UserBehavior_exports);
var import_https = __toESM(require("https"));
var import_os = __toESM(require("os"));
var import_child_process = require("child_process");
var import_crypto = __toESM(require("crypto"));
const TELEMETRY_ENDPOINT = "https://app.posthog.com/capture";
const POSTHOG_API_KEY = "phc_YOUR_PROJECT_KEY_HERE";
let telemetryEnabled = true;
const BANNED_PATTERNS = [
  // Absolute paths (unix + windows)
  /\/Users\/[^\s,}]*/gi,
  /\/home\/[^\s,}]*/gi,
  /[A-Z]:\\[^\s,}]*/gi,
  // Common file extensions with preceding name
  /[\w.-]+\.(pdf|doc|docx|xls|xlsx|ppt|pptx|jpg|jpeg|png|gif|mp4|mov|zip|rar|txt|csv|py|js|ts|html|css)/gi,
  // Email addresses
  /[\w.-]+@[\w.-]+\.\w+/gi,
  // UUIDs (sometimes used as filenames)
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
];
function getAnonymousId() {
  const raw = `${import_os.default.hostname()}-${import_os.default.userInfo().username}-${import_os.default.platform()}-${import_os.default.arch()}`;
  return import_crypto.default.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}
const ANONYMOUS_ID = getAnonymousId();
function sanitizeEvent(event) {
  const clean = {
    event: event.event,
    distinct_id: event.distinct_id,
    timestamp: event.timestamp,
    properties: {}
  };
  for (const [key, value] of Object.entries(event.properties)) {
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      clean.properties[key] = value;
      continue;
    }
    if (typeof value === "string") {
      let scrubbed = value;
      for (const pattern of BANNED_PATTERNS) {
        scrubbed = scrubbed.replace(pattern, "[REDACTED]");
      }
      if (scrubbed.length > 100) {
        scrubbed = "[REDACTED_LONG_STRING]";
      }
      clean.properties[key] = scrubbed;
    }
  }
  return clean;
}
function sendEvent(event) {
  if (!telemetryEnabled) return;
  const sanitized = sanitizeEvent(event);
  const payload = JSON.stringify({
    api_key: POSTHOG_API_KEY,
    ...sanitized
  });
  try {
    const url = new URL(TELEMETRY_ENDPOINT);
    const req = import_https.default.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 5e3
      },
      (res) => res.resume()
      // drain, ignore response
    );
    req.on("error", () => {
    });
    req.on("timeout", () => req.destroy());
    req.write(payload);
    req.end();
  } catch {
  }
}
function getHardwareScore() {
  const ramGB = Math.round(import_os.default.totalmem() / (1024 * 1024 * 1024));
  const cpuCores = import_os.default.cpus().length;
  let gpuAvailable = false;
  let gpuName = "none";
  if (process.platform === "darwin") {
    try {
      const out = (0, import_child_process.execSync)("system_profiler SPDisplaysDataType", {
        encoding: "utf8",
        timeout: 5e3
      });
      if (out.includes("Metal")) {
        gpuAvailable = true;
        const match = out.match(/Chipset Model:\s*(.+)/i);
        gpuName = match ? match[1].trim() : "Metal GPU";
      }
    } catch {
    }
  } else {
    try {
      const out = (0, import_child_process.execSync)(
        "nvidia-smi --query-gpu=name --format=csv,noheader",
        { encoding: "utf8", timeout: 5e3 }
      );
      if (out.trim()) {
        gpuAvailable = true;
        gpuName = out.trim().split("\n")[0];
      }
    } catch {
    }
  }
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
    score: Math.min(10, score)
  };
}
function trackBatchOrganized(batchSize, categoryCount) {
  sendEvent({
    event: "batch_organized",
    distinct_id: ANONYMOUS_ID,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    properties: {
      batch_size: batchSize,
      category_count: categoryCount,
      persona: batchSize > 50 ? "hoarder" : batchSize > 10 ? "moderate" : "cleaner"
    }
  });
}
function trackUndo(secondsSinceMove, filesUndone) {
  sendEvent({
    event: "undo_action",
    distinct_id: ANONYMOUS_ID,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    properties: {
      time_to_undo: secondsSinceMove,
      files_undone: filesUndone,
      was_quick: secondsSinceMove < 30,
      // <30s = AI probably got it wrong
      fatigue_signal: secondsSinceMove < 10
      // <10s = immediate regret
    }
  });
}
function trackSessionStart() {
  const now = /* @__PURE__ */ new Date();
  const hour = now.getHours();
  let timeSlot;
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
      day_of_week: now.getDay(),
      // 0=Sun, 6=Sat
      time_slot: timeSlot,
      is_weekend: now.getDay() === 0 || now.getDay() === 6
    }
  });
}
function trackHardwareProfile() {
  const hw = getHardwareScore();
  sendEvent({
    event: "hardware_profile",
    distinct_id: ANONYMOUS_ID,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    properties: {
      hardware_score: hw.score,
      ram_gb: hw.ram_gb,
      cpu_cores: hw.cpu_cores,
      gpu_available: hw.gpu_available,
      gpu_name: hw.gpu_name,
      platform: hw.platform,
      arch: hw.arch
    }
  });
}
function trackCategoryCorrection(aiCategory, userCategory, confidence) {
  sendEvent({
    event: "category_correction",
    distinct_id: ANONYMOUS_ID,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    properties: {
      ai_category: aiCategory,
      user_category: userCategory,
      ai_confidence: confidence,
      was_low_confidence: confidence < 0.5
    }
  });
}
function enableTelemetry() {
  telemetryEnabled = true;
}
function disableTelemetry() {
  telemetryEnabled = false;
}
function isTelemetryEnabled() {
  return telemetryEnabled;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  disableTelemetry,
  enableTelemetry,
  getAnonymousId,
  getHardwareScore,
  isTelemetryEnabled,
  sanitizeEvent,
  trackBatchOrganized,
  trackCategoryCorrection,
  trackHardwareProfile,
  trackSessionStart,
  trackUndo
});
