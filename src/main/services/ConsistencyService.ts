/**
 * ConsistencyService.ts — History-based pre-classification.
 *
 * Reads user_memory.json (maintained by LearningService) to find
 * patterns in past classifications. If the same "class key" extracted
 * from a filename has been consistently sent to the same folder
 * multiple times, return that folder as a high-confidence match
 * BEFORE the main AI pipeline runs.
 *
 * This is purely additive — it only fires when evidence is strong
 * and never overrides the PRE-CHECK (folder-name-in-filename) step.
 * It sits between PRE-CHECK and the Archives Ban so it is fast
 * and deterministic: zero AI calls, zero network, zero latency.
 *
 * Design rules:
 *   • MIN_HITS ≥ 2 past files must have the same class key
 *   • MIN_AGREEMENT ≥ 65 % of those files went to the SAME folder
 *   • The winning folder must still exist in the current workspace
 *   • Returns null (not an error) when evidence is insufficient
 *
 * ENHANCEMENTS (v2):
 *   • Confidence now SCALES with pattern strength (not a fixed 88%):
 *       2 files  @ 100% agreement → 88%
 *       3-4 files @ 100% agreement → 93%
 *       5+ files  @ 100% agreement → 97%
 *       2 files  @ 65-80% agreement → 75% (reduced — pattern is weak)
 *   • NOISE_TOKENS set greatly expanded: more academic noise,
 *     date patterns stripped via regex, version tags stripped.
 *   • More aggressive class key stripping: generic school words
 *     that add noise without adding subject signal.
 */

import fs from "fs";
import path from "path";
import { app } from "electron";

// ── Types ──────────────────────────────────────────────────────────────────

interface Correction {
  filename: string;
  extension: string;
  ai_guess: string;
  ai_confidence: number;
  user_correction: string;
  timestamp: number;
}

interface MemoryStore {
  correction_history: Correction[];
}

export interface HistoryBoost {
  /** The folder the file should go into based on past history */
  folder: string;
  /** Confidence score 0–100 to pass to the classification pipeline */
  confidence: number;
  /** The normalised key that triggered the match, for logging/reasoning */
  matchedKey: string;
  /** How many past files contributed to this decision */
  hitCount: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const MEMORY_FILE = "user_memory.json";

/**
 * Tokens that carry no subject meaning and should be stripped when
 * building a class key.
 *
 * EXPANDED (v2): covers more academic noise, version tags, platform terms,
 * and structural words that appear across all file types.
 *
 * NOTE: Date-like patterns are stripped via regex BEFORE this set is applied.
 */
const NOISE_TOKENS = new Set([
  // ── Assignment-type noise ──────────────────────────────────────────────
  "hw", "homework", "notes", "note", "test", "quiz",
  "chapter", "ch", "unit", "un", "practice", "prac",
  "exam", "final", "midterm", "review",
  "worksheet", "ws", "study", "guide",
  "lab", "assignment", "asgmt", "project", "proj",
  "reading", "rd", "lecture", "lec",
  "problem", "set", "ps",
  "discussion", "disc", "section", "sec",
  "part", "pt", "due", "draft",
  "submission", "sub", "copy", "backup",
  "version", "ver",
  // ── Extra academic noise (new) ────────────────────────────────────────
  "answers", "answer", "key", "solutions", "solution",
  "handout", "packet", "worksheet", "activity",
  "extra", "credit", "ec", "bonus",
  "makeup", "retake", "redo",
  "graded", "returned", "feedback",
  "outline", "overview", "summary",
  "template", "example", "sample",
  "blank", "completed", "corrected",
  "annotated", "marked",
  // ── File version/revision noise (new) ────────────────────────────────
  "v1", "v2", "v3", "v4", "v5", "vf", "vfinal",
  "rev", "revision", "updated", "new", "old",
  "latest", "current", "previous", "original",
  "final", "draft", "wip",
  // ── Month / day names ─────────────────────────────────────────────────
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
  "january", "february", "march", "april",
  "june", "july", "august", "september", "october",
  "november", "december",
  "monday", "tuesday", "wednesday", "thursday",
  "friday", "saturday", "sunday",
  "mon", "tue", "wed", "thu", "fri", "sat", "sun",
  // ── Semester / quarter (new) ──────────────────────────────────────────
  "fall", "spring", "summer", "winter",
  "semester", "sem", "quarter", "qtr", "trimester",
  "q1", "q2", "q3", "q4",
  // ── Common English stop words ─────────────────────────────────────────
  "the", "and", "for", "with", "of", "in",
  "to", "a", "an", "is", "was", "are", "my",
  "this", "that", "it", "its",
  "from", "by", "at", "on", "up", "as",
  // ── Generic document/file words (new) ────────────────────────────────
  "document", "doc", "file", "page",
  "pdf", "docx", "pptx", "xlsx",
  "scan", "scanned", "copy", "print",
  "misc", "miscellaneous", "general", "other",
  "info", "information", "data",
  // ── Generic memo/brief/report words ──────────────────────────────────
  "memo", "brief", "report", "letter", "email", "message",
  "form", "sheet", "chart", "table", "list", "log",
  "overview", "intro", "introduction", "conclusion",
]);

/** Minimum number of past hits to the SAME folder before trusting the pattern. */
const MIN_HITS = 2;

/** Minimum agreement fraction (same folder / total hits for this class key). */
const MIN_AGREEMENT = 0.65;

// ── File I/O ───────────────────────────────────────────────────────────────

function getMemoryPath(): string {
  return path.join(app.getPath("userData"), MEMORY_FILE);
}

function loadHistory(): Correction[] {
  try {
    const filePath = getMemoryPath();
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as MemoryStore;
    if (Array.isArray(data?.correction_history)) {
      return data.correction_history;
    }
  } catch {
    // Corrupted or missing file — fail silently
  }
  return [];
}

// ── Class Key Extraction ───────────────────────────────────────────────────

/**
 * Derive a stable, normalised "class key" from a filename.
 *
 * Strategy (enhanced v2):
 *   1. Strip the file extension
 *   2. Strip date-like patterns (MM-DD-YYYY, YYYY-MM-DD, etc.)
 *   3. Lowercase
 *   4. Split on whitespace / hyphens / underscores / punctuation
 *   5. Remove pure-numeric tokens (numbers carry no subject identity)
 *   6. Remove tokens that look like version tags (v1, v2, etc.)
 *   7. Remove noise tokens (see NOISE_TOKENS above)
 *   8. Keep the first 1–3 remaining subject tokens, joined by space
 *
 * Examples (enhanced):
 *   "PreCalc HW1.pdf"                → "precalc"
 *   "APUSH DBQ Practice.docx"        → "apush dbq"
 *   "Bio Lab 3 Report.pdf"           → "bio report"
 *   "Chem Unit 4 Test.pdf"           → "chem"
 *   "History Notes Ch 5.pdf"         → "history"
 *   "Spanish Vocab Quiz 7.pdf"       → "spanish vocab"
 *   "APUSH Unit 5 Test 2024.pdf"     → "apush"
 *   "Precalc HW Chapter 3.docx"     → "precalc"
 *   "Contract Law Memo v2 Final.pdf" → "contract law"
 *   "Tax Return 2023 Q4 Draft.pdf"   → "tax return"
 */
export function extractClassKey(filename: string): string {
  let nameOnly = filename.replace(/\.[^.]+$/, ""); // strip extension

  // Strip date-like patterns FIRST (before splitting).
  nameOnly = nameOnly
    // MM-DD-YYYY, DD-MM-YYYY
    .replace(/\b\d{1,2}[-./]\d{1,2}[-./]\d{2,4}\b/g, " ")
    // YYYY-MM-DD
    .replace(/\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b/g, " ")
    // Standalone 4-digit years (e.g., "2024")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    // Version tags like "v1", "v2", "v1.2", "v10"
    .replace(/\bv\d+(\.\d+)*\b/gi, " ");

  const tokens = nameOnly
    .toLowerCase()
    .split(/[\s\-_()\[\].,;:!?/\\]+/)   // split on common separators
    .map((t) => t.replace(/[^a-z]/g, "")) // letters only
    .filter((t) => t.length >= 2)         // drop single-char tokens
    .filter((t) => !/^\d+$/.test(t))      // drop pure numbers
    .filter((t) => !NOISE_TOKENS.has(t)); // drop noise words

  return tokens.slice(0, 3).join(" ").trim();
}

// ── Confidence Scaling ─────────────────────────────────────────────────────

/**
 * Compute confidence based on pattern strength.
 *
 * ENHANCED (v2): confidence now scales with both hit count AND agreement:
 *
 *   5+ hits @ ≥90% agreement → 97% (very strong, trusted pattern)
 *   3-4 hits @ ≥90% agreement → 93% (strong pattern)
 *   2+ hits @ ≥90% agreement → 88% (solid pattern — previous default)
 *   2+ hits @ 65-89% agreement → 75% (weak agreement — reduced confidence)
 *
 * Strong patterns deserve more trust; weak ones deserve less.
 */
function computeHistoryConfidence(hitCount: number, agreement: number): number {
  if (hitCount >= 5 && agreement >= 0.9) return 97;
  if (hitCount >= 3 && agreement >= 0.9) return 93;
  if (hitCount >= 2 && agreement >= 0.9) return 88;
  if (hitCount >= 2 && agreement >= MIN_AGREEMENT) return 75;
  return 0;
}

// ── Token Overlap Matching ─────────────────────────────────────────────────

/**
 * Return true if classKey A and classKey B share enough tokens to be
 * considered the "same subject."
 *
 * Rules:
 *   - At least 1 shared token
 *   - The shared tokens must be ≥ 50 % of the SHORTER key's token count
 *     (prevents "math" from wrongly matching "math english science")
 */
function keysOverlap(keyA: string, keyB: string): boolean {
  if (!keyA || !keyB) return false;
  const tokensA = keyA.split(" ");
  const tokensB = keyB.split(" ");
  const shared = tokensA.filter((t) => tokensB.includes(t));
  if (shared.length === 0) return false;
  const shorter = Math.min(tokensA.length, tokensB.length);
  return shared.length >= Math.ceil(shorter * 0.5);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Check if past classification history gives a strong signal for
 * how to classify this file.
 *
 * Returns a HistoryBoost when:
 *   - The class key is non-empty
 *   - ≥ MIN_HITS past files with overlapping class keys all went to
 *     the same folder
 *   - That folder accounts for ≥ MIN_AGREEMENT of all overlapping hits
 *   - The folder still exists in the user's current workspace
 *
 * Returns null when evidence is insufficient or ambiguous — callers
 * should fall through to the normal classification pipeline.
 */
export function getHistoryBoost(
  filename: string,
  userFolders: string[]
): HistoryBoost | null {
  const classKey = extractClassKey(filename);
  if (!classKey) return null;

  const history = loadHistory();
  if (history.length === 0) return null;

  // Build a case-insensitive lookup of current workspace folders
  const folderSet = new Set(userFolders.map((f) => f.toLowerCase()));

  // Tally votes: destination folder → count of overlapping past entries
  const tally = new Map<string, number>();

  for (const entry of history) {
    if (!entry.user_correction) continue;

    const entryKey = extractClassKey(entry.filename);
    if (!entryKey) continue;

    if (!keysOverlap(classKey, entryKey)) continue;

    const dest = entry.user_correction.trim();
    tally.set(dest, (tally.get(dest) ?? 0) + 1);
  }

  if (tally.size === 0) return null;

  // Find the plurality winner
  let topFolder = "";
  let topCount = 0;
  let totalCount = 0;

  for (const [folder, count] of tally) {
    totalCount += count;
    if (count > topCount) {
      topCount = count;
      topFolder = folder;
    }
  }

  // Not enough consistent evidence
  if (topCount < MIN_HITS) return null;

  const agreement = topCount / totalCount;
  if (agreement < MIN_AGREEMENT) return null;

  // Verify this folder still exists in the current workspace
  if (!folderSet.has(topFolder.toLowerCase())) return null;

  // Compute confidence based on pattern strength (enhanced v2).
  const confidence = computeHistoryConfidence(topCount, agreement);
  if (confidence === 0) return null;

  // Return the canonical folder name (original casing from workspace scan)
  const canonicalFolder =
    userFolders.find((f) => f.toLowerCase() === topFolder.toLowerCase()) ??
    topFolder;

  console.log(
    `[ConsistencyService] HISTORY MATCH: classKey="${classKey}" → ` +
      `"${canonicalFolder}" (${topCount}/${totalCount} = ` +
      `${Math.round(agreement * 100)}% agreement → ${confidence}% confidence)`
  );

  return {
    folder: canonicalFolder,
    confidence,
    matchedKey: classKey,
    hitCount: topCount,
  };
}
