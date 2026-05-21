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
var RenameService_exports = {};
__export(RenameService_exports, {
  applyRename: () => applyRename,
  suggestRename: () => suggestRename
});
module.exports = __toCommonJS(RenameService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var LlamaService = __toESM(require("./LlamaService"));
const CONTENT_LIMIT = 600;
const UNSAFE_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
async function ollamaGenerate(prompt) {
  return LlamaService.generate(prompt, { maxTokens: 60, temperature: 0.2, timeoutMs: 15e3 });
}
function sanitizeFilename(name, ext) {
  const withoutExt = name.replace(/\.[a-zA-Z0-9]{1,5}$/, "");
  const safe = withoutExt.replace(UNSAFE_CHARS, "_").replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 80);
  return safe ? safe + ext : "";
}
function scoreConfidence(original, suggested) {
  if (!suggested || suggested === original) return "low";
  if (suggested.length > 5 && suggested.length < 60) return "high";
  return "medium";
}
async function suggestRename(filePath, textContent) {
  const ext = import_path.default.extname(filePath);
  const originalName = import_path.default.basename(filePath);
  const snippet = textContent.slice(0, CONTENT_LIMIT).replace(/\s+/g, " ").trim();
  const prompt = `You are a file naming assistant. Based on the filename and file content below, suggest ONE clean, professional filename (without extension).

Rules:
- Use_underscores_or_Title_Case (no spaces)
- Include a date like 2024-03-15 if clearly stated in content
- Max 60 characters
- Be specific \u2014 avoid generic names like "document" or "file"
- Output ONLY the filename stem, nothing else. No explanation. No quotes.

Filename: ${originalName}
Content preview: ${snippet || "(no text extracted)"}

New filename stem:`;
  let suggested = "";
  let reasoning = "AI suggestion";
  try {
    const raw = await ollamaGenerate(prompt);
    const line = raw.split("\n")[0].trim();
    suggested = sanitizeFilename(line, ext);
    if (!suggested) {
      suggested = originalName;
      reasoning = "AI output was unusable \u2014 kept original";
    }
  } catch (err) {
    suggested = originalName;
    reasoning = `AI error: ${err}`;
  }
  return {
    originalPath: filePath,
    originalName,
    suggestedName: suggested,
    extension: ext,
    confidence: scoreConfidence(originalName, suggested),
    reasoning
  };
}
function applyRename(originalPath, newName) {
  const dir = import_path.default.dirname(originalPath);
  const newPath = import_path.default.join(dir, newName);
  if (newPath === originalPath) return originalPath;
  if (import_fs.default.existsSync(newPath)) {
    throw new Error(`A file named "${newName}" already exists in that folder.`);
  }
  import_fs.default.renameSync(originalPath, newPath);
  console.log(`[Rename] ${import_path.default.basename(originalPath)} \u2192 ${newName}`);
  return newPath;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  applyRename,
  suggestRename
});
