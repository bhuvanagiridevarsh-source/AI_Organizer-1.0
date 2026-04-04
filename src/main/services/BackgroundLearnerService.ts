/**
 * BackgroundLearnerService.ts — Idle-time self-learning engine.
 *
 * Runs on the user's CPU during idle periods to continuously improve
 * classification accuracy by studying already-organized files.
 *
 * HOW IT WORKS:
 *   The user already has organized files sitting in correctly-labeled
 *   folders — those are ground-truth training examples. This service
 *   reads those files during idle time, extracts distinctive terms,
 *   and enriches the concept pools that power the deterministic
 *   classification layers.
 *
 *   Result: more files hit the high-confidence auto-move path,
 *   so users get asked to confirm far fewer things over time.
 *
 * RESOURCE SAFETY:
 *   - Only runs when CPU idle % is above IDLE_THRESHOLD (default 60%)
 *   - Processes ONE file at a time with a yield delay between each
 *   - Pauses immediately when any user interaction is detected
 *   - Caps at MAX_FILES_PER_SESSION files per app session
 *   - Uses a persistent progress ledger so it never re-processes a file
 *
 * WHAT IT LEARNS:
 *   1. Term frequency per folder — finds vocabulary unique to each folder
 *   2. N-gram extraction (2-word phrases) — "balance sheet", "AP exam"
 *   3. Filename pattern mining — common name structures per folder
 *   4. Folder fingerprint refresh — keeps context cache current
 */

import fs   from "fs";
import path from "path";
import os   from "os";

import { addTermsToPool }           from "../intelligence/universal-pool-manager";
import { extractForClassification } from "./TextExtractionService";

const { scanUserFolders } = require("./fileService");

// ── Configuration ──────────────────────────────────────────────────────────

/** Only run when CPU idle% is at or above this threshold. */
const IDLE_THRESHOLD_PCT = 55;

/** Milliseconds to yield between files — keeps UI buttery-smooth. */
const YIELD_MS = 800;

/** Yield longer when CPU is borderline idle (55-70%). */
const YIELD_MS_CAUTIOUS = 2000;

/** Maximum files enriched per session (resets when app restarts). */
const MAX_FILES_PER_SESSION = 200;

/** Words to skip — too generic to be useful in any concept pool. */
const GENERIC_STOP_WORDS = new Set([
  "the","and","for","are","was","were","this","that","with","from","have",
  "has","had","not","but","can","will","all","any","may","use","used","also",
  "file","files","doc","document","documents","page","pages","data","info",
  "information","note","notes","new","old","copy","version","draft","final",
  "part","item","items","list","type","date","time","year","number","name",
  "hello","please","thank","thanks","regards","dear","sincerely","attached",
  "attachment","see","enclosed","review","regarding","subject","re","fwd",
  "per","as","of","to","in","on","at","by","or","be","an","a","i",
]);

/** Minimum term length (characters). */
const MIN_TERM_LEN = 3;
/** Maximum term length to avoid garbled OCR artifacts. */
const MAX_TERM_LEN = 40;

/** Minimum times a term must appear in a file to be considered significant. */
const MIN_TERM_FREQ = 2;

/** Max terms extracted from a single file. */
const MAX_TERMS_PER_FILE = 40;

// ── Types ──────────────────────────────────────────────────────────────────

export interface LearnerStatus {
  running: boolean;
  paused: boolean;
  filesProcessed: number;
  termsAdded: number;
  currentFolder: string | null;
  ledgerSize: number;
  lastRunAt: number | null;
}

interface ProcessedLedger {
  /** filePath → timestamp when it was last processed */
  files: Record<string, number>;
  version: number;
}

// ── Internal state ─────────────────────────────────────────────────────────

let _running   = false;
let _paused    = false;
let _stopFlag  = false;

let _filesProcessed   = 0;
let _termsAdded       = 0;
let _currentFolder: string | null = null;

let _targetDir: string | null     = null;
let _onStatusChange: ((status: LearnerStatus) => void) | null = null;

const LEDGER_FILENAME = "bg_learner_ledger.json";

// ── Ledger helpers ─────────────────────────────────────────────────────────

function getLedgerPath(targetDir: string): string {
  return path.join(targetDir, LEDGER_FILENAME);
}

function readLedger(targetDir: string): ProcessedLedger {
  const p = getLedgerPath(targetDir);
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as ProcessedLedger;
    }
  } catch { /* corrupt — start fresh */ }
  return { files: {}, version: 1 };
}

function writeLedger(targetDir: string, ledger: ProcessedLedger): void {
  try {
    fs.writeFileSync(getLedgerPath(targetDir), JSON.stringify(ledger), "utf-8");
  } catch { /* non-fatal */ }
}

function markProcessed(targetDir: string, filePath: string): void {
  const ledger = readLedger(targetDir);
  ledger.files[filePath] = Date.now();
  // Trim ledger to 5,000 entries to avoid unbounded growth
  const keys = Object.keys(ledger.files);
  if (keys.length > 5000) {
    const sorted = keys.sort((a, b) => ledger.files[a] - ledger.files[b]);
    for (const old of sorted.slice(0, keys.length - 5000)) delete ledger.files[old];
  }
  writeLedger(targetDir, ledger);
}

function wasProcessed(ledger: ProcessedLedger, filePath: string): boolean {
  return !!ledger.files[filePath];
}

// ── CPU idle detection ─────────────────────────────────────────────────────

/**
 * Measure instantaneous CPU idle % by sampling twice over 100 ms.
 * Returns a value 0–100 (higher = more idle).
 */
function getCpuIdlePct(): Promise<number> {
  return new Promise((resolve) => {
    const cpus1 = os.cpus();

    setTimeout(() => {
      const cpus2 = os.cpus();
      let totalIdle = 0;
      let totalTick = 0;

      for (let i = 0; i < cpus1.length; i++) {
        const c1 = cpus1[i].times;
        const c2 = cpus2[i].times;
        const idle = (c2.idle  - c1.idle);
        const tick = (c2.user  - c1.user)
                   + (c2.sys   - c1.sys)
                   + (c2.irq   - c1.irq)
                   + (c2.idle  - c1.idle);
        totalIdle += idle;
        totalTick += tick;
      }

      resolve(totalTick === 0 ? 100 : Math.round((totalIdle / totalTick) * 100));
    }, 100);
  });
}

// ── Term extraction ────────────────────────────────────────────────────────

/**
 * Extract high-value terms from a block of text.
 *
 * Strategy:
 *  1. Tokenize into words — count frequency
 *  2. Keep terms that appear ≥ MIN_TERM_FREQ times
 *  3. Extract bigrams (2-word phrases) that both appear often
 *  4. Score by frequency × length (longer specific terms rank higher)
 *  5. Return top MAX_TERMS_PER_FILE terms
 */
function extractTermsFromText(text: string, folderName: string): string[] {
  if (!text || text.length < 50) return [];

  const lower   = text.toLowerCase();
  const words   = lower.match(/\b[a-z][a-z\-']{2,39}\b/g) || [];

  // Word frequency map
  const freq: Record<string, number> = {};
  for (const w of words) {
    if (!GENERIC_STOP_WORDS.has(w) && w.length >= MIN_TERM_LEN && w.length <= MAX_TERM_LEN) {
      freq[w] = (freq[w] || 0) + 1;
    }
  }

  // Bigrams — "balance sheet", "income statement", "AP exam"
  const bigramFreq: Record<string, number> = {};
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i], b = words[i + 1];
    if (!GENERIC_STOP_WORDS.has(a) && !GENERIC_STOP_WORDS.has(b)
        && a.length >= 3 && b.length >= 3) {
      const bigram = `${a} ${b}`;
      bigramFreq[bigram] = (bigramFreq[bigram] || 0) + 1;
    }
  }

  // Keep terms above frequency threshold
  const candidates: Array<{ term: string; score: number }> = [];

  for (const [term, count] of Object.entries(freq)) {
    if (count >= MIN_TERM_FREQ) {
      // Prefer terms that are NOT in the folder name itself (those are already known)
      const folderLower = folderName.toLowerCase();
      if (folderLower.includes(term)) continue;
      candidates.push({ term, score: count * Math.min(term.length, 12) });
    }
  }

  for (const [bigram, count] of Object.entries(bigramFreq)) {
    if (count >= MIN_TERM_FREQ) {
      // Bigrams are gold — they're almost always specific
      candidates.push({ term: bigram, score: count * 20 });
    }
  }

  // Also add the folder name itself as a term (if multi-word)
  const folderWords = folderName.split(/\s+/).filter(w => w.length >= 3);
  if (folderWords.length > 1) {
    candidates.push({ term: folderName.toLowerCase(), score: 999 });
  }

  // Sort by score, take top N
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, MAX_TERMS_PER_FILE).map(c => c.term);
}

/**
 * Mine filename patterns to extract folder-specific vocabulary.
 *
 * e.g. "Chapter_08_APUSH_DBQ.pdf" → ["chapter", "apush", "dbq"]
 *      "Q1-Budget-2024.xlsx"       → ["budget", "q1"]
 */
function extractTermsFromFilename(filename: string): string[] {
  const noExt = filename.replace(/\.[^.]+$/, "");
  const words = noExt
    .replace(/[_\-\.]+/g, " ")
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length >= MIN_TERM_LEN && w.length <= MAX_TERM_LEN
                 && !GENERIC_STOP_WORDS.has(w)
                 && !/^\d+$/.test(w));           // skip pure numbers
  return [...new Set(words)];
}

// ── Yield / pause helpers ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function emitStatus() {
  if (_onStatusChange) {
    _onStatusChange(getStatus());
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function getStatus(): LearnerStatus {
  const ledger = _targetDir ? readLedger(_targetDir) : { files: {}, version: 1 };
  return {
    running:        _running,
    paused:         _paused,
    filesProcessed: _filesProcessed,
    termsAdded:     _termsAdded,
    currentFolder:  _currentFolder,
    ledgerSize:     Object.keys(ledger.files).length,
    lastRunAt:      Object.values(ledger.files).reduce((max, v) => Math.max(max, v), 0) || null,
  };
}

/** Register a callback fired whenever learner status changes. */
export function onStatusChange(cb: (status: LearnerStatus) => void): void {
  _onStatusChange = cb;
}

/** Tell the learner a user interaction happened — pauses for PAUSE_AFTER_INTERACTION_MS. */
const PAUSE_AFTER_INTERACTION_MS = 8000;
let _pauseUntil = 0;

export function notifyUserActivity(): void {
  _pauseUntil = Date.now() + PAUSE_AFTER_INTERACTION_MS;
  if (_running && !_paused) {
    _paused = true;
    emitStatus();
  }
}

/** Manually pause the learner. */
export function pauseLearner(): void {
  _paused = true;
  emitStatus();
}

/** Manually resume the learner. */
export function resumeLearner(): void {
  _paused = false;
  _pauseUntil = 0;
  emitStatus();
}

/** Permanently stop the learner for this session. */
export function stopLearner(): void {
  _stopFlag = true;
  _running  = false;
  emitStatus();
}

/**
 * Start the background learning loop.
 *
 * @param targetDir  The AI Organizer destination directory.
 *                   All subfolders are treated as labeled categories.
 */
export async function startBackgroundLearner(targetDir: string): Promise<void> {
  if (_running) return;   // already running

  _targetDir       = targetDir;
  _running         = true;
  _stopFlag        = false;
  _filesProcessed  = 0;
  _termsAdded      = 0;
  _paused          = false;

  console.log("[BackgroundLearner] Starting idle-time learning loop…");
  emitStatus();

  // ── Main learning loop ────────────────────────────────────────────────
  try {
    while (!_stopFlag && _filesProcessed < MAX_FILES_PER_SESSION) {

      // Respect user-activity pause
      if (_pauseUntil > Date.now()) {
        _paused = true;
        await sleep(2000);
        continue;
      }
      if (_paused && _pauseUntil <= Date.now()) {
        _paused = false;
        emitStatus();
      }

      // Check CPU idle
      const idle = await getCpuIdlePct();
      if (idle < IDLE_THRESHOLD_PCT) {
        // CPU is busy — back off and wait
        await sleep(5000);
        continue;
      }

      // Get folders and ledger
      let folders: string[] = [];
      try { folders = await scanUserFolders(targetDir); } catch { break; }
      if (!folders.length) { await sleep(10000); continue; }

      const ledger = readLedger(targetDir);
      const yieldMs = idle < 70 ? YIELD_MS_CAUTIOUS : YIELD_MS;

      // Pick a folder to process (round-robin by modifying the loop)
      let processedAny = false;

      for (const folder of folders) {
        if (_stopFlag) break;

        // Skip noise folders
        const folderLower = folder.toLowerCase();
        if (["needs review", "archives", "misc", "old", "temp", "downloads",
             "backup", "trash", "junk"].some(n => folderLower.includes(n))) continue;

        const folderPath = path.join(targetDir, folder);
        if (!fs.existsSync(folderPath)) continue;

        // List files in this folder
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(folderPath, { withFileTypes: true }); }
        catch { continue; }

        const files = entries
          .filter(e => e.isFile())
          .map(e => path.join(folderPath, e.name))
          // Skip already-processed files
          .filter(fp => !wasProcessed(ledger, fp))
          // Prefer common extractable types
          .filter(fp => /\.(pdf|docx?|txt|md|xlsx?|pptx?|csv|rtf|odt)$/i.test(fp));

        if (files.length === 0) continue;

        // Process one file from this folder then move on
        const filePath = files[0];
        _currentFolder = folder;
        emitStatus();

        try {
          // Extract filename terms (fast — no I/O)
          const filenameTerms = extractTermsFromFilename(path.basename(filePath));

          // Extract content terms (heavier — throttled by yield)
          let contentTerms: string[] = [];
          try {
            const text = await extractForClassification(filePath);
            contentTerms = extractTermsFromText(text, folder);
          } catch { /* extraction failed — filename terms are still useful */ }

          const allTerms = [...new Set([...filenameTerms, ...contentTerms])];

          if (allTerms.length > 0) {
            const added = addTermsToPool(allTerms, folder, targetDir);
            _termsAdded      += added;
            _filesProcessed  += 1;
            processedAny      = true;

            if (added > 0) {
              console.log(
                `[BackgroundLearner] ${folder}: +${added} terms from "${path.basename(filePath)}" ` +
                `(${_filesProcessed} files total)`
              );
            }
          }

          markProcessed(targetDir, filePath);
          ledger.files[filePath] = Date.now(); // update in-memory too
        } catch (err) {
          console.warn(`[BackgroundLearner] Skipped "${filePath}": ${err}`);
        }

        emitStatus();

        // Yield between files to keep UI responsive
        await sleep(yieldMs);

        // Re-check CPU after each file
        const idleNow = await getCpuIdlePct();
        if (idleNow < IDLE_THRESHOLD_PCT) {
          console.log(`[BackgroundLearner] CPU busy (${idleNow}% idle), pausing…`);
          await sleep(5000);
          break; // restart folder loop with fresh CPU check
        }
      }

      // If we looped all folders and found nothing new — sleep longer
      if (!processedAny) {
        _currentFolder = null;
        emitStatus();
        await sleep(60_000);  // check again in 1 minute
      }
    }
  } finally {
    _running       = false;
    _currentFolder = null;
    console.log(
      `[BackgroundLearner] Session complete — ` +
      `${_filesProcessed} files processed, ${_termsAdded} terms added`
    );
    emitStatus();
  }
}

/**
 * Reset the processed-files ledger so the learner will re-scan all files.
 * Call this after adding many new files to an existing folder, or after
 * a major folder restructure.
 */
export function resetLedger(targetDir: string): void {
  const p = getLedgerPath(targetDir);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* */ }
  console.log("[BackgroundLearner] Ledger reset — will re-learn from all files");
}
