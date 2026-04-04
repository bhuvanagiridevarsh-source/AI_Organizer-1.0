/**
 * PoolEnrichmentService.ts — Wires user corrections to concept pool updates.
 *
 * Called after every confirmed user correction. Extracts the most distinctive
 * terms from the corrected filename and adds them to the target folder's pool.
 *
 * This is the missing link between the LearningService (which records
 * corrections) and the PoolManager (which stores subject-term mappings).
 *
 * DESIGN RULES:
 *   - Only processes corrections where should_learn_from = true (AI confidence ≥ 60%)
 *   - Scores candidate terms by: folder frequency × 50 + distinctiveness × 0.5
 *   - Adds top MIN(5, eligible) terms to the target folder's concept pool
 *   - Cold start mode: when targetFolder has <COLD_START_THRESHOLD files seen,
 *     bypasses the confidence gate and adds up to COLD_START_TERM_LIMIT terms
 *   - Never adds terms shorter than 3 chars or already in the pool
 *   - All additions route through addTermsToPool() for validation
 *
 * COLD START BOOTSTRAP (Problem 5):
 *   - Sparse folders (< 10 prior classifications) get up to 10 terms instead of 5
 *   - The confidence gate (should_learn_from) is bypassed for cold start folders
 *   - Once a folder accumulates ≥ 10 classifications, normal rules apply
 */

import path from "path";
import {
  getLearningCorrectionsForFolder,
  getLearningEligibleCorrections,
  getAllCorrections,
} from "./LearningService";
import type { Correction } from "./LearningService";
import {
  addTermsToPool,
  readMergedPool,
  computeDistinctivenessScore,
} from "../intelligence/universal-pool-manager";
import { isQualityTerm } from "./KnowledgeGraphService";

// ── Configuration ──────────────────────────────────────────────────────────

/** Maximum terms to add per correction in normal mode. */
const MAX_TERMS_PER_CORRECTION = 5;

/** Cold start: folders with fewer than this many prior corrections get extra terms. */
const COLD_START_THRESHOLD = 10;

/** Cold start: add up to this many terms (instead of MAX_TERMS_PER_CORRECTION). */
const COLD_START_TERM_LIMIT = 10;

/** Minimum token length for a term to be considered. */
const MIN_TERM_LENGTH = 3;

/**
 * Noise tokens to strip from filenames during term extraction.
 * Matches the ConsistencyService NOISE_TOKENS set for consistency.
 */
const NOISE_TOKENS = new Set([
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
  "answers", "answer", "key", "solutions", "solution",
  "handout", "packet", "activity",
  "extra", "credit", "ec", "bonus",
  "makeup", "retake", "redo",
  "graded", "returned", "feedback",
  "outline", "overview", "summary",
  "template", "example", "sample",
  "blank", "completed", "corrected",
  "annotated", "marked",
  "v1", "v2", "v3", "v4", "v5", "vf", "vfinal",
  "rev", "revision", "updated", "new", "old",
  "latest", "current", "previous", "original",
  "wip",
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
  "january", "february", "march", "april",
  "june", "july", "august", "september", "october",
  "november", "december",
  "monday", "tuesday", "wednesday", "thursday",
  "friday", "saturday", "sunday",
  "mon", "tue", "wed", "thu", "fri", "sat", "sun",
  "fall", "spring", "summer", "winter",
  "semester", "sem", "quarter", "qtr", "trimester",
  "q1", "q2", "q3", "q4",
  "the", "and", "for", "with", "of", "in",
  "to", "a", "an", "is", "was", "are", "my",
  "this", "that", "it", "its",
  "from", "by", "at", "on", "up", "as",
  "document", "doc", "file", "page",
  "pdf", "docx", "pptx", "xlsx",
  "scan", "scanned", "print",
  "misc", "miscellaneous", "general", "other",
  "info", "information", "data",
  "memo", "brief", "report", "letter", "email", "message",
  "form", "sheet", "chart", "table", "list", "log",
  "intro", "introduction", "conclusion",
]);

// ── Term Extraction ─────────────────────────────────────────────────────────

/**
 * Extract candidate subject terms from a filename.
 * Strips extension, date patterns, version tags, noise words.
 * Returns lowercase tokens suitable for pool enrichment.
 */
function extractTermsFromFilename(filename: string): string[] {
  let nameOnly = filename.replace(/\.[^.]+$/, ""); // strip extension

  // Strip date-like patterns
  nameOnly = nameOnly
    .replace(/\b\d{1,2}[-./]\d{1,2}[-./]\d{2,4}\b/g, " ")
    .replace(/\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\bv\d+(\.\d+)*\b/gi, " ");

  return nameOnly
    .toLowerCase()
    .split(/[\s\-_()\[\].,;:!?/\\]+/)
    .map((t) => t.replace(/[^a-z]/g, ""))
    .filter((t) => t.length >= MIN_TERM_LENGTH)
    .filter((t) => !/^\d+$/.test(t))
    .filter((t) => !NOISE_TOKENS.has(t));
}

// ── Term Scoring ────────────────────────────────────────────────────────────

interface ScoredTerm {
  term: string;
  score: number;
}

/**
 * Score candidate terms for pool enrichment quality.
 *
 * Scoring formula (as specified):
 *   score = (folderFrequency × 50) + (distinctiveness × 0.5)
 *
 * Where:
 *   - folderFrequency: fraction of past corrections for this folder that
 *     contain this term (0-1). Terms appearing repeatedly in the same
 *     folder's corrections are most valuable.
 *   - distinctiveness: how exclusive this term is to this folder vs. other
 *     folders in the pool (0-100). Low distinctiveness = bad pool citizen.
 *
 * @param candidates - Raw tokens from the current filename.
 * @param folderCorrections - All eligible past corrections for this folder.
 * @param currentPools - Current state of all concept pools.
 * @param targetFolder - The folder being enriched.
 * @returns Terms ranked by score, highest first.
 */
function scoreTerms(
  candidates: string[],
  folderCorrections: Correction[],
  currentPools: Record<string, string[]>,
  targetFolder: string
): ScoredTerm[] {
  if (candidates.length === 0) return [];

  const totalFolders = Object.keys(currentPools).length;

  // Build term→folder map for distinctiveness computation
  const termFolderMap = new Map<string, Set<string>>();
  for (const [folder, terms] of Object.entries(currentPools)) {
    for (const t of terms) {
      const key = t.toLowerCase().trim();
      if (!termFolderMap.has(key)) termFolderMap.set(key, new Set());
      termFolderMap.get(key)!.add(folder);
    }
  }

  // Compute how often each candidate term appears in past folder corrections
  const termFreqInFolder = new Map<string, number>();
  if (folderCorrections.length > 0) {
    for (const correction of folderCorrections) {
      const corrTerms = extractTermsFromFilename(correction.filename);
      for (const t of corrTerms) {
        termFreqInFolder.set(t, (termFreqInFolder.get(t) ?? 0) + 1);
      }
    }
  }

  const scored: ScoredTerm[] = candidates.map((term) => {
    // Folder frequency (0-1): how often this term appears in past corrections
    const rawFreq = termFreqInFolder.get(term) ?? 0;
    const folderFrequency = folderCorrections.length > 0
      ? rawFreq / folderCorrections.length
      : 0;

    // Distinctiveness (0-100): how exclusive to this folder
    const distinctiveness = computeDistinctivenessScore(
      term,
      termFolderMap,
      totalFolders
    );

    const score = (folderFrequency * 50) + (distinctiveness * 0.5);
    return { term, score };
  });

  return scored.sort((a, b) => b.score - a.score);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Enrich the concept pool for a folder based on a just-recorded correction.
 *
 * Called immediately after submitCorrection() records a user action.
 * Extracts the best terms from the corrected filename and adds them to
 * the target folder's pool via the validated addTermsToPool() gate.
 *
 * @param filename - The file that was just corrected/confirmed.
 * @param targetFolder - The folder the user chose (user_correction).
 * @param aiConfidence - AI confidence at classification time.
 * @param targetDir - Directory containing pool files.
 * @returns Number of terms added to the pool.
 */
export function enrichPoolFromCorrection(
  filename: string,
  targetFolder: string,
  aiConfidence: number,
  targetDir: string
): number {
  try {
    const currentPools = readMergedPool(targetDir);

    // Count ALL past corrections to this folder (regardless of confidence)
    // to determine if it's a cold start folder.
    // Using total count (not just learning-eligible) ensures accurate graduation:
    // once a folder accumulates 10 total files, it graduates out of cold start.
    const totalFolderCount = getAllCorrections().filter(
      (c) => c.user_correction.toLowerCase() === targetFolder.toLowerCase()
    ).length;
    const isColdStart = totalFolderCount < COLD_START_THRESHOLD;

    // For frequency scoring, still use only learning-eligible corrections
    // (those with ai_confidence >= 60) to avoid noisy frequency signals.
    const allFolderCorrections = getLearningCorrectionsForFolder(targetFolder);

    // Cold start: bypass confidence gate for sparse folders
    // Normal mode: only process corrections with should_learn_from=true (ai_confidence >= 60)
    const isTrusted = aiConfidence >= 60;
    if (!isTrusted && !isColdStart) {
      console.log(
        `[PoolEnrichment] Skipping "${filename}" → "${targetFolder}": ` +
        `ai_confidence=${aiConfidence} < 60 and not cold start`
      );
      return 0;
    }

    // Extract candidate terms from the filename
    const rawCandidates = extractTermsFromFilename(filename);
    // Apply central quality gate (blocks generic terms, pure numbers, cross-pool noise)
    const candidates = rawCandidates.filter((t) => isQualityTerm(t, currentPools));
    if (candidates.length === 0) {
      console.log(`[PoolEnrichment] No quality terms extracted from "${filename}"`);
      return 0;
    }

    // Score candidates using folder history + distinctiveness
    // For cold start, we have fewer corrections to draw on — that's fine,
    // distinctiveness still kicks in to prevent pollution.
    const scored = scoreTerms(candidates, allFolderCorrections, currentPools, targetFolder);

    // Select top N terms (more in cold start mode for bootstrapping)
    const limit = isColdStart ? COLD_START_TERM_LIMIT : MAX_TERMS_PER_CORRECTION;
    const topTerms = scored.slice(0, limit).map((s) => s.term);

    if (topTerms.length === 0) return 0;

    // Add through the validated pool manager gate
    const added = addTermsToPool(topTerms, targetFolder, targetDir);

    if (added > 0) {
      console.log(
        `[PoolEnrichment] "${filename}" → "${targetFolder}": ` +
        `added ${added}/${topTerms.length} terms` +
        (isColdStart ? " [COLD START MODE]" : "") +
        `. Top: [${topTerms.slice(0, 3).join(", ")}]`
      );
    }

    return added;
  } catch (err) {
    console.error(`[PoolEnrichment] Error enriching pool for "${targetFolder}": ${err}`);
    return 0;
  }
}

/**
 * Run a bulk enrichment pass over ALL existing learning-eligible corrections.
 *
 * Useful for bootstrapping: if corrections have been recorded before this
 * service existed, this catches up by processing every eligible record.
 * Safe to call multiple times — addTermsToPool() deduplicates.
 *
 * @param targetDir - Directory containing pool files.
 * @returns Total number of terms added across all corrections.
 */
export function bulkEnrichFromHistory(targetDir: string): number {
  const eligible = getLearningEligibleCorrections();
  if (eligible.length === 0) {
    console.log("[PoolEnrichment] No learning-eligible corrections found for bulk enrichment.");
    return 0;
  }

  let totalAdded = 0;
  for (const correction of eligible) {
    const added = enrichPoolFromCorrection(
      correction.filename,
      correction.user_correction,
      correction.ai_confidence,
      targetDir
    );
    totalAdded += added;
  }

  console.log(
    `[PoolEnrichment] Bulk enrichment complete: processed ${eligible.length} corrections, ` +
    `added ${totalAdded} terms total.`
  );

  return totalAdded;
}
