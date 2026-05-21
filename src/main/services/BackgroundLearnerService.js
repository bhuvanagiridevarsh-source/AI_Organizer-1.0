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
var BackgroundLearnerService_exports = {};
__export(BackgroundLearnerService_exports, {
  getStatus: () => getStatus,
  notifyUserActivity: () => notifyUserActivity,
  onStatusChange: () => onStatusChange,
  pauseLearner: () => pauseLearner,
  resetLedger: () => resetLedger,
  resumeLearner: () => resumeLearner,
  startBackgroundLearner: () => startBackgroundLearner,
  stopLearner: () => stopLearner
});
module.exports = __toCommonJS(BackgroundLearnerService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_os = __toESM(require("os"));
var import_universal_pool_manager = require("../intelligence/universal-pool-manager");
var import_TextExtractionService = require("./TextExtractionService");
const { scanUserFolders } = require("./fileService");
const IDLE_THRESHOLD_PCT = 55;
const YIELD_MS = 800;
const YIELD_MS_CAUTIOUS = 2e3;
const MAX_FILES_PER_SESSION = 200;
const GENERIC_STOP_WORDS = /* @__PURE__ */ new Set([
  "the",
  "and",
  "for",
  "are",
  "was",
  "were",
  "this",
  "that",
  "with",
  "from",
  "have",
  "has",
  "had",
  "not",
  "but",
  "can",
  "will",
  "all",
  "any",
  "may",
  "use",
  "used",
  "also",
  "file",
  "files",
  "doc",
  "document",
  "documents",
  "page",
  "pages",
  "data",
  "info",
  "information",
  "note",
  "notes",
  "new",
  "old",
  "copy",
  "version",
  "draft",
  "final",
  "part",
  "item",
  "items",
  "list",
  "type",
  "date",
  "time",
  "year",
  "number",
  "name",
  "hello",
  "please",
  "thank",
  "thanks",
  "regards",
  "dear",
  "sincerely",
  "attached",
  "attachment",
  "see",
  "enclosed",
  "review",
  "regarding",
  "subject",
  "re",
  "fwd",
  "per",
  "as",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "or",
  "be",
  "an",
  "a",
  "i"
]);
const MIN_TERM_LEN = 3;
const MAX_TERM_LEN = 40;
const MIN_TERM_FREQ = 2;
const MAX_TERMS_PER_FILE = 40;
let _running = false;
let _paused = false;
let _stopFlag = false;
let _filesProcessed = 0;
let _termsAdded = 0;
let _currentFolder = null;
let _targetDir = null;
let _onStatusChange = null;
const LEDGER_FILENAME = "bg_learner_ledger.json";
function getLedgerPath(targetDir) {
  return import_path.default.join(targetDir, LEDGER_FILENAME);
}
function readLedger(targetDir) {
  const p = getLedgerPath(targetDir);
  try {
    if (import_fs.default.existsSync(p)) {
      return JSON.parse(import_fs.default.readFileSync(p, "utf-8"));
    }
  } catch {
  }
  return { files: {}, version: 1 };
}
function writeLedger(targetDir, ledger) {
  try {
    import_fs.default.writeFileSync(getLedgerPath(targetDir), JSON.stringify(ledger), "utf-8");
  } catch {
  }
}
function markProcessed(targetDir, filePath) {
  const ledger = readLedger(targetDir);
  ledger.files[filePath] = Date.now();
  const keys = Object.keys(ledger.files);
  if (keys.length > 5e3) {
    const sorted = keys.sort((a, b) => ledger.files[a] - ledger.files[b]);
    for (const old of sorted.slice(0, keys.length - 5e3)) delete ledger.files[old];
  }
  writeLedger(targetDir, ledger);
}
function wasProcessed(ledger, filePath) {
  return !!ledger.files[filePath];
}
function getCpuIdlePct() {
  return new Promise((resolve) => {
    const cpus1 = import_os.default.cpus();
    setTimeout(() => {
      const cpus2 = import_os.default.cpus();
      let totalIdle = 0;
      let totalTick = 0;
      for (let i = 0; i < cpus1.length; i++) {
        const c1 = cpus1[i].times;
        const c2 = cpus2[i].times;
        const idle = c2.idle - c1.idle;
        const tick = c2.user - c1.user + (c2.sys - c1.sys) + (c2.irq - c1.irq) + (c2.idle - c1.idle);
        totalIdle += idle;
        totalTick += tick;
      }
      resolve(totalTick === 0 ? 100 : Math.round(totalIdle / totalTick * 100));
    }, 100);
  });
}
function extractTermsFromText(text, folderName) {
  if (!text || text.length < 50) return [];
  const lower = text.toLowerCase();
  const words = lower.match(/\b[a-z][a-z\-']{2,39}\b/g) || [];
  const freq = {};
  for (const w of words) {
    if (!GENERIC_STOP_WORDS.has(w) && w.length >= MIN_TERM_LEN && w.length <= MAX_TERM_LEN) {
      freq[w] = (freq[w] || 0) + 1;
    }
  }
  const bigramFreq = {};
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i], b = words[i + 1];
    if (!GENERIC_STOP_WORDS.has(a) && !GENERIC_STOP_WORDS.has(b) && a.length >= 3 && b.length >= 3) {
      const bigram = `${a} ${b}`;
      bigramFreq[bigram] = (bigramFreq[bigram] || 0) + 1;
    }
  }
  const candidates = [];
  for (const [term, count] of Object.entries(freq)) {
    if (count >= MIN_TERM_FREQ) {
      const folderLower = folderName.toLowerCase();
      if (folderLower.includes(term)) continue;
      candidates.push({ term, score: count * Math.min(term.length, 12) });
    }
  }
  for (const [bigram, count] of Object.entries(bigramFreq)) {
    if (count >= MIN_TERM_FREQ) {
      candidates.push({ term: bigram, score: count * 20 });
    }
  }
  const folderWords = folderName.split(/\s+/).filter((w) => w.length >= 3);
  if (folderWords.length > 1) {
    candidates.push({ term: folderName.toLowerCase(), score: 999 });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, MAX_TERMS_PER_FILE).map((c) => c.term);
}
function extractTermsFromFilename(filename) {
  const noExt = filename.replace(/\.[^.]+$/, "");
  const words = noExt.replace(/[_\-\.]+/g, " ").split(/\s+/).map((w) => w.toLowerCase()).filter((w) => w.length >= MIN_TERM_LEN && w.length <= MAX_TERM_LEN && !GENERIC_STOP_WORDS.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)];
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function emitStatus() {
  if (_onStatusChange) {
    _onStatusChange(getStatus());
  }
}
function getStatus() {
  const ledger = _targetDir ? readLedger(_targetDir) : { files: {}, version: 1 };
  return {
    running: _running,
    paused: _paused,
    filesProcessed: _filesProcessed,
    termsAdded: _termsAdded,
    currentFolder: _currentFolder,
    ledgerSize: Object.keys(ledger.files).length,
    lastRunAt: Object.values(ledger.files).reduce((max, v) => Math.max(max, v), 0) || null
  };
}
function onStatusChange(cb) {
  _onStatusChange = cb;
}
const PAUSE_AFTER_INTERACTION_MS = 8e3;
let _pauseUntil = 0;
function notifyUserActivity() {
  _pauseUntil = Date.now() + PAUSE_AFTER_INTERACTION_MS;
  if (_running && !_paused) {
    _paused = true;
    emitStatus();
  }
}
function pauseLearner() {
  _paused = true;
  emitStatus();
}
function resumeLearner() {
  _paused = false;
  _pauseUntil = 0;
  emitStatus();
}
function stopLearner() {
  _stopFlag = true;
  _running = false;
  emitStatus();
}
async function startBackgroundLearner(targetDir) {
  if (_running) return;
  _targetDir = targetDir;
  _running = true;
  _stopFlag = false;
  _filesProcessed = 0;
  _termsAdded = 0;
  _paused = false;
  console.log("[BackgroundLearner] Starting idle-time learning loop\u2026");
  emitStatus();
  try {
    while (!_stopFlag && _filesProcessed < MAX_FILES_PER_SESSION) {
      if (_pauseUntil > Date.now()) {
        _paused = true;
        await sleep(2e3);
        continue;
      }
      if (_paused && _pauseUntil <= Date.now()) {
        _paused = false;
        emitStatus();
      }
      const idle = await getCpuIdlePct();
      if (idle < IDLE_THRESHOLD_PCT) {
        await sleep(5e3);
        continue;
      }
      let folders = [];
      try {
        folders = await scanUserFolders(targetDir);
      } catch {
        break;
      }
      if (!folders.length) {
        await sleep(1e4);
        continue;
      }
      const ledger = readLedger(targetDir);
      const yieldMs = idle < 70 ? YIELD_MS_CAUTIOUS : YIELD_MS;
      let processedAny = false;
      for (const folder of folders) {
        if (_stopFlag) break;
        const folderLower = folder.toLowerCase();
        if ([
          "needs review",
          "archives",
          "misc",
          "old",
          "temp",
          "downloads",
          "backup",
          "trash",
          "junk"
        ].some((n) => folderLower.includes(n))) continue;
        const folderPath = import_path.default.join(targetDir, folder);
        if (!import_fs.default.existsSync(folderPath)) continue;
        let entries;
        try {
          entries = import_fs.default.readdirSync(folderPath, { withFileTypes: true });
        } catch {
          continue;
        }
        const files = entries.filter((e) => e.isFile()).map((e) => import_path.default.join(folderPath, e.name)).filter((fp) => !wasProcessed(ledger, fp)).filter((fp) => /\.(pdf|docx?|txt|md|xlsx?|pptx?|csv|rtf|odt)$/i.test(fp));
        if (files.length === 0) continue;
        const filePath = files[0];
        _currentFolder = folder;
        emitStatus();
        try {
          const filenameTerms = extractTermsFromFilename(import_path.default.basename(filePath));
          let contentTerms = [];
          try {
            const text = await (0, import_TextExtractionService.extractForClassification)(filePath);
            contentTerms = extractTermsFromText(text, folder);
          } catch {
          }
          const allTerms = [.../* @__PURE__ */ new Set([...filenameTerms, ...contentTerms])];
          if (allTerms.length > 0) {
            const added = (0, import_universal_pool_manager.addTermsToPool)(allTerms, folder, targetDir);
            _termsAdded += added;
            _filesProcessed += 1;
            processedAny = true;
            if (added > 0) {
              console.log(
                `[BackgroundLearner] ${folder}: +${added} terms from "${import_path.default.basename(filePath)}" (${_filesProcessed} files total)`
              );
            }
          }
          markProcessed(targetDir, filePath);
          ledger.files[filePath] = Date.now();
        } catch (err) {
          console.warn(`[BackgroundLearner] Skipped "${filePath}": ${err}`);
        }
        emitStatus();
        await sleep(yieldMs);
        const idleNow = await getCpuIdlePct();
        if (idleNow < IDLE_THRESHOLD_PCT) {
          console.log(`[BackgroundLearner] CPU busy (${idleNow}% idle), pausing\u2026`);
          await sleep(5e3);
          break;
        }
      }
      if (!processedAny) {
        _currentFolder = null;
        emitStatus();
        await sleep(6e4);
      }
    }
  } finally {
    _running = false;
    _currentFolder = null;
    console.log(
      `[BackgroundLearner] Session complete \u2014 ${_filesProcessed} files processed, ${_termsAdded} terms added`
    );
    emitStatus();
  }
}
function resetLedger(targetDir) {
  const p = getLedgerPath(targetDir);
  try {
    if (import_fs.default.existsSync(p)) import_fs.default.unlinkSync(p);
  } catch {
  }
  console.log("[BackgroundLearner] Ledger reset \u2014 will re-learn from all files");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getStatus,
  notifyUserActivity,
  onStatusChange,
  pauseLearner,
  resetLedger,
  resumeLearner,
  startBackgroundLearner,
  stopLearner
});
