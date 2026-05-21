var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var AIHealthService_exports = {};
__export(AIHealthService_exports, {
  getAIStatus: () => getAIStatus,
  markModelError: () => markModelError,
  markModelReady: () => markModelReady,
  startHealthMonitor: () => startHealthMonitor,
  stopHealthMonitor: () => stopHealthMonitor
});
module.exports = __toCommonJS(AIHealthService_exports);
var import_electron = require("electron");
let _status = {
  running: false,
  modelReady: false,
  modelName: "unknown",
  lastChecked: (/* @__PURE__ */ new Date()).toISOString(),
  restartAttempts: 0
};
let _healthInterval = null;
const MAX_RESTART_ATTEMPTS = 3;
const HEALTH_INTERVAL_MS = 3e4;
function getWindow() {
  const wins = import_electron.BrowserWindow.getAllWindows();
  return wins.length > 0 && !wins[0].isDestroyed() ? wins[0] : null;
}
function sendStatus(event, payload) {
  const win = getWindow();
  if (win) win.webContents.send(event, payload);
}
async function checkLlama() {
  try {
    const LlamaService = require("./LlamaService");
    return LlamaService.isReady();
  } catch {
    return false;
  }
}
async function tryRestart() {
  try {
    const LlamaService = require("./LlamaService");
    const result = await LlamaService.initialize();
    return result?.success === true;
  } catch {
    return false;
  }
}
async function runHealthCheck() {
  const ready = await checkLlama();
  _status.lastChecked = (/* @__PURE__ */ new Date()).toISOString();
  _status.modelReady = ready;
  _status.running = ready;
  if (!ready) {
    _status.restartAttempts++;
    console.warn(`[AIHealth] Model not ready \u2014 restart attempt ${_status.restartAttempts}/${MAX_RESTART_ATTEMPTS}`);
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
          message: "The AI engine hit a snag. Try restarting the app."
        });
        console.error("[AIHealth] Model could not recover after 3 attempts.");
        stopHealthMonitor();
      }
    }
  } else {
    _status.restartAttempts = 0;
  }
}
function startHealthMonitor() {
  if (_healthInterval) return;
  _status.modelReady = true;
  _status.running = true;
  _status.restartAttempts = 0;
  _healthInterval = setInterval(runHealthCheck, HEALTH_INTERVAL_MS);
  console.log("[AIHealth] Health monitor started (30s interval).");
}
function stopHealthMonitor() {
  if (_healthInterval) {
    clearInterval(_healthInterval);
    _healthInterval = null;
  }
}
function getAIStatus() {
  return { ..._status };
}
function markModelReady(modelName) {
  _status.modelReady = true;
  _status.running = true;
  _status.restartAttempts = 0;
  if (modelName) _status.modelName = modelName;
  _status.lastChecked = (/* @__PURE__ */ new Date()).toISOString();
}
function markModelError() {
  _status.modelReady = false;
  _status.running = false;
  _status.lastChecked = (/* @__PURE__ */ new Date()).toISOString();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getAIStatus,
  markModelError,
  markModelReady,
  startHealthMonitor,
  stopHealthMonitor
});
