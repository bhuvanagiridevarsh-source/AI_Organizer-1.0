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
var TextExtractionService_exports = {};
__export(TextExtractionService_exports, {
  checkExtractionCapabilities: () => checkExtractionCapabilities,
  checkOCRAvailable: () => checkOCRAvailable,
  extractForClassification: () => extractForClassification,
  extractFullText: () => extractFullText,
  extractMetadata: () => extractMetadata,
  extractText: () => extractText,
  terminateOCRWorker: () => terminateOCRWorker
});
module.exports = __toCommonJS(TextExtractionService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
const TARGET_WORDS = 2e3;
const CLASSIFICATION_WORDS = 15e3;
const MAX_READ_BYTES = 32768;
const GIBBERISH_THRESHOLD = 0.2;
let _pdfParse = null;
let _mammoth = null;
let _admZip = null;
function getPdfParse() {
  if (!_pdfParse) {
    try {
      _pdfParse = require("pdf-parse");
    } catch {
      console.warn("[TextExtraction] pdf-parse not installed \u2014 PDF extraction disabled");
    }
  }
  return _pdfParse;
}
function getMammoth() {
  if (!_mammoth) {
    try {
      _mammoth = require("mammoth");
    } catch {
      console.warn("[TextExtraction] mammoth not installed \u2014 DOCX extraction degraded");
    }
  }
  return _mammoth;
}
function getAdmZip() {
  if (!_admZip) {
    try {
      _admZip = require("adm-zip");
    } catch {
      console.warn("[TextExtraction] adm-zip not installed \u2014 Office extraction disabled");
    }
  }
  return _admZip;
}
let _tesseractWorker = null;
let _tesseractAvailable = null;
function isTesseractAvailable() {
  if (_tesseractAvailable !== null) return _tesseractAvailable;
  try {
    require.resolve("tesseract.js");
    _tesseractAvailable = true;
  } catch {
    _tesseractAvailable = false;
    console.warn("[TextExtraction] tesseract.js not installed \u2014 Image OCR disabled");
  }
  return _tesseractAvailable;
}
async function getTesseractWorker() {
  if (_tesseractWorker) return _tesseractWorker;
  if (!isTesseractAvailable()) return null;
  try {
    const Tesseract = require("tesseract.js");
    console.log("[TextExtraction] Initializing tesseract.js OCR worker...");
    _tesseractWorker = await Tesseract.createWorker("eng");
    console.log("[TextExtraction] tesseract.js worker ready");
    return _tesseractWorker;
  } catch (err) {
    console.warn(`[TextExtraction] Failed to create tesseract.js worker: ${err}`);
    _tesseractAvailable = false;
    return null;
  }
}
const TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
  ".txt",
  ".md",
  ".py",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".json",
  ".csv",
  ".log",
  ".html",
  ".css",
  ".scss",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".bat",
  ".ps1",
  ".rb",
  ".php",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".go",
  ".rs",
  ".swift",
  ".kt",
  ".scala",
  ".r",
  ".m",
  ".sql",
  ".graphql",
  ".vue",
  ".svelte",
  ".astro",
  ".env",
  ".gitignore",
  ".dockerfile"
]);
const PDF_EXTENSIONS = /* @__PURE__ */ new Set([".pdf"]);
const DOCX_EXTENSIONS = /* @__PURE__ */ new Set([".docx", ".doc"]);
const OFFICE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".pptx",
  ".ppt",
  ".xlsx",
  ".xls",
  ".odt",
  ".odp",
  ".ods",
  ".rtf"
]);
const IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".bmp",
  ".tiff",
  ".tif",
  ".webp"
]);
function trimToWords(text, maxWords) {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= maxWords) return words.join(" ");
  return words.slice(0, maxWords).join(" ");
}
function stripTags(text) {
  return text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}
function cleanOutput(raw) {
  if (!raw || raw.trim().length < 5) return "";
  const cleaned = raw.replace(/\s+/g, " ").trim();
  return trimToWords(cleaned, TARGET_WORDS);
}
function isGibberish(text) {
  if (text.length === 0) return true;
  const sample = text.slice(0, 2e3);
  let junkCount = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    const isPrintable = code >= 32 && code <= 126 || // basic ASCII printable
    code === 10 || // newline
    code === 13 || // carriage return
    code === 9 || // tab
    code >= 192 && code <= 255;
    if (!isPrintable) junkCount++;
  }
  const ratio = junkCount / sample.length;
  if (ratio > GIBBERISH_THRESHOLD) {
    console.log(
      `[TextExtraction] Gibberish detected: ${Math.round(ratio * 100)}% non-printable chars (threshold ${Math.round(GIBBERISH_THRESHOLD * 100)}%)`
    );
    return true;
  }
  return false;
}
function extractNativeText(filePath) {
  try {
    const fd = import_fs.default.openSync(filePath, "r");
    const buffer = Buffer.alloc(MAX_READ_BYTES);
    const bytesRead = import_fs.default.readSync(fd, buffer, 0, MAX_READ_BYTES, 0);
    import_fs.default.closeSync(fd);
    let text = buffer.slice(0, bytesRead).toString("utf-8");
    const ext = import_path.default.extname(filePath).toLowerCase();
    if ([".html", ".htm", ".xml", ".svg", ".vue", ".svelte", ".astro"].includes(ext)) {
      text = stripTags(text);
    }
    return text;
  } catch {
    return "";
  }
}
async function extractPdf(filePath) {
  const pdfParse = getPdfParse();
  if (!pdfParse) return "";
  try {
    const dataBuffer = import_fs.default.readFileSync(filePath);
    const data = await pdfParse(dataBuffer, {
      max: 50
      // First 50 pages max
    });
    const text = data.text || "";
    if (text.trim().length === 0) {
      console.log(
        `[TextExtraction] pdf-parse returned empty for "${import_path.default.basename(filePath)}"`
      );
      return "";
    }
    if (isGibberish(text)) {
      console.log(
        `[TextExtraction] pdf-parse output is gibberish for "${import_path.default.basename(filePath)}" \u2014 discarding`
      );
      return "";
    }
    console.log(
      `[TextExtraction] pdf-parse extracted ${text.trim().split(/\s+/).length} words from "${import_path.default.basename(filePath)}"`
    );
    return text;
  } catch (err) {
    console.warn(`[TextExtraction] pdf-parse failed for "${import_path.default.basename(filePath)}": ${err}`);
    return "";
  }
}
async function extractPdfMetadata(filePath) {
  const pdfParse = getPdfParse();
  if (!pdfParse) return null;
  try {
    const dataBuffer = import_fs.default.readFileSync(filePath);
    const data = await pdfParse(dataBuffer, { max: 1 });
    const info = data.info || {};
    const meta = {};
    if (info.Title) meta.title = String(info.Title).trim();
    if (info.Subject) meta.subject = String(info.Subject).trim();
    if (info.Author) meta.author = String(info.Author).trim();
    if (info.Keywords) meta.keywords = String(info.Keywords).trim();
    if (info.Creator) meta.creator = String(info.Creator).trim();
    if (Object.values(meta).some((v) => v && v.length > 1)) return meta;
    return null;
  } catch {
    return null;
  }
}
async function extractDocxNative(filePath) {
  const mammoth = getMammoth();
  if (!mammoth) {
    return extractDocxViaZip(filePath);
  }
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || "";
  } catch (err) {
    console.warn(`[TextExtraction] mammoth failed for "${import_path.default.basename(filePath)}": ${err}`);
    return extractDocxViaZip(filePath);
  }
}
function extractDocxViaZip(filePath) {
  const AdmZip = getAdmZip();
  if (!AdmZip) return "";
  try {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry("word/document.xml");
    if (entry) {
      const text = stripTags(entry.getData().toString("utf-8"));
      if (text.length > 20) return text;
    }
  } catch {
  }
  return "";
}
function extractDocxMetadata(filePath) {
  const AdmZip = getAdmZip();
  if (!AdmZip) return null;
  try {
    const zip = new AdmZip(filePath);
    const coreEntry = zip.getEntry("docProps/core.xml");
    if (!coreEntry) return null;
    const xml = coreEntry.getData().toString("utf-8");
    const get = (tag) => {
      const m = xml.match(new RegExp(`<[^/:>]*:?${tag}[^>]*>([^<]*)`, "i"));
      const val = m ? m[1].trim() : "";
      return val.length > 0 ? val : void 0;
    };
    const meta = {
      title: get("title"),
      subject: get("subject"),
      author: get("creator"),
      keywords: get("keywords"),
      description: get("description")
    };
    if (Object.values(meta).some((v) => v && v.length > 1)) return meta;
    return null;
  } catch {
    return null;
  }
}
function extractOfficeViaZip(filePath) {
  const AdmZip = getAdmZip();
  if (!AdmZip) return "";
  const ext = import_path.default.extname(filePath).toLowerCase();
  try {
    const zip = new AdmZip(filePath);
    if (ext === ".pptx" || ext === ".ppt") {
      const entries = zip.getEntries();
      const parts = [];
      const coreProp = zip.getEntry("docProps/core.xml");
      if (coreProp) {
        const coreXml = coreProp.getData().toString("utf-8");
        const titleMatch = coreXml.match(/<dc:title>([^<]+)<\/dc:title>/i);
        if (titleMatch) parts.push("Presentation: " + titleMatch[1].trim());
        const subjectMatch = coreXml.match(/<dc:subject>([^<]+)<\/dc:subject>/i);
        if (subjectMatch) parts.push("Subject: " + subjectMatch[1].trim());
      }
      const slideEntries = entries.filter((e) => e.entryName.match(/^ppt\/slides\/slide\d+\.xml$/)).sort((a, b) => {
        const na = parseInt(a.entryName.match(/(\d+)/)?.[1] || "0");
        const nb = parseInt(b.entryName.match(/(\d+)/)?.[1] || "0");
        return na - nb;
      });
      for (const entry of slideEntries.slice(0, 20)) {
        const xml = entry.getData().toString("utf-8");
        const titleMatches = [...xml.matchAll(/<p:sp>[\s\S]*?<p:ph[^>]*type="title"[\s\S]*?<\/p:sp>/g)];
        for (const m of titleMatches) {
          const titleText = stripTags(m[0]);
          if (titleText.trim()) parts.push("Slide title: " + titleText.trim());
        }
        const bodyText = stripTags(xml);
        if (bodyText.trim()) parts.push(bodyText.trim());
      }
      const noteEntries = entries.filter(
        (e) => e.entryName.match(/^ppt\/notesSlides\/notesSlide\d+\.xml$/)
      );
      for (const entry of noteEntries.slice(0, 10)) {
        const notesText = stripTags(entry.getData().toString("utf-8"));
        if (notesText.trim().length > 20) parts.push("Notes: " + notesText.trim());
      }
      if (parts.length > 0) return parts.join(" ");
    }
    if (ext === ".xlsx" || ext === ".xls") {
      const parts = [];
      const workbookEntry = zip.getEntry("xl/workbook.xml");
      if (workbookEntry) {
        const wbXml = workbookEntry.getData().toString("utf-8");
        const sheetNames = [];
        for (const m of wbXml.matchAll(/name="([^"]+)"/g)) {
          if (m[1] && m[1] !== "Workbook") sheetNames.push(m[1]);
        }
        if (sheetNames.length > 0) parts.push("Sheets: " + sheetNames.join(", "));
      }
      const corePropEntry = zip.getEntry("docProps/core.xml");
      if (corePropEntry) {
        const coreXml = corePropEntry.getData().toString("utf-8");
        const titleMatch = coreXml.match(/<dc:title>([^<]+)<\/dc:title>/i);
        if (titleMatch) parts.push("Title: " + titleMatch[1].trim());
      }
      const sharedStrings = zip.getEntry("xl/sharedStrings.xml");
      if (sharedStrings) {
        const ssXml = sharedStrings.getData().toString("utf-8");
        const textValues = [];
        for (const m of ssXml.matchAll(/<t(?:\s[^>]*)?>([^<]+)<\/t>/g)) {
          const val = m[1].trim();
          if (val.length >= 2 && val.length <= 60) textValues.push(val);
        }
        const unique = [...new Set(textValues)].slice(0, 200);
        if (unique.length > 0) parts.push("Values: " + unique.join(", "));
      }
      const entries = zip.getEntries();
      const sheetEntry = entries.find((e) => e.entryName.match(/^xl\/worksheets\/sheet1\.xml$/));
      if (sheetEntry) {
        const wsXml = sheetEntry.getData().toString("utf-8");
        const firstRowMatch = wsXml.match(/<row[^>]*r="1"[^>]*>([\s\S]*?)<\/row>/);
        if (firstRowMatch) {
          const headerText = stripTags(firstRowMatch[1]);
          if (headerText.trim().length > 3) parts.push("Column headers: " + headerText.trim());
        }
      }
      if (parts.length > 0) return parts.join(" ");
    }
    if ([".odt", ".odp", ".ods"].includes(ext)) {
      const entry = zip.getEntry("content.xml");
      if (entry) {
        const text = stripTags(entry.getData().toString("utf-8"));
        if (text.length > 20) return text;
      }
    }
  } catch {
  }
  if (ext === ".rtf") {
    try {
      const raw = import_fs.default.readFileSync(filePath, "utf-8").slice(0, MAX_READ_BYTES);
      return raw.replace(/\{[^}]*\}/g, " ").replace(/\\[a-z]+\d*\s?/gi, " ").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
    } catch {
    }
  }
  return "";
}
async function extractImageOCR(filePath) {
  const worker = await getTesseractWorker();
  if (!worker) return "";
  try {
    console.log(
      `[TextExtraction] Running OCR on "${import_path.default.basename(filePath)}"...`
    );
    const { data } = await worker.recognize(filePath);
    const text = data?.text || "";
    if (text.trim().length === 0) {
      console.log(
        `[TextExtraction] OCR returned empty for "${import_path.default.basename(filePath)}"`
      );
      return "";
    }
    const wordCount = text.trim().split(/\s+/).length;
    console.log(
      `[TextExtraction] OCR extracted ${wordCount} words from "${import_path.default.basename(filePath)}"`
    );
    return text;
  } catch (err) {
    console.warn(
      `[TextExtraction] OCR failed for "${import_path.default.basename(filePath)}": ${err}`
    );
    return "";
  }
}
async function extractText(filePath) {
  try {
    const ext = import_path.default.extname(filePath).toLowerCase();
    const filename = import_path.default.basename(filePath);
    if (TEXT_EXTENSIONS.has(ext)) {
      try {
        return cleanOutput(extractNativeText(filePath));
      } catch {
        return "";
      }
    }
    if (PDF_EXTENSIONS.has(ext)) {
      try {
        const text = await extractPdf(filePath);
        return cleanOutput(text);
      } catch {
        return "";
      }
    }
    if (DOCX_EXTENSIONS.has(ext)) {
      try {
        const text = await extractDocxNative(filePath);
        return cleanOutput(text);
      } catch {
        return "";
      }
    }
    if (OFFICE_EXTENSIONS.has(ext)) {
      try {
        return cleanOutput(extractOfficeViaZip(filePath));
      } catch {
        return "";
      }
    }
    if (IMAGE_EXTENSIONS.has(ext)) {
      try {
        const text = await extractImageOCR(filePath);
        return cleanOutput(text);
      } catch {
        return "";
      }
    }
    console.log(`[TextExtraction] Unknown extension "${ext}" for "${filename}"`);
    return "";
  } catch (err) {
    console.error(`[TextExtraction] Unexpected error for "${import_path.default.basename(filePath)}": ${err}`);
    return "";
  }
}
async function extractFullText(filePath) {
  try {
    const ext = import_path.default.extname(filePath).toLowerCase();
    const filename = import_path.default.basename(filePath);
    if (TEXT_EXTENSIONS.has(ext)) {
      try {
        let text = import_fs.default.readFileSync(filePath, "utf-8");
        if ([".html", ".htm", ".xml", ".svg", ".vue", ".svelte", ".astro"].includes(ext)) {
          text = stripTags(text);
        }
        return text.replace(/\s+/g, " ").trim();
      } catch {
        return "";
      }
    }
    if (PDF_EXTENSIONS.has(ext)) {
      try {
        const text = await extractPdf(filePath);
        if (!text || text.trim().length < 5) return "";
        return text.replace(/\s+/g, " ").trim();
      } catch {
        return "";
      }
    }
    if (DOCX_EXTENSIONS.has(ext)) {
      try {
        const text = await extractDocxNative(filePath);
        if (!text || text.trim().length < 5) return "";
        return text.replace(/\s+/g, " ").trim();
      } catch {
        return "";
      }
    }
    if (OFFICE_EXTENSIONS.has(ext)) {
      try {
        const text = extractOfficeViaZip(filePath);
        if (!text || text.trim().length < 5) return "";
        return text.replace(/\s+/g, " ").trim();
      } catch {
        return "";
      }
    }
    if (IMAGE_EXTENSIONS.has(ext)) {
      try {
        const text = await extractImageOCR(filePath);
        if (!text || text.trim().length < 5) return "";
        return text.replace(/\s+/g, " ").trim();
      } catch {
        return "";
      }
    }
    console.log(`[TextExtraction] extractFullText: unknown ext "${ext}" for "${filename}"`);
    return "";
  } catch (err) {
    console.error(`[TextExtraction] extractFullText error for "${import_path.default.basename(filePath)}": ${err}`);
    return "";
  }
}
async function extractMetadata(filePath) {
  try {
    const ext = import_path.default.extname(filePath).toLowerCase();
    if (PDF_EXTENSIONS.has(ext)) return await extractPdfMetadata(filePath);
    if (DOCX_EXTENSIONS.has(ext)) return extractDocxMetadata(filePath);
    return null;
  } catch {
    return null;
  }
}
async function extractForClassification(filePath) {
  try {
    const ext = import_path.default.extname(filePath).toLowerCase();
    const filename = import_path.default.basename(filePath);
    if (TEXT_EXTENSIONS.has(ext)) {
      try {
        let text = import_fs.default.readFileSync(filePath, "utf-8");
        if ([".html", ".htm", ".xml", ".svg", ".vue", ".svelte", ".astro"].includes(ext)) {
          text = stripTags(text);
        }
        return trimToWords(text.replace(/\s+/g, " ").trim(), CLASSIFICATION_WORDS);
      } catch {
        return "";
      }
    }
    if (PDF_EXTENSIONS.has(ext)) {
      try {
        const text = await extractPdf(filePath);
        if (!text || text.trim().length < 5) return "";
        return trimToWords(text.replace(/\s+/g, " ").trim(), CLASSIFICATION_WORDS);
      } catch {
        return "";
      }
    }
    if (DOCX_EXTENSIONS.has(ext)) {
      try {
        const text = await extractDocxNative(filePath);
        if (!text || text.trim().length < 5) return "";
        return trimToWords(text.replace(/\s+/g, " ").trim(), CLASSIFICATION_WORDS);
      } catch {
        return "";
      }
    }
    if (OFFICE_EXTENSIONS.has(ext)) {
      try {
        const text = extractOfficeViaZip(filePath);
        if (!text || text.trim().length < 5) return "";
        return trimToWords(text.replace(/\s+/g, " ").trim(), CLASSIFICATION_WORDS);
      } catch {
        return "";
      }
    }
    if (IMAGE_EXTENSIONS.has(ext)) {
      try {
        const text = await extractImageOCR(filePath);
        if (!text || text.trim().length < 5) return "";
        return trimToWords(text.replace(/\s+/g, " ").trim(), CLASSIFICATION_WORDS);
      } catch {
        return "";
      }
    }
    console.log(`[TextExtraction] extractForClassification: unknown ext "${ext}" for "${filename}"`);
    return "";
  } catch (err) {
    console.error(`[TextExtraction] extractForClassification error for "${import_path.default.basename(filePath)}": ${err}`);
    return "";
  }
}
function checkExtractionCapabilities() {
  let pdfParse = false;
  let mammoth = false;
  let admZip = false;
  const tesseractJs = isTesseractAvailable();
  try {
    require.resolve("pdf-parse");
    pdfParse = true;
  } catch {
  }
  try {
    require.resolve("mammoth");
    mammoth = true;
  } catch {
  }
  try {
    require.resolve("adm-zip");
    admZip = true;
  } catch {
  }
  console.log(
    `[TextExtraction] Capabilities: pdf-parse=${pdfParse}, mammoth=${mammoth}, adm-zip=${admZip}, tesseract.js=${tesseractJs}`
  );
  return { pdfParse, mammoth, admZip, tesseractJs };
}
function checkOCRAvailable() {
  return {
    tesseractJs: isTesseractAvailable(),
    pdfImgConvert: false,
    pdftotext: false
  };
}
async function terminateOCRWorker() {
  if (_tesseractWorker) {
    try {
      await _tesseractWorker.terminate();
      console.log("[TextExtraction] tesseract.js worker terminated");
    } catch {
    }
    _tesseractWorker = null;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  checkExtractionCapabilities,
  checkOCRAvailable,
  extractForClassification,
  extractFullText,
  extractMetadata,
  extractText,
  terminateOCRWorker
});
