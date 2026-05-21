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
var PDFSummaryWorkflow_exports = {};
__export(PDFSummaryWorkflow_exports, {
  SUMMARY_SENTINEL: () => SUMMARY_SENTINEL,
  getSummaryPath: () => getSummaryPath,
  isSummaryFile: () => isSummaryFile,
  runPDFSummary: () => runPDFSummary
});
module.exports = __toCommonJS(PDFSummaryWorkflow_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_TextExtractionService = require("../TextExtractionService");
var import_LlamaService = require("../LlamaService");
const SUMMARY_SENTINEL = "# AI_ORGANIZER_SUMMARY_v1";
const MAX_SUMMARY_TOKENS = 400;
const SUMMARY_TEMPERATURE = 0.2;
const SUMMARY_TIMEOUT_MS = 6e4;
function getSummaryPath(pdfPath) {
  const dir = import_path.default.dirname(pdfPath);
  const base = import_path.default.basename(pdfPath, import_path.default.extname(pdfPath));
  return import_path.default.join(dir, `${base}-summary.txt`);
}
function isSummaryFile(filePath) {
  try {
    const ext = import_path.default.extname(filePath).toLowerCase();
    if (ext !== ".txt") return false;
    const fd = import_fs.default.openSync(filePath, "r");
    const buf = Buffer.alloc(SUMMARY_SENTINEL.length + 2);
    import_fs.default.readSync(fd, buf, 0, buf.length, 0);
    import_fs.default.closeSync(fd);
    return buf.toString("utf8").startsWith(SUMMARY_SENTINEL);
  } catch {
    return false;
  }
}
async function runPDFSummary(pdfPath) {
  try {
    const ext = import_path.default.extname(pdfPath).toLowerCase();
    if (ext !== ".pdf") {
      return { ok: false, reason: `Not a PDF: ${ext}` };
    }
    if (!(0, import_LlamaService.isReady)()) {
      const err = (0, import_LlamaService.getError)();
      return {
        ok: false,
        reason: err ? `LLM not ready: ${err}` : "LLM not ready (still loading)"
      };
    }
    const rawText = await (0, import_TextExtractionService.extractText)(pdfPath);
    if (!rawText || rawText.trim().length < 20) {
      return { ok: false, reason: "PDF yielded no extractable text (image-only or encrypted)" };
    }
    const words = rawText.trim().split(/\s+/);
    const excerpt = words.slice(0, 2e3).join(" ");
    const filename = import_path.default.basename(pdfPath);
    const prompt = [
      `You are a document summarizer. Summarize the following text from "${filename}" in 3-5 concise bullet points.`,
      "Focus on key information, decisions, and action items. Do not include any preamble.",
      "",
      "TEXT:",
      excerpt,
      "",
      "SUMMARY:"
    ].join("\n");
    const summary = await (0, import_LlamaService.generate)(prompt, {
      maxTokens: MAX_SUMMARY_TOKENS,
      temperature: SUMMARY_TEMPERATURE,
      timeoutMs: SUMMARY_TIMEOUT_MS
    });
    if (!summary || summary.trim().length === 0) {
      return { ok: false, reason: "LLM returned empty summary" };
    }
    const outputPath = getSummaryPath(pdfPath);
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const content = [
      SUMMARY_SENTINEL,
      `# Summary of: ${filename}`,
      `# Generated: ${timestamp}`,
      `# Source: ${pdfPath}`,
      "",
      summary.trim(),
      ""
    ].join("\n");
    import_fs.default.writeFileSync(outputPath, content, "utf-8");
    console.log(`[PDFSummaryWorkflow] Summary written \u2192 ${outputPath}`);
    return { ok: true, outputPath };
  } catch (err) {
    const reason = err?.message ?? String(err);
    console.warn(`[PDFSummaryWorkflow] Failed for ${pdfPath}: ${reason}`);
    return { ok: false, reason };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SUMMARY_SENTINEL,
  getSummaryPath,
  isSummaryFile,
  runPDFSummary
});
