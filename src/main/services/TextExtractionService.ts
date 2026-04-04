/**
 * TextExtractionService.ts — Text Extraction with Image OCR.
 *
 * Pure-JS pipeline:
 *
 *   - pdf-parse:     PDF → text  (native digital PDFs)
 *   - mammoth:       DOCX → text (preserves structure)
 *   - adm-zip:       ZIP-based Office formats (PPTX, XLSX, ODT)
 *   - tesseract.js:  Image OCR  (JPG, PNG, BMP, TIFF, WebP)
 *
 * Extraction Hierarchy:
 *
 *   Images     → tesseract.js OCR → text
 *   PDF        → pdf-parse (gibberish check) → "" if fail
 *   DOCX       → mammoth → adm-zip fallback
 *   PPTX/XLSX  → adm-zip + XML strip
 *   Code/Text  → direct UTF-8 read
 *   Unknown    → "" (graceful failure)
 *
 * Every path converges to cleanOutput() → 2,000 words max.
 * Every path is wrapped in try/catch — NOTHING crashes the batch.
 */

import fs from "fs";
import path from "path";

// ── Configuration ──────────────────────────────────────────

const TARGET_WORDS = 2000;
/** Word limit for classification-specific extraction (much larger than default snippet). */
const CLASSIFICATION_WORDS = 15_000;
const MAX_READ_BYTES = 32768; // 32KB for native text files

/** If more than this fraction of chars are non-printable junk,
 *  the extraction is treated as empty (gibberish). */
const GIBBERISH_THRESHOLD = 0.20;

// ── Lazy-loaded modules ────────────────────────────────────
// These are heavy — only load when actually needed.

let _pdfParse: typeof import("pdf-parse") | null = null;
let _mammoth: typeof import("mammoth") | null = null;
let _admZip: typeof import("adm-zip") | null = null;

function getPdfParse() {
  if (!_pdfParse) {
    try {
      _pdfParse = require("pdf-parse");
    } catch {
      console.warn("[TextExtraction] pdf-parse not installed — PDF extraction disabled");
    }
  }
  return _pdfParse;
}

function getMammoth() {
  if (!_mammoth) {
    try {
      _mammoth = require("mammoth");
    } catch {
      console.warn("[TextExtraction] mammoth not installed — DOCX extraction degraded");
    }
  }
  return _mammoth;
}

function getAdmZip() {
  if (!_admZip) {
    try {
      _admZip = require("adm-zip");
    } catch {
      console.warn("[TextExtraction] adm-zip not installed — Office extraction disabled");
    }
  }
  return _admZip;
}

// ── Metadata types ─────────────────────────────────────────
/** Structured metadata extracted from PDF / DOCX document properties. */
export interface FileMetadata {
  title?:       string;
  subject?:     string;
  author?:      string;
  keywords?:    string;
  creator?:     string;
  description?: string;
}

// tesseract.js — lazy-loaded OCR worker (persists across calls)
let _tesseractWorker: any = null;
let _tesseractAvailable: boolean | null = null;

function isTesseractAvailable(): boolean {
  if (_tesseractAvailable !== null) return _tesseractAvailable;
  try {
    require.resolve("tesseract.js");
    _tesseractAvailable = true;
  } catch {
    _tesseractAvailable = false;
    console.warn("[TextExtraction] tesseract.js not installed — Image OCR disabled");
  }
  return _tesseractAvailable;
}

async function getTesseractWorker(): Promise<any> {
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

// ── Extension sets ─────────────────────────────────────────

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".py", ".js", ".ts", ".jsx", ".tsx", ".json", ".csv",
  ".log", ".html", ".css", ".scss", ".xml", ".yaml", ".yml", ".toml",
  ".ini", ".cfg", ".conf", ".sh", ".bash", ".zsh", ".fish", ".bat",
  ".ps1", ".rb", ".php", ".java", ".c", ".cpp", ".h", ".hpp", ".go",
  ".rs", ".swift", ".kt", ".scala", ".r", ".m", ".sql", ".graphql",
  ".vue", ".svelte", ".astro", ".env", ".gitignore", ".dockerfile",
]);

const PDF_EXTENSIONS = new Set([".pdf"]);

const DOCX_EXTENSIONS = new Set([".docx", ".doc"]);

const OFFICE_EXTENSIONS = new Set([
  ".pptx", ".ppt", ".xlsx", ".xls", ".odt", ".odp", ".ods", ".rtf",
]);

const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".webp",
]);

// ── Utilities ──────────────────────────────────────────────

function trimToWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= maxWords) return words.join(" ");
  return words.slice(0, maxWords).join(" ");
}

function stripTags(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanOutput(raw: string): string {
  if (!raw || raw.trim().length < 5) return "";
  const cleaned = raw.replace(/\s+/g, " ").trim();
  return trimToWords(cleaned, TARGET_WORDS);
}

/**
 * Gibberish check: if > 20% of characters are non-printable or
 * weird symbols, the extraction is garbage (e.g. a scanned PDF
 * where pdf-parse returned raw font-encoded bytes).
 *
 * Printable = letters, digits, common punctuation, whitespace.
 */
function isGibberish(text: string): boolean {
  if (text.length === 0) return true;

  // Sample the first 2000 chars for speed
  const sample = text.slice(0, 2000);
  let junkCount = 0;

  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // Printable ASCII range + common Latin-1 letters
    const isPrintable =
      (code >= 0x20 && code <= 0x7e) || // basic ASCII printable
      code === 0x0a ||                   // newline
      code === 0x0d ||                   // carriage return
      code === 0x09 ||                   // tab
      (code >= 0xc0 && code <= 0xff);    // Latin-1 accented chars
    if (!isPrintable) junkCount++;
  }

  const ratio = junkCount / sample.length;
  if (ratio > GIBBERISH_THRESHOLD) {
    console.log(
      `[TextExtraction] Gibberish detected: ${Math.round(ratio * 100)}% ` +
      `non-printable chars (threshold ${Math.round(GIBBERISH_THRESHOLD * 100)}%)`
    );
    return true;
  }

  return false;
}

// ── Extraction strategies ──────────────────────────────────

/**
 * 1. NATIVE TEXT — direct file read for code, markdown, config, etc.
 */
function extractNativeText(filePath: string): string {
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(MAX_READ_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, MAX_READ_BYTES, 0);
    fs.closeSync(fd);

    let text = buffer.slice(0, bytesRead).toString("utf-8");

    const ext = path.extname(filePath).toLowerCase();
    if ([".html", ".htm", ".xml", ".svg", ".vue", ".svelte", ".astro"].includes(ext)) {
      text = stripTags(text);
    }

    return text;
  } catch {
    return "";
  }
}

/**
 * 2. PDF TEXT — Native extraction using pdf-parse (pure JS, no CLI).
 *    If the result is gibberish (scanned PDF), return "".
 */
async function extractPdf(filePath: string): Promise<string> {
  const pdfParse = getPdfParse();
  if (!pdfParse) return "";

  try {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer, {
      max: 50, // First 50 pages max
    });

    const text = data.text || "";

    if (text.trim().length === 0) {
      console.log(
        `[TextExtraction] pdf-parse returned empty for "${path.basename(filePath)}"`
      );
      return "";
    }

    if (isGibberish(text)) {
      console.log(
        `[TextExtraction] pdf-parse output is gibberish for "${path.basename(filePath)}" — discarding`
      );
      return "";
    }

    console.log(
      `[TextExtraction] pdf-parse extracted ${text.trim().split(/\s+/).length} words ` +
      `from "${path.basename(filePath)}"`
    );
    return text;
  } catch (err) {
    console.warn(`[TextExtraction] pdf-parse failed for "${path.basename(filePath)}": ${err}`);
    return "";
  }
}

/**
 * 2b. PDF METADATA — Extract document properties from pdf-parse `data.info`.
 *     Only reads 1 page to minimise time. Returns null if nothing useful found.
 */
async function extractPdfMetadata(filePath: string): Promise<FileMetadata | null> {
  const pdfParse = getPdfParse();
  if (!pdfParse) return null;
  try {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer, { max: 1 });
    const info = (data as any).info || {};

    const meta: FileMetadata = {};
    if (info.Title)    meta.title       = String(info.Title).trim();
    if (info.Subject)  meta.subject     = String(info.Subject).trim();
    if (info.Author)   meta.author      = String(info.Author).trim();
    if (info.Keywords) meta.keywords    = String(info.Keywords).trim();
    if (info.Creator)  meta.creator     = String(info.Creator).trim();

    if (Object.values(meta).some((v) => v && v.length > 1)) return meta;
    return null;
  } catch {
    return null;
  }
}

/**
 * 3. DOCX TEXT — Native extraction using mammoth (pure JS).
 */
async function extractDocxNative(filePath: string): Promise<string> {
  const mammoth = getMammoth();
  if (!mammoth) {
    // Fallback to ZIP extraction
    return extractDocxViaZip(filePath);
  }

  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || "";
  } catch (err) {
    console.warn(`[TextExtraction] mammoth failed for "${path.basename(filePath)}": ${err}`);
    return extractDocxViaZip(filePath);
  }
}

/**
 * 4. DOCX via ZIP — Fallback if mammoth fails.
 */
function extractDocxViaZip(filePath: string): string {
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
    // ZIP extraction failed
  }

  return "";
}

/**
 * 4b. DOCX METADATA — Read docProps/core.xml from the ZIP for title/subject/author.
 */
function extractDocxMetadata(filePath: string): FileMetadata | null {
  const AdmZip = getAdmZip();
  if (!AdmZip) return null;
  try {
    const zip = new AdmZip(filePath);
    const coreEntry = zip.getEntry("docProps/core.xml");
    if (!coreEntry) return null;
    const xml = coreEntry.getData().toString("utf-8");

    // Helper: extract content of first matching tag (namespace-agnostic)
    const get = (tag: string): string | undefined => {
      const m = xml.match(new RegExp(`<[^/:>]*:?${tag}[^>]*>([^<]*)`, "i"));
      const val = m ? m[1].trim() : "";
      return val.length > 0 ? val : undefined;
    };

    const meta: FileMetadata = {
      title:       get("title"),
      subject:     get("subject"),
      author:      get("creator"),
      keywords:    get("keywords"),
      description: get("description"),
    };

    if (Object.values(meta).some((v) => v && v.length > 1)) return meta;
    return null;
  } catch {
    return null;
  }
}

/**
 * 5. OFFICE FORMATS — ZIP-based extraction for PPTX, XLSX, ODT.
 */
function extractOfficeViaZip(filePath: string): string {
  const AdmZip = getAdmZip();
  if (!AdmZip) return "";

  const ext = path.extname(filePath).toLowerCase();

  try {
    const zip = new AdmZip(filePath);

    // ── PPTX: titles + body text + speaker notes ──────────────
    if (ext === ".pptx" || ext === ".ppt") {
      const entries = zip.getEntries();
      const parts: string[] = [];

      // 1. Presentation-level title from core properties
      const coreProp = zip.getEntry("docProps/core.xml");
      if (coreProp) {
        const coreXml = coreProp.getData().toString("utf-8");
        const titleMatch = coreXml.match(/<dc:title>([^<]+)<\/dc:title>/i);
        if (titleMatch) parts.push("Presentation: " + titleMatch[1].trim());
        const subjectMatch = coreXml.match(/<dc:subject>([^<]+)<\/dc:subject>/i);
        if (subjectMatch) parts.push("Subject: " + subjectMatch[1].trim());
      }

      // 2. Slide content — extract titles separately for extra weight
      const slideEntries = entries
        .filter(e => e.entryName.match(/^ppt\/slides\/slide\d+\.xml$/))
        .sort((a, b) => {
          const na = parseInt(a.entryName.match(/(\d+)/)?.[1] || "0");
          const nb = parseInt(b.entryName.match(/(\d+)/)?.[1] || "0");
          return na - nb;
        });

      for (const entry of slideEntries.slice(0, 20)) {  // max 20 slides
        const xml = entry.getData().toString("utf-8");

        // Title shapes come first and carry the highest signal weight
        const titleMatches = [...xml.matchAll(/<p:sp>[\s\S]*?<p:ph[^>]*type="title"[\s\S]*?<\/p:sp>/g)];
        for (const m of titleMatches) {
          const titleText = stripTags(m[0]);
          if (titleText.trim()) parts.push("Slide title: " + titleText.trim());
        }

        // Body text (everything else on the slide)
        const bodyText = stripTags(xml);
        if (bodyText.trim()) parts.push(bodyText.trim());
      }

      // 3. Speaker notes — often contain rich descriptive text
      const noteEntries = entries.filter(e =>
        e.entryName.match(/^ppt\/notesSlides\/notesSlide\d+\.xml$/)
      );
      for (const entry of noteEntries.slice(0, 10)) {
        const notesText = stripTags(entry.getData().toString("utf-8"));
        if (notesText.trim().length > 20) parts.push("Notes: " + notesText.trim());
      }

      if (parts.length > 0) return parts.join(" ");
    }

    // ── XLSX: sheet names + column headers + cell values ──────
    if (ext === ".xlsx" || ext === ".xls") {
      const parts: string[] = [];

      // 1. Workbook sheet names — huge signal for what spreadsheet is about
      const workbookEntry = zip.getEntry("xl/workbook.xml");
      if (workbookEntry) {
        const wbXml = workbookEntry.getData().toString("utf-8");
        const sheetNames: string[] = [];
        for (const m of wbXml.matchAll(/name="([^"]+)"/g)) {
          if (m[1] && m[1] !== "Workbook") sheetNames.push(m[1]);
        }
        if (sheetNames.length > 0) parts.push("Sheets: " + sheetNames.join(", "));
      }

      // 2. Core properties (document title / subject)
      const corePropEntry = zip.getEntry("docProps/core.xml");
      if (corePropEntry) {
        const coreXml = corePropEntry.getData().toString("utf-8");
        const titleMatch = coreXml.match(/<dc:title>([^<]+)<\/dc:title>/i);
        if (titleMatch) parts.push("Title: " + titleMatch[1].trim());
      }

      // 3. Shared strings (all unique text values in the spreadsheet)
      const sharedStrings = zip.getEntry("xl/sharedStrings.xml");
      if (sharedStrings) {
        const ssXml = sharedStrings.getData().toString("utf-8");
        // Extract all <t> elements (string values) — these are column headers + cell text
        const textValues: string[] = [];
        for (const m of ssXml.matchAll(/<t(?:\s[^>]*)?>([^<]+)<\/t>/g)) {
          const val = m[1].trim();
          if (val.length >= 2 && val.length <= 60) textValues.push(val);
        }
        // Deduplicate and take the first 200 most meaningful values
        const unique = [...new Set(textValues)].slice(0, 200);
        if (unique.length > 0) parts.push("Values: " + unique.join(", "));
      }

      // 4. First worksheet — extract row 1 (headers) explicitly
      const entries = zip.getEntries();
      const sheetEntry = entries.find(e => e.entryName.match(/^xl\/worksheets\/sheet1\.xml$/));
      if (sheetEntry) {
        const wsXml = sheetEntry.getData().toString("utf-8");
        // Find the first row's cell values
        const firstRowMatch = wsXml.match(/<row[^>]*r="1"[^>]*>([\s\S]*?)<\/row>/);
        if (firstRowMatch) {
          const headerText = stripTags(firstRowMatch[1]);
          if (headerText.trim().length > 3) parts.push("Column headers: " + headerText.trim());
        }
      }

      if (parts.length > 0) return parts.join(" ");
    }

    // ODT/ODP/ODS — content.xml
    if ([".odt", ".odp", ".ods"].includes(ext)) {
      const entry = zip.getEntry("content.xml");
      if (entry) {
        const text = stripTags(entry.getData().toString("utf-8"));
        if (text.length > 20) return text;
      }
    }
  } catch {
    // ZIP extraction failed
  }

  // RTF fallback
  if (ext === ".rtf") {
    try {
      const raw = fs.readFileSync(filePath, "utf-8").slice(0, MAX_READ_BYTES);
      return raw
        .replace(/\{[^}]*\}/g, " ")
        .replace(/\\[a-z]+\d*\s?/gi, " ")
        .replace(/[{}]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    } catch { /* */ }
  }

  return "";
}

/**
 * 6. IMAGE OCR — tesseract.js OCR for JPG, PNG, BMP, TIFF, WebP.
 */
async function extractImageOCR(filePath: string): Promise<string> {
  const worker = await getTesseractWorker();
  if (!worker) return "";

  try {
    console.log(
      `[TextExtraction] Running OCR on "${path.basename(filePath)}"...`
    );
    const { data } = await worker.recognize(filePath);
    const text = data?.text || "";

    if (text.trim().length === 0) {
      console.log(
        `[TextExtraction] OCR returned empty for "${path.basename(filePath)}"`
      );
      return "";
    }

    const wordCount = text.trim().split(/\s+/).length;
    console.log(
      `[TextExtraction] OCR extracted ${wordCount} words from "${path.basename(filePath)}"`
    );
    return text;
  } catch (err) {
    console.warn(
      `[TextExtraction] OCR failed for "${path.basename(filePath)}": ${err}`
    );
    return "";
  }
}

// ── Public API ─────────────────────────────────────────────

/**
 * Extract up to 2,000 clean words from any supported file.
 *
 * This is the single entry point. It runs through the extraction
 * hierarchy and ALWAYS returns a string — never throws, never crashes.
 *
 * Hierarchy:
 *   Text files  → direct read
 *   PDFs        → pdf-parse (gibberish check) → "" if fail
 *   DOCX        → mammoth → adm-zip fallback
 *   Office docs → adm-zip XML extraction
 *   Images      → tesseract.js OCR → text
 *   Unknown     → "" (graceful failure)
 */
export async function extractText(filePath: string): Promise<string> {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);

    // ── Native text files ──
    if (TEXT_EXTENSIONS.has(ext)) {
      try {
        return cleanOutput(extractNativeText(filePath));
      } catch {
        return "";
      }
    }

    // ── PDF: text-only pipeline ──
    if (PDF_EXTENSIONS.has(ext)) {
      try {
        const text = await extractPdf(filePath);
        return cleanOutput(text);
      } catch {
        return "";
      }
    }

    // ── DOCX documents ──
    if (DOCX_EXTENSIONS.has(ext)) {
      try {
        const text = await extractDocxNative(filePath);
        return cleanOutput(text);
      } catch {
        return "";
      }
    }

    // ── Other Office documents ──
    if (OFFICE_EXTENSIONS.has(ext)) {
      try {
        return cleanOutput(extractOfficeViaZip(filePath));
      } catch {
        return "";
      }
    }

    // ── Image OCR ──
    if (IMAGE_EXTENSIONS.has(ext)) {
      try {
        const text = await extractImageOCR(filePath);
        return cleanOutput(text);
      } catch {
        return "";
      }
    }

    // Unknown extension — graceful failure
    console.log(`[TextExtraction] Unknown extension "${ext}" for "${filename}"`);
    return "";
  } catch (err) {
    // Top-level safety net — NOTHING escapes this function as an error
    console.error(`[TextExtraction] Unexpected error for "${path.basename(filePath)}": ${err}`);
    return "";
  }
}

/**
 * Extract the FULL text from any supported file — no word or byte limits.
 *
 * Used by ChatService at query time so the AI can read the entire document
 * instead of the truncated snippet stored in the search index.
 *
 * Still runs gibberish/safety checks, but does NOT cap at 2,000 words
 * or 32 KB. The caller is responsible for any final truncation needed
 * to fit inside the LLM context window.
 */
export async function extractFullText(filePath: string): Promise<string> {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);

    // ── Native text files — read the whole file ──
    if (TEXT_EXTENSIONS.has(ext)) {
      try {
        let text = fs.readFileSync(filePath, "utf-8");
        if ([".html", ".htm", ".xml", ".svg", ".vue", ".svelte", ".astro"].includes(ext)) {
          text = stripTags(text);
        }
        return text.replace(/\s+/g, " ").trim();
      } catch { return ""; }
    }

    // ── PDF ──
    if (PDF_EXTENSIONS.has(ext)) {
      try {
        const text = await extractPdf(filePath);
        if (!text || text.trim().length < 5) return "";
        return text.replace(/\s+/g, " ").trim();
      } catch { return ""; }
    }

    // ── DOCX ──
    if (DOCX_EXTENSIONS.has(ext)) {
      try {
        const text = await extractDocxNative(filePath);
        if (!text || text.trim().length < 5) return "";
        return text.replace(/\s+/g, " ").trim();
      } catch { return ""; }
    }

    // ── Other Office ──
    if (OFFICE_EXTENSIONS.has(ext)) {
      try {
        const text = extractOfficeViaZip(filePath);
        if (!text || text.trim().length < 5) return "";
        return text.replace(/\s+/g, " ").trim();
      } catch { return ""; }
    }

    // ── Image OCR ──
    if (IMAGE_EXTENSIONS.has(ext)) {
      try {
        const text = await extractImageOCR(filePath);
        if (!text || text.trim().length < 5) return "";
        return text.replace(/\s+/g, " ").trim();
      } catch { return ""; }
    }

    console.log(`[TextExtraction] extractFullText: unknown ext "${ext}" for "${filename}"`);
    return "";
  } catch (err) {
    console.error(`[TextExtraction] extractFullText error for "${path.basename(filePath)}": ${err}`);
    return "";
  }
}

/**
 * Extract document property metadata (title, subject, author, keywords, etc.)
 * from PDF or DOCX files. Returns null for unsupported types or on failure.
 *
 * FIX 1: metadata signals for classification.
 */
export async function extractMetadata(filePath: string): Promise<FileMetadata | null> {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (PDF_EXTENSIONS.has(ext))  return await extractPdfMetadata(filePath);
    if (DOCX_EXTENSIONS.has(ext)) return extractDocxMetadata(filePath);
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract up to CLASSIFICATION_WORDS (15,000) clean words from any supported file.
 *
 * FIX 2: larger context window for classification versus the 2,000-word display snippet.
 * Still runs gibberish/safety checks. The caller (ClassificationService) further limits
 * what goes to Ollama (MAX_OLLAMA_CONTENT_WORDS = 3,000 for the prompt context window).
 */
export async function extractForClassification(filePath: string): Promise<string> {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);

    if (TEXT_EXTENSIONS.has(ext)) {
      try {
        let text = fs.readFileSync(filePath, "utf-8");
        if ([".html", ".htm", ".xml", ".svg", ".vue", ".svelte", ".astro"].includes(ext)) {
          text = stripTags(text);
        }
        return trimToWords(text.replace(/\s+/g, " ").trim(), CLASSIFICATION_WORDS);
      } catch { return ""; }
    }

    if (PDF_EXTENSIONS.has(ext)) {
      try {
        const text = await extractPdf(filePath);
        if (!text || text.trim().length < 5) return "";
        return trimToWords(text.replace(/\s+/g, " ").trim(), CLASSIFICATION_WORDS);
      } catch { return ""; }
    }

    if (DOCX_EXTENSIONS.has(ext)) {
      try {
        const text = await extractDocxNative(filePath);
        if (!text || text.trim().length < 5) return "";
        return trimToWords(text.replace(/\s+/g, " ").trim(), CLASSIFICATION_WORDS);
      } catch { return ""; }
    }

    if (OFFICE_EXTENSIONS.has(ext)) {
      try {
        const text = extractOfficeViaZip(filePath);
        if (!text || text.trim().length < 5) return "";
        return trimToWords(text.replace(/\s+/g, " ").trim(), CLASSIFICATION_WORDS);
      } catch { return ""; }
    }

    if (IMAGE_EXTENSIONS.has(ext)) {
      try {
        const text = await extractImageOCR(filePath);
        if (!text || text.trim().length < 5) return "";
        return trimToWords(text.replace(/\s+/g, " ").trim(), CLASSIFICATION_WORDS);
      } catch { return ""; }
    }

    console.log(`[TextExtraction] extractForClassification: unknown ext "${ext}" for "${filename}"`);
    return "";
  } catch (err) {
    console.error(`[TextExtraction] extractForClassification error for "${path.basename(filePath)}": ${err}`);
    return "";
  }
}

/**
 * Check extraction capabilities.
 */
export function checkExtractionCapabilities(): {
  pdfParse: boolean;
  mammoth: boolean;
  admZip: boolean;
  tesseractJs: boolean;
} {
  let pdfParse = false;
  let mammoth = false;
  let admZip = false;
  const tesseractJs = isTesseractAvailable();

  try {
    require.resolve("pdf-parse");
    pdfParse = true;
  } catch { /* */ }

  try {
    require.resolve("mammoth");
    mammoth = true;
  } catch { /* */ }

  try {
    require.resolve("adm-zip");
    admZip = true;
  } catch { /* */ }

  console.log(
    `[TextExtraction] Capabilities: pdf-parse=${pdfParse}, mammoth=${mammoth}, adm-zip=${admZip}, tesseract.js=${tesseractJs}`
  );

  return { pdfParse, mammoth, admZip, tesseractJs };
}

/**
 * Legacy alias — reports tesseract.js OCR availability.
 */
export function checkOCRAvailable(): {
  tesseractJs: boolean;
  pdfImgConvert: boolean;
  pdftotext: boolean;
} {
  return {
    tesseractJs: isTesseractAvailable(),
    pdfImgConvert: false,
    pdftotext: false,
  };
}

/**
 * Terminate the tesseract.js OCR worker (called on app quit).
 */
export async function terminateOCRWorker(): Promise<void> {
  if (_tesseractWorker) {
    try {
      await _tesseractWorker.terminate();
      console.log("[TextExtraction] tesseract.js worker terminated");
    } catch { /* */ }
    _tesseractWorker = null;
  }
}
