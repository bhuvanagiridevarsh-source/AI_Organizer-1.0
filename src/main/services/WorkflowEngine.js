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
var WorkflowEngine_exports = {};
__export(WorkflowEngine_exports, {
  PREF_PDF_SUMMARY_ENABLED: () => PREF_PDF_SUMMARY_ENABLED,
  getPdfQueueLength: () => getPdfQueueLength,
  initWorkflowEngine: () => initWorkflowEngine,
  onFileReady: () => onFileReady
});
module.exports = __toCommonJS(WorkflowEngine_exports);
var import_path = __toESM(require("path"));
var import_PDFSummaryWorkflow = require("./workflows/PDFSummaryWorkflow");
const PREF_PDF_SUMMARY_ENABLED = "workflows.pdfSummaryEnabled";
const RETRY_DELAY_MS = 3e4;
const MAX_RETRIES = 1;
const pdfQueue = [];
let pdfQueueRunning = false;
let getSettings = null;
let notify = null;
function shouldSkipWorkflow(filePath) {
  const base = import_path.default.basename(filePath);
  if (base.startsWith(".")) return true;
  if (base.endsWith("-summary.txt")) return true;
  if ((0, import_PDFSummaryWorkflow.isSummaryFile)(filePath)) return true;
  return false;
}
function getSetting(key, defaultVal) {
  if (!getSettings) return defaultVal;
  return getSettings(key, defaultVal);
}
async function drainPdfQueue() {
  if (pdfQueueRunning) return;
  pdfQueueRunning = true;
  while (pdfQueue.length > 0) {
    if (!getSetting(PREF_PDF_SUMMARY_ENABLED, false)) {
      console.log("[WorkflowEngine] PDF summary disabled \u2014 pausing queue.");
      break;
    }
    const item = pdfQueue.shift();
    console.log(`[WorkflowEngine] Running PDFSummary for: ${import_path.default.basename(item.filePath)}`);
    let result;
    try {
      result = await (0, import_PDFSummaryWorkflow.runPDFSummary)(item.filePath);
    } catch (err) {
      result = { ok: false, reason: err?.message ?? String(err) };
    }
    if (result.ok) {
      console.log(`[WorkflowEngine] PDFSummary OK \u2192 ${result.outputPath}`);
      notify?.("workflow:pdf-summary-done", {
        sourcePath: item.filePath,
        summaryPath: result.outputPath,
        filename: import_path.default.basename(item.filePath)
      });
    } else {
      console.warn(`[WorkflowEngine] PDFSummary failed (${result.reason})`);
      if (item.retryCount < MAX_RETRIES) {
        console.log(`[WorkflowEngine] Will retry in ${RETRY_DELAY_MS / 1e3}s\u2026`);
        setTimeout(() => {
          pdfQueue.push({ filePath: item.filePath, retryCount: item.retryCount + 1 });
          if (!pdfQueueRunning) drainPdfQueue();
        }, RETRY_DELAY_MS);
      } else {
        console.warn(`[WorkflowEngine] PDFSummary giving up after ${MAX_RETRIES} retries: ${import_path.default.basename(item.filePath)}`);
      }
    }
  }
  pdfQueueRunning = false;
}
function initWorkflowEngine(settingsGetter, notifyRenderer) {
  getSettings = settingsGetter;
  notify = notifyRenderer ?? null;
  console.log("[WorkflowEngine] Initialized.");
}
function onFileReady(filename, filePath) {
  if (!getSettings) return;
  if (shouldSkipWorkflow(filePath)) {
    return;
  }
  const ext = import_path.default.extname(filename).toLowerCase();
  if (ext === ".pdf" && getSetting(PREF_PDF_SUMMARY_ENABLED, false)) {
    pdfQueue.push({ filePath, retryCount: 0 });
    console.log(`[WorkflowEngine] Queued PDF summary for: ${filename}`);
    drainPdfQueue().catch((err) => {
      console.warn("[WorkflowEngine] drainPdfQueue error:", err);
    });
  }
}
function getPdfQueueLength() {
  return pdfQueue.length;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PREF_PDF_SUMMARY_ENABLED,
  getPdfQueueLength,
  initWorkflowEngine,
  onFileReady
});
