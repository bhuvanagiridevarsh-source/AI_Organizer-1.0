/**
 * LearningService.ts — Local active learning memory.
 *
 * Saves user corrections to user_memory.json so the AI learns
 * from mistakes without any data leaving the device.
 *
 * The correction history is injected into every future prompt
 * as few-shot examples, so the model adapts to this specific
 * user's organizational preferences over time.
 *
 * ENHANCEMENTS (v2):
 *   - `should_learn_from` flag: only extract pool terms from
 *     corrections where AI confidence was ≥ 40%. Below that,
 *     the AI had zero directional signal — polluting pools is harmful.
 *     40% is the sweet spot: catches valuable ambiguous-file corrections
 *     while still filtering pure noise.
 *   - Content-similarity scoring for few-shot injection: past
 *     corrections are ranked by term overlap with the current file,
 *     not just recency. Produces more relevant examples.
 */

import fs from "fs";
import path from "path";
import { app } from "electron";

// ── Types ──────────────────────────────────────────────────

export interface Correction {
  filename: string;
  extension: string;
  ai_guess: string;
  ai_confidence: number;
  user_correction: string;
  timestamp: number;
  /**
   * Short content hint (≤12 words) stored alongside the correction.
   * Used when injecting past corrections as few-shot examples so the
   * model understands WHY a file went to a folder, not just that it did.
   * Example: "Newton's laws, projectile motion"
   */
  content_hint?: string;
  /**
   * If true, this correction has high enough AI confidence (≥60%)
   * that the file's terms can be trusted to enrich concept pools.
   * If false (AI was guessing), do NOT extract terms from this file.
   */
  should_learn_from: boolean;
}

interface MemoryStore {
  correction_history: Correction[];
}

// ── Configuration ──────────────────────────────────────────

const MAX_HISTORY = 200; // cap total corrections stored
const MAX_PROMPT_EXAMPLES = 10; // how many examples to inject into prompts
const MEMORY_FILE = "user_memory.json";

/**
 * Minimum AI confidence for a correction to be trusted for pool updates.
 * Below this threshold, the AI was effectively guessing → don't pollute pools.
 */
// Lowered from 60 → 40: the most valuable corrections are on ambiguous files
// (50-65% confidence). At 40% the AI still has a directional opinion — it's
// not pure noise — and the user's correction is ground truth we shouldn't waste.
const MIN_CONFIDENCE_FOR_LEARNING = 40;

// ── File I/O ───────────────────────────────────────────────

function getMemoryPath(): string {
  return path.join(app.getPath("userData"), MEMORY_FILE);
}

function loadStore(): MemoryStore {
  const filePath = getMemoryPath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.correction_history)) {
        // Back-fill should_learn_from for old records that predate this field.
        const history = data.correction_history.map((c: Correction) => ({
          ...c,
          should_learn_from:
            c.should_learn_from ??
            (c.ai_confidence >= MIN_CONFIDENCE_FOR_LEARNING),
        }));
        return { correction_history: history };
      }
    }
  } catch {
    // Corrupted file — start fresh
  }
  return { correction_history: [] };
}

function saveStore(store: MemoryStore): void {
  const filePath = getMemoryPath();
  try {
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    console.error(`[LearningService] Failed to save: ${err}`);
  }
}

// ── Term extraction (for similarity scoring) ────────────────

/** Common noise tokens to strip when extracting terms from filenames. */
const FILENAME_NOISE = new Set([
  "hw", "homework", "notes", "note", "test", "quiz", "chapter", "ch",
  "unit", "un", "practice", "prac", "exam", "final", "midterm", "review",
  "worksheet", "ws", "study", "guide", "lab", "assignment", "asgmt",
  "project", "proj", "reading", "rd", "lecture", "lec", "problem", "set",
  "ps", "discussion", "disc", "section", "sec", "part", "pt", "due",
  "draft", "submission", "sub", "copy", "backup", "version", "ver",
  "the", "and", "for", "with", "of", "in", "to", "a", "an", "is",
  "was", "are", "my", "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
]);

/**
 * Extract meaningful subject tokens from a filename string.
 * Strips extension, noise words, pure numbers, and date patterns.
 */
function extractFilenameTerms(filename: string): Set<string> {
  const nameOnly = filename.replace(/\.[^.]+$/, ""); // strip extension
  const tokens = nameOnly
    .toLowerCase()
    // Strip date-like patterns (e.g., 2024-01-15, 01/15/24)
    .replace(/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g, " ")
    .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, " ")
    .split(/[\s\-_()\[\].,;:!?/\\]+/)
    .map((t) => t.replace(/[^a-z]/g, ""))
    .filter((t) => t.length >= 2)
    .filter((t) => !/^\d+$/.test(t))       // drop pure numbers
    .filter((t) => !FILENAME_NOISE.has(t)); // drop noise words

  return new Set(tokens);
}

/**
 * Compute term overlap score between two filenames.
 * Higher = more similar subject matter.
 */
function computeTermOverlap(filenameA: string, filenameB: string): number {
  const termsA = extractFilenameTerms(filenameA);
  const termsB = extractFilenameTerms(filenameB);

  if (termsA.size === 0 || termsB.size === 0) return 0;

  let shared = 0;
  for (const term of termsA) {
    if (termsB.has(term)) shared++;
  }

  // Overlap fraction relative to the smaller set.
  const smaller = Math.min(termsA.size, termsB.size);
  return shared / smaller;
}

// ── Public API ─────────────────────────────────────────────

/**
 * Record a user correction (or confirmation of correct AI guess).
 *
 * Sets `should_learn_from = true` when ai_confidence ≥ 40%,
 * meaning the AI had enough conviction that the file terms are
 * representative of the user_correction folder.
 *
 * Records with low AI confidence are still stored (for few-shot
 * injection) but are flagged so pool extraction skips them.
 */
export function recordCorrection(correction: Omit<Correction, "should_learn_from">): void {
  const store = loadStore();

  const fullRecord: Correction = {
    ...correction,
    should_learn_from: correction.ai_confidence >= MIN_CONFIDENCE_FOR_LEARNING,
  };

  store.correction_history.push(fullRecord);

  // Trim to MAX_HISTORY, keeping the most recent.
  if (store.correction_history.length > MAX_HISTORY) {
    store.correction_history = store.correction_history.slice(-MAX_HISTORY);
  }

  saveStore(store);
  console.log(
    `[LearningService] Recorded: "${correction.filename}" ` +
      `AI=${correction.ai_guess} → User=${correction.user_correction} ` +
      `(learn_from=${fullRecord.should_learn_from})`
  );
}

/**
 * Get the most relevant past corrections for prompt injection.
 *
 * ENHANCED PRIORITIZATION (v2):
 *   1. Term overlap with current filename (content similarity — most relevant)
 *   2. Same file extension (file-type match)
 *   3. Recency (30-day decay)
 *
 * Returns up to MAX_PROMPT_EXAMPLES corrections, most relevant first.
 */
export function getRelevantExamples(
  currentFilename?: string,
  currentExtension?: string
): Correction[] {
  const store = loadStore();
  const history = store.correction_history;

  if (history.length === 0) return [];

  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  /**
   * Score a past correction for relevance to the current file.
   * Higher score = more relevant = higher priority for injection.
   */
  function scoreCorrection(c: Correction): number {
    let score = 0;

    // Term overlap (0-1): highest weight — same subject matter.
    if (currentFilename) {
      const overlap = computeTermOverlap(currentFilename, c.filename);
      score += overlap * 100; // max 100 points
    }

    // Extension match: strong signal — same file type.
    if (
      currentExtension &&
      c.extension &&
      c.extension.toLowerCase() === currentExtension.toLowerCase()
    ) {
      score += 30;
    }

    // Recency factor: recent corrections are fresher/more reliable.
    const ageFactor = c.timestamp > now - THIRTY_DAYS_MS ? 1.0 : 0.5;
    // Recency contributes up to 20 points (normalized to 0-20 range).
    const recencyScore = (c.timestamp / now) * 20 * ageFactor;
    score += recencyScore;

    return score;
  }

  // Score every correction and sort descending.
  const scored = history
    .map((c) => ({ correction: c, score: scoreCorrection(c) }))
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, MAX_PROMPT_EXAMPLES).map((s) => s.correction);
}

/**
 * Build a prompt-ready "Past corrections" block from past corrections.
 *
 * Format matches the fine-tuning training data exactly so the model
 * knows how to use it:
 *
 *   Past corrections from this user:
 *   - "hw.pdf" (Newton's laws, projectile motion) → Physics
 *   - "chapter_8.pdf" (Missouri Compromise, antebellum) → History
 *
 * Returns an empty string if no corrections exist yet.
 */
export function buildLearningBlock(
  currentFilename?: string,
  currentExtension?: string
): string {
  const examples = getRelevantExamples(currentFilename, currentExtension);
  if (examples.length === 0) return "";

  const lines = ["Past corrections from this user:"];

  for (const c of examples) {
    // Include content hint if stored, otherwise just show filename → folder
    const hint = c.content_hint ? ` (${c.content_hint})` : "";
    lines.push(`- "${c.filename}"${hint} → ${c.user_correction}`);
  }

  return lines.join("\n");
}

/**
 * Get all corrections that should be used for pool updates.
 * Filters out low-confidence records (AI was guessing randomly).
 */
export function getLearningEligibleCorrections(): Correction[] {
  return loadStore().correction_history.filter((c) => c.should_learn_from);
}

/**
 * Get corrections for a specific target folder,
 * eligible for pool term extraction.
 */
export function getLearningCorrectionsForFolder(folder: string): Correction[] {
  return loadStore()
    .correction_history.filter(
      (c) =>
        c.should_learn_from &&
        c.user_correction.toLowerCase() === folder.toLowerCase()
    );
}

/**
 * Get all corrections (for settings/debug display).
 */
export function getAllCorrections(): Correction[] {
  return loadStore().correction_history;
}

/**
 * Get stats about the learning memory.
 */
export function getStats(): {
  total_corrections: number;
  unique_categories: number;
  most_corrected_from: string;
  most_corrected_to: string;
  learning_eligible: number;
} {
  const history = loadStore().correction_history;

  const fromCounts: Record<string, number> = {};
  const toCounts: Record<string, number> = {};
  const cats = new Set<string>();
  let learningEligible = 0;

  for (const c of history) {
    fromCounts[c.ai_guess] = (fromCounts[c.ai_guess] || 0) + 1;
    toCounts[c.user_correction] = (toCounts[c.user_correction] || 0) + 1;
    cats.add(c.ai_guess);
    cats.add(c.user_correction);
    if (c.should_learn_from) learningEligible++;
  }

  const topFrom = Object.entries(fromCounts).sort((a, b) => b[1] - a[1])[0];
  const topTo = Object.entries(toCounts).sort((a, b) => b[1] - a[1])[0];

  return {
    total_corrections: history.length,
    unique_categories: cats.size,
    most_corrected_from: topFrom ? topFrom[0] : "none",
    most_corrected_to: topTo ? topTo[0] : "none",
    learning_eligible: learningEligible,
  };
}

/**
 * Clear all learning data (reset).
 */
export function clearMemory(): void {
  saveStore({ correction_history: [] });
}
