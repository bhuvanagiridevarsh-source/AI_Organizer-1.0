/**
 * renderer.js — AI Organizer dashboard.
 *
 * Destination: ~/Desktop/AI_SORTED_FILES (hardcoded)
 *
 * Flow:
 *   1. Click Select Files → macOS file picker (openFile only, ALL types)
 *   2. Files appear instantly in the Classification Results table
 *   3. Each file is classified via ClassificationService
 *   4. Review: Approve checkbox, Category dropdown, Confidence, Proposed Path
 *   5. Confirm (approved) or Organize All → file.move()
 *
 * ZERO calls to openDirectory anywhere.
 */

const $ = (id) => document.getElementById(id);

// ── Destination (fetched from main process on startup) ───────
let DEST_DIR = null; // set in bootstrap via window.api.getDestDir()

// ── Undo / Redo stacks ─────────────────────────────────────
// Each entry: { from: originalPath, to: destPath, filename }
const undoStack = [];
const redoStack = [];

// ── DOM refs ─────────────────────────────────────────────────
const selectFilesBtn  = $("selectFilesBtn");
const selectFolderBtn = $("selectFolderBtn");
const scanAllBtn      = $("scanAllBtn");
const newCategoryBtn  = $("newCategoryBtn");
const settingsBtn     = $("settingsBtn");
const scanBtn         = $("scanBtn");
const organizeBtn     = $("organizeBtn");
const confirmBtn      = $("confirmBtn");
const cancelBtn       = $("cancelBtn");
const selectAllBtn    = $("selectAllBtn");
const deselectAllBtn  = $("deselectAllBtn");
const actionBar       = $("actionBar");
const countLabel      = $("countLabel");
const statusDot       = $("statusDot");
const statusText      = $("statusText");
const tableContainer  = $("tableContainer");
const feed            = $("feed");
const statFiles       = $("statFiles");
const statFolders     = $("statFolders");
const statReview      = $("statReview");
const statCorrections = $("statCorrections");

const settingsOverlay  = $("settingsOverlay");
const closeSettingsBtn = $("closeSettingsBtn");
const clearLearningBtn = $("clearLearningBtn");
const refreshFpBtn     = $("refreshFpBtn");

// New Category dialog DOM refs
const newCatOverlay    = $("newCatOverlay");
const newCatInput      = $("newCatInput");
const newCatOkBtn      = $("newCatOkBtn");
const newCatCancelBtn  = $("newCatCancelBtn");

// Dual Mode DOM refs
const appHeader       = $("appHeader");
const personalModeBtn = $("personalModeBtn");
const workModeBtn     = $("workModeBtn");
const icloudBadge     = $("icloudBadge");
const destBannerText  = $("destBannerText");

// Deep Search / Neural Omnibar DOM refs
const deepSearchInput = $("deepSearchInput");
const neuralAnswerContainer = $("neuralAnswerContainer");

// Toast DOM ref
const toast           = $("toast");

// Auto-Update DOM refs
const updateBanner    = $("updateBanner");
const updateBannerText = $("updateBannerText");

// Admin / Boss Dashboard DOM refs
const adminFooter       = $("adminFooter");
const bossDashOverlay   = $("bossDashOverlay");
const bossDashContent   = $("bossDashContent");
const exportLogBtn      = $("exportLogBtn");
const exportKnowledgeBtn = $("exportKnowledgeBtn");
const exitBossDashBtn   = $("exitBossDashBtn");
const adminPinOverlay   = $("adminPinOverlay");
const adminPinInput     = $("adminPinInput");
const adminPinOkBtn     = $("adminPinOkBtn");
const adminPinCancelBtn = $("adminPinCancelBtn");

// ── State ────────────────────────────────────────────────────
let queue = [];
let knownFolders = [];
let currentMode = "personal";

// ── Helpers ──────────────────────────────────────────────────
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}
function basename(p) { return p.split("/").pop() || p; }

function setStatus(ok, text) {
  statusDot.classList.toggle("ok", ok);
  statusText.textContent = text;
}

// ── Activity feed ────────────────────────────────────────────
function feedAdd(msg, isError) {
  const div = document.createElement("div");
  div.className = "feed-entry";
  const dot = isError
    ? '<span class="feed-dot err">&#9679;</span>'
    : '<span class="feed-dot ok">&#9679;</span>';
  div.innerHTML = dot + esc(msg);
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

// ── Toast notification ─────────────────────────────────────────
function showToast(msg, durationMs = 3000) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), durationMs);
}

// ── Undo / Redo ───────────────────────────────────────────────
function updateUndoRedoButtons() {
  const undoBtn = $("undoBtn");
  const redoBtn = $("redoBtn");
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

async function doUndo() {
  if (undoStack.length === 0) return;
  const op = undoStack.pop();
  try {
    await window.api.file.undoMove(op.from, op.to);
    redoStack.push(op);
    feedAdd(`↩ Undone: ${op.filename} moved back to original location`);
    showToast(`↩ Undone: ${op.filename}`);
  } catch (err) {
    undoStack.push(op); // put it back
    showToast(`Undo failed: ${err.message || err}`);
  }
  updateUndoRedoButtons();
}

async function doRedo() {
  if (redoStack.length === 0) return;
  const op = redoStack.pop();
  try {
    await window.api.file.move(op.from, op.to);
    undoStack.push(op);
    feedAdd(`↪ Redone: ${op.filename} → organized`);
    showToast(`↪ Redone: ${op.filename}`);
  } catch (err) {
    redoStack.push(op);
    showToast(`Redo failed: ${err.message || err}`);
  }
  updateUndoRedoButtons();
}

// ── Category <select> options (supports hierarchy) ────────────
function catOptions(selected) {
  const all = new Set(knownFolders);
  if (selected) all.add(selected);
  const sorted = [...all].sort((a, b) =>
    a === selected ? -1 : b === selected ? 1 : a.localeCompare(b)
  );
  return sorted
    .map((n) => {
      const isChild = n.includes("/");
      const display = isChild ? "  ↳ " + n.split("/").pop() : n;
      return `<option value="${esc(n)}" ${n === selected ? "selected" : ""}>${esc(display)}</option>`;
    })
    .join("");
}

/** Format a hierarchical path for display: "Math/Precalculus" → "Math / Precalculus" */
function formatCategory(cat) {
  if (!cat) return "";
  return cat.includes("/") ? cat.split("/").join(" / ") : cat;
}

// ── Confidence color ─────────────────────────────────────────
function confClass(c) {
  if (c >= 80) return "conf-green";
  if (c >= 50) return "conf-amber";
  return "conf-red";
}

// ── PII detection (SSN pattern) ────────────────────────────────
const SSN_REGEX = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/;
function hasPII(text) {
  return SSN_REGEX.test(text || "");
}

// ── Noun extraction (simple frequency-based) ──────────────────
const STOP_WORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with","by",
  "from","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","shall","may","might",
  "can","this","that","these","those","it","its","i","me","my","we","our",
  "you","your","he","him","his","she","her","they","them","their","not",
  "no","so","if","then","than","when","where","how","what","which","who",
  "all","each","every","both","few","more","most","some","any","many",
  "much","such","very","just","also","into","over","after","before",
]);
function extractTopNouns(text, count) {
  if (!text) return [];
  const words = text.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/);
  const freq = {};
  for (const w of words) {
    if (w.length < 3 || STOP_WORDS.has(w)) continue;
    freq[w] = (freq[w] || 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([word]) => word);
}

// ── Deep Content Search ───────────────────────────────────────
function applyDeepSearch() {
  const term = deepSearchInput.value.toLowerCase().trim();
  const rows = tableContainer.querySelectorAll(".results-table tbody tr");
  rows.forEach((row) => {
    if (!term) {
      row.style.display = "";
      return;
    }
    const cb = row.querySelector(".approve-cb");
    if (!cb) { row.style.display = ""; return; }
    const i = parseInt(cb.dataset.i, 10);
    const entry = queue[i];
    if (!entry) { row.style.display = ""; return; }
    const text = (entry.extractedText || "").toLowerCase();
    const filename = (entry.filename || "").toLowerCase();
    const category = (entry.category || "").toLowerCase();
    const match = text.includes(term) || filename.includes(term) || category.includes(term);
    row.style.display = match ? "" : "none";
  });
}

// ═════════════════════════════════════════════════════════════
//  NEURAL OMNIBAR — Q&A, Explanations, Source Linking
// ═════════════════════════════════════════════════════════════

/** Detect if input looks like a question (Q&A mode vs filter mode). */
function isQuestion(input) {
  const q = input.trim().toLowerCase();
  if (q.includes("?")) return true;
  const questionStarts = ["what", "why", "how", "which", "where", "when", "who", "show me", "find me", "tell me", "explain"];
  return questionStarts.some((s) => q.startsWith(s));
}

// ── Teacher Protocol — Natural Language Command Patterns ──
const TEACHER_PATTERNS = [
  // "add keyword 'Invoice' to Finance" / "add keyword Invoice to Finance"
  /add\s+keywords?\s+['""]?(.+?)['""]?\s+to\s+['""]?(.+?)['""]?\s*$/i,
  // "remember 'Solomon' is History" / "remember Solomon is History"
  /remember\s+['""]?(.+?)['""]?\s+is\s+['""]?(.+?)['""]?\s*$/i,
  // "teach Finance about invoices" / "teach Biology about mitosis"
  /teach\s+['""]?(.+?)['""]?\s+about\s+['""]?(.+?)['""]?\s*$/i,
  // "link 'receipt' to Taxes"
  /link\s+['""]?(.+?)['""]?\s+to\s+['""]?(.+?)['""]?\s*$/i,
];

// "teach X about Y" has category first, keyword second — track which patterns swap
const TEACHER_SWAP = [false, false, true, false];

/**
 * Detect if input is a Teacher Protocol command.
 * Returns { keyword, category } or null.
 */
function parseTeacherCommand(input) {
  const q = input.trim();
  for (let i = 0; i < TEACHER_PATTERNS.length; i++) {
    const match = q.match(TEACHER_PATTERNS[i]);
    if (match) {
      const a = match[1].trim();
      const b = match[2].trim();
      return TEACHER_SWAP[i]
        ? { keyword: b, category: a }
        : { keyword: a, category: b };
    }
  }
  return null;
}

/**
 * Execute a Teacher Protocol command — persist keyword to the knowledge pool.
 * Returns a Neural response object with type: "success".
 */
async function executeTeacherCommand(parsed) {
  const { keyword, category } = parsed;
  const keywords = keyword.split(/[,;]+/).map((k) => k.trim().toLowerCase()).filter((k) => k.length >= 2);

  if (keywords.length === 0) {
    return { type: "error", answer: "Keyword is too short. Use at least 2 characters.", sources: [], explanation: "" };
  }

  // Find the closest matching known folder
  const catLower = category.toLowerCase();
  const matchedFolder = knownFolders.find((f) => f.toLowerCase() === catLower)
    || knownFolders.find((f) => f.toLowerCase().includes(catLower) || catLower.includes(f.toLowerCase()));

  if (!matchedFolder) {
    return {
      type: "error",
      answer: `Category '${category}' not found. Known categories: ${knownFolders.join(", ") || "(none)"}.\nCreate the category first with "+ New Category".`,
      sources: [],
      explanation: "",
    };
  }

  // Persist to the global concepts pool via IPC
  try {
    await window.api.knowledge.reinforce(matchedFolder, keywords);
  } catch (err) {
    return {
      type: "error",
      answer: `Failed to save: ${err.message || err}`,
      sources: [],
      explanation: "",
    };
  }

  // Also add to the local CATEGORY_EVIDENCE dictionary for immediate "Why" explanations
  const evidenceKey = matchedFolder.toLowerCase();
  if (!CATEGORY_EVIDENCE[evidenceKey]) CATEGORY_EVIDENCE[evidenceKey] = [];
  for (const kw of keywords) {
    if (!CATEGORY_EVIDENCE[evidenceKey].includes(kw)) CATEGORY_EVIDENCE[evidenceKey].push(kw);
  }

  const kwDisplay = keywords.map((k) => `'${k}'`).join(", ");
  feedAdd(`Teacher: added ${kwDisplay} to ${matchedFolder} concept pool.`);

  return {
    type: "success",
    answer: `Added ${kwDisplay} to the ${matchedFolder} concept pool. Future files containing ${keywords.length === 1 ? "this term" : "these terms"} will be routed automatically.`,
    sources: [],
    explanation: `Keyword${keywords.length > 1 ? "s" : ""} saved to global_concepts.json under '${matchedFolder}'. The classification waterfall will now match ${kwDisplay} at Step 1.85 (Pool Match).`,
  };
}

// ── Category-specific keyword dictionaries for evidence extraction ──
const CATEGORY_EVIDENCE = {
  finance:  ["budget", "revenue", "expense", "profit", "loss", "fiscal", "quarterly", "q1", "q2", "q3", "q4",
             "invoice", "tax", "financial", "balance", "sheet", "accounting", "payroll", "dividend", "capital",
             "interest", "loan", "mortgage", "credit", "debit", "audit", "forecast", "roi", "earnings", "$"],
  legal:    ["contract", "agreement", "terms", "conditions", "indemnity", "liability", "clause", "parties",
             "jurisdiction", "arbitration", "binding", "signature", "witness", "plaintiff", "defendant",
             "attorney", "counsel", "statute", "compliance", "regulation", "amendment", "warrant", "affidavit"],
  travel:   ["itinerary", "flight", "booking", "hotel", "reservation", "departure", "arrival", "airport",
             "passport", "visa", "boarding", "luggage", "destination", "transit", "layover", "cruise",
             "accommodation", "check-in", "terminal", "airline"],
  medical:  ["diagnosis", "patient", "prescription", "treatment", "symptoms", "clinical", "hospital",
             "physician", "surgery", "medication", "dosage", "prognosis", "therapy", "lab", "results",
             "blood", "vitals", "allergy", "referral", "insurance"],
  biology:  ["cell", "organism", "dna", "rna", "protein", "gene", "evolution", "species", "ecosystem",
             "photosynthesis", "mitosis", "chromosome", "enzyme", "bacteria", "virus", "anatomy",
             "physiology", "taxonomy", "biodiversity", "habitat"],
  math:     ["equation", "theorem", "proof", "formula", "integral", "derivative", "calculus", "algebra",
             "geometry", "variable", "coefficient", "polynomial", "matrix", "vector", "probability",
             "statistics", "function", "logarithm", "trigonometry", "hypothesis"],
  education:["syllabus", "curriculum", "assignment", "grade", "semester", "lecture", "exam", "quiz",
             "student", "teacher", "course", "enrollment", "gpa", "transcript", "academic", "homework",
             "study", "class", "school", "university"],
};

/**
 * Extract evidence keywords actually found in a file's content + filename.
 * Returns an array of matched keywords, sorted by relevance to the category.
 */
function extractEvidenceKeywords(text, filename, category) {
  const searchable = (text + " " + filename).toLowerCase();
  const markers = [];

  // First, check the category-specific dictionary
  const catKey = category.toLowerCase();
  for (const [dictKey, keywords] of Object.entries(CATEGORY_EVIDENCE)) {
    if (catKey.includes(dictKey) || dictKey.includes(catKey)) {
      for (const kw of keywords) {
        if (kw === "$") {
          // Count currency symbols — report as "$ symbol density" if >= 3
          const dollarCount = (searchable.match(/\$/g) || []).length;
          if (dollarCount >= 3) markers.push("$ symbol density");
        } else if (searchable.includes(kw)) {
          markers.push(kw.charAt(0).toUpperCase() + kw.slice(1));
        }
      }
    }
  }

  // If no dictionary match, extract the top nouns from content as evidence
  if (markers.length === 0) {
    const nouns = extractTopNouns(text + " " + filename, 8);
    for (const n of nouns) {
      if (!STOP_WORDS.has(n) && n.length >= 3) {
        markers.push(n.charAt(0).toUpperCase() + n.slice(1));
      }
    }
  }

  // Deduplicate and cap at 6
  return [...new Set(markers)].slice(0, 6);
}

/**
 * Generate a category-specific natural-language explanation for why a file was classified.
 * Uses actual detected keywords from the file content.
 */
function generateCategoryExplanation(filename, category, confidence, markers, text) {
  const cat = category.toLowerCase();
  const markerStr = markers.length
    ? markers.map((m) => `'${m}'`).join(", ")
    : "content patterns";

  // Finance
  if (cat.includes("finance") || cat.includes("budget") || cat.includes("accounting") || cat.includes("tax")) {
    return `I classified '${filename}' as ${category} because I detected financial markers: ${markerStr}.\nConfidence: ${confidence}%.`;
  }
  // Legal
  if (cat.includes("legal") || cat.includes("law") || cat.includes("contract") || cat.includes("compliance")) {
    return `'${filename}' was routed to ${category} because it contains legal terminology: ${markerStr}.\nConfidence: ${confidence}%.`;
  }
  // Travel
  if (cat.includes("travel") || cat.includes("trip") || cat.includes("itinerary") || cat.includes("flight")) {
    return `Identified '${filename}' as ${category} based on travel indicators: ${markerStr}.\nConfidence: ${confidence}%.`;
  }
  // Medical / Health
  if (cat.includes("medical") || cat.includes("health") || cat.includes("clinical") || cat.includes("patient")) {
    return `'${filename}' was flagged as ${category} due to medical/clinical markers: ${markerStr}.\nConfidence: ${confidence}%.`;
  }
  // Biology / Science
  if (cat.includes("biology") || cat.includes("science") || cat.includes("chemistry") || cat.includes("physics")) {
    return `'${filename}' matched ${category} through scientific terminology: ${markerStr}.\nConfidence: ${confidence}%.`;
  }
  // Math
  if (cat.includes("math") || cat.includes("calculus") || cat.includes("algebra") || cat.includes("statistics")) {
    return `Classified '${filename}' as ${category} based on mathematical patterns: ${markerStr}.\nConfidence: ${confidence}%.`;
  }
  // Education
  if (cat.includes("education") || cat.includes("school") || cat.includes("academic") || cat.includes("course")) {
    return `'${filename}' was sorted into ${category} due to academic content markers: ${markerStr}.\nConfidence: ${confidence}%.`;
  }
  // Images
  if (cat.includes("image") || cat.includes("photo") || cat.includes("picture")) {
    return `'${filename}' was identified as ${category} based on file type and OCR text analysis.\nConfidence: ${confidence}%.`;
  }

  // Default — generic but still data-driven
  return `I mapped '${filename}' to ${category} with ${confidence}% confidence.\nPattern matches detected: ${markerStr}.`;
}

/**
 * Neural Q&A engine — queries the in-memory queue data to answer questions.
 * Returns { answer: string, sources: [{filename, filePath}], explanation?: string }
 */
function askNeuralCore(query) {
  const q = query.trim().toLowerCase();
  const results = { answer: "", sources: [], explanation: "" };

  if (queue.length === 0) {
    results.answer = "No files loaded yet. Select files first so I can answer questions about them.";
    return results;
  }

  // ── "Why" questions — CONTEXT-AWARE classification explanation ──
  if (q.startsWith("why")) {
    // Step 1: Determine the target file — either named in the question or the top visible row
    let targetFile = null;

    // Try to find a file explicitly named in the question
    targetFile = queue.find((f) => {
      const fn = f.filename.toLowerCase();
      return q.includes(fn) || q.includes(fn.replace(/\.[^.]+$/, ""));
    });

    // If no file named, check visible rows (user may have filtered first)
    if (!targetFile) {
      const visibleRows = tableContainer.querySelectorAll(".results-table tbody tr");
      for (const row of visibleRows) {
        if (row.style.display === "none") continue;
        const cb = row.querySelector(".approve-cb");
        if (!cb) continue;
        const i = parseInt(cb.dataset.i, 10);
        if (queue[i] && queue[i].status !== "pending") {
          targetFile = queue[i];
          break;
        }
      }
    }

    // If still nothing, grab the first classified file in queue
    if (!targetFile) {
      targetFile = queue.find((f) => f.status === "classified");
    }

    // Step 2: If we found a target file, generate a context-aware answer
    if (targetFile) {
      const cat = targetFile.category || "Unknown";
      const conf = targetFile.confidence || 0;
      const text = (targetFile.extractedText || "").toLowerCase();
      const fname = targetFile.filename;

      // Extract the actual keywords found in this file's content
      const detectedMarkers = extractEvidenceKeywords(text, fname, cat);

      let reason = "";

      // ── Conflict situation ──
      if (targetFile.conflictCategories && targetFile.conflictCategories.length > 1) {
        reason = `'${fname}' triggered a conflict between ${targetFile.conflictCategories.join(" and ")}.\n`;
        reason += `Both categories had strong keyword matches. Sent to Needs Review for your decision.\n`;
        if (detectedMarkers.length) {
          reason += `Detected markers: ${detectedMarkers.map((m) => `'${m}'`).join(", ")}.`;
        }
        results.explanation = `The Smart Arbiter found >=70% confidence for multiple categories with neither being a clear subset of the other.`;
      }
      // ── PII redirect ──
      else if (targetFile.hasPII) {
        reason = `'${fname}' was flagged for PII (sensitive data) — SSN pattern detected in content.\n`;
        if (currentMode === "work") {
          reason += `Work mode policy: automatically redirected to STRICTLY_SECURE.`;
        } else {
          reason += `Classified as '${cat}' at ${conf}% but marked for review due to sensitive data.`;
        }
        results.explanation = `PII detection runs a regex scan for SSN patterns (###-##-####) on extracted text.`;
      }
      // ── Needs Review (low confidence) ──
      else if (cat === "Needs Review") {
        reason = `'${fname}' didn't strongly match any known category.\n`;
        reason += `The classification waterfall (keywords, concept pool, entity recognition, AI) all scored below the 60% threshold.\n`;
        if (detectedMarkers.length) {
          reason += `Some weak signals found: ${detectedMarkers.map((m) => `'${m}'`).join(", ")}, but not enough for a confident match.`;
        } else {
          reason += `No strong keyword patterns were detected. Try creating a category and Deep Diving to teach the system.`;
        }
        results.explanation = `Files land in Needs Review when no step in the waterfall reaches >=60% confidence.`;
      }
      // ── Normal classification — build category-specific explanation ──
      else {
        reason = generateCategoryExplanation(fname, cat, conf, detectedMarkers, text);
        results.explanation = `Classification used ${conf >= 85 ? "keyword/pool matching" : conf >= 65 ? "concept pool + entity recognition" : "broad content analysis"} to determine this result.`;
      }

      results.answer = reason;
      results.sources = [{ filename: fname, filePath: targetFile.filePath }];
    } else {
      // No files visible or loaded
      results.answer = "I can't explain the sorting because no classified files are currently visible. Try searching for a file first, then ask 'Why'.";
    }
    return results;
  }

  // ── "What" / content questions — search extracted text ──
  if (q.startsWith("what") || q.startsWith("tell me") || q.startsWith("find me") || q.startsWith("show me")) {
    // Extract search terms from the question
    const searchTerms = q
      .replace(/^(what|tell me|find me|show me|about|is|are|the|in|of|for|a|an)\s*/gi, "")
      .replace(/\?/g, "")
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

    if (searchTerms.length === 0) {
      results.answer = `You have ${queue.length} file(s) loaded across ${[...new Set(queue.map(f => f.category))].filter(Boolean).length} categories.`;
      return results;
    }

    // Search through extracted text and filenames
    const matches = [];
    for (const entry of queue) {
      const searchable = ((entry.extractedText || "") + " " + (entry.filename || "")).toLowerCase();
      const hitCount = searchTerms.filter((t) => searchable.includes(t)).length;
      if (hitCount > 0) {
        matches.push({ entry, hitCount, relevance: hitCount / searchTerms.length });
      }
    }
    matches.sort((a, b) => b.relevance - a.relevance);

    if (matches.length === 0) {
      results.answer = `No files contain information about "${searchTerms.join(" ")}". Try different keywords or load more files.`;
      return results;
    }

    // Build answer from top matches
    const topMatches = matches.slice(0, 5);
    let answer = `Found ${matches.length} file(s) related to "${searchTerms.join(" ")}":\n`;
    for (const m of topMatches) {
      answer += `\n• ${m.entry.filename} (${m.entry.category || "unclassified"}, ${m.entry.confidence}% confidence)`;
      // Try to extract a relevant snippet
      if (m.entry.extractedText) {
        const text = m.entry.extractedText;
        const idx = text.toLowerCase().indexOf(searchTerms[0]);
        if (idx !== -1) {
          const start = Math.max(0, idx - 40);
          const end = Math.min(text.length, idx + 100);
          const snippet = (start > 0 ? "..." : "") + text.slice(start, end).trim() + (end < text.length ? "..." : "");
          answer += `\n  "${snippet}"`;
        }
      }
    }
    results.sources = topMatches.map((m) => ({ filename: m.entry.filename, filePath: m.entry.filePath }));
    results.explanation = `Searched through extracted text and filenames of ${queue.length} loaded file(s).`;
    return results;
  }

  // ── "How many" / statistics questions ──
  if (q.startsWith("how many") || q.startsWith("how much") || q.includes("count") || q.includes("total")) {
    const categories = {};
    let piiCount = 0, reviewCount = 0;
    queue.forEach((f) => {
      if (f.category) categories[f.category] = (categories[f.category] || 0) + 1;
      if (f.hasPII) piiCount++;
      if (f.requires_review) reviewCount++;
    });
    let answer = `${queue.length} file(s) loaded.\n`;
    answer += `${Object.keys(categories).length} categories: ${Object.entries(categories).map(([c, n]) => `${c} (${n})`).join(", ")}`;
    if (piiCount) answer += `\n${piiCount} file(s) flagged for PII.`;
    if (reviewCount) answer += `\n${reviewCount} file(s) need review.`;
    results.answer = answer;
    return results;
  }

  // ── "Which" questions — find specific files ──
  if (q.startsWith("which")) {
    const searchTerms = q.replace(/^which\s*(files?|documents?)?\s*/i, "").replace(/\?/g, "").trim().split(/\s+/).filter((w) => w.length >= 3);
    const matches = queue.filter((f) => {
      const s = ((f.extractedText || "") + " " + (f.filename || "") + " " + (f.category || "")).toLowerCase();
      return searchTerms.some((t) => s.includes(t));
    });
    if (matches.length) {
      results.answer = `${matches.length} file(s) match:\n` + matches.map((f) => `• ${f.filename} → ${f.category}`).join("\n");
      results.sources = matches.slice(0, 5).map((f) => ({ filename: f.filename, filePath: f.filePath }));
    } else {
      results.answer = `No files match "${searchTerms.join(" ")}".`;
    }
    return results;
  }

  // ── Generic fallback — treat as content search ──
  const terms = q.replace(/\?/g, "").split(/\s+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  if (terms.length > 0) {
    const matches = [];
    for (const entry of queue) {
      const searchable = ((entry.extractedText || "") + " " + (entry.filename || "")).toLowerCase();
      const hitCount = terms.filter((t) => searchable.includes(t)).length;
      if (hitCount > 0) matches.push({ entry, hitCount });
    }
    matches.sort((a, b) => b.hitCount - a.hitCount);
    if (matches.length) {
      results.answer = `Found ${matches.length} file(s) matching your query:\n` +
        matches.slice(0, 5).map((m) => `• ${m.entry.filename} → ${m.entry.category} (${m.entry.confidence}%)`).join("\n");
      results.sources = matches.slice(0, 5).map((m) => ({ filename: m.entry.filename, filePath: m.entry.filePath }));
    } else {
      results.answer = `No results found for "${q}". Try different terms or load more files.`;
    }
  } else {
    results.answer = `Ask me about your files! Try "What is the budget?" or "Why is report.pdf in Finance?"`;
  }
  return results;
}

/** Render the Neural Answer card below the search bar. */
function showNeuralAnswer(response) {
  const isSuccess = response.type === "success";
  const isError = response.type === "error";
  const cardClass = isSuccess ? "neural-card neural-success" : "neural-card";

  const labelIcon = isSuccess ? '<span class="neural-success-icon">&#10003;</span>' : "";
  const labelText = isSuccess ? "Memory Updated" : isError ? "Error" : "Neural Answer";

  const sourceChips = (response.sources || []).map((s) =>
    `<span class="neural-source-chip" data-filepath="${esc(s.filePath || "")}" data-filename="${esc(s.filename || "")}">${esc(s.filename || "")}</span>`
  ).join("");

  const explainLabel = isSuccess ? "What Changed" : "How I Found This";
  const explainBlock = response.explanation
    ? `<div class="neural-card-explain">
        <div class="neural-card-explain-label">${explainLabel}</div>
        <div class="neural-card-explain-text">${esc(response.explanation)}</div>
      </div>` : "";

  neuralAnswerContainer.innerHTML = `
    <div class="${cardClass}">
      <button class="neural-card-close" id="neuralCloseBtn">&times;</button>
      <div class="neural-card-label">${labelIcon}${labelText}</div>
      <div class="neural-card-answer">${esc(response.answer)}</div>
      ${response.sources && response.sources.length ? `<div class="neural-card-sources">${sourceChips}</div>` : ""}
      ${explainBlock}
    </div>`;

  // Wire close button
  const closeBtn = $("neuralCloseBtn");
  if (closeBtn) closeBtn.addEventListener("click", hideNeuralAnswer);

  // Wire source chips — click to filter table to that file
  neuralAnswerContainer.querySelectorAll(".neural-source-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const filename = chip.dataset.filename;
      if (filename) handleViewFile(filename);
    });
  });

  // Mark search bar as active
  deepSearchInput.classList.add("neural-active");
}

/** Hide the Neural Answer card. */
function hideNeuralAnswer() {
  neuralAnswerContainer.innerHTML = "";
  deepSearchInput.classList.remove("neural-active");
}

/** Focus table on a specific file — sets search to filename and filters. */
function handleViewFile(filename) {
  hideNeuralAnswer();
  deepSearchInput.value = filename;
  applyDeepSearch();
}

/** Handle Enter key on the Omnibar — command → teach, question → Q&A, otherwise → filter. */
async function handleOmnibarEnter() {
  const input = deepSearchInput.value.trim();
  if (!input) {
    hideNeuralAnswer();
    return;
  }

  // 1. Check for Teacher Protocol commands first
  const teacherCmd = parseTeacherCommand(input);
  if (teacherCmd) {
    const response = await executeTeacherCommand(teacherCmd);
    showNeuralAnswer(response);
    if (response.type === "success") deepSearchInput.value = "";
    return;
  }

  // 2. Check for questions (Q&A mode)
  if (isQuestion(input)) {
    const response = askNeuralCore(input);
    showNeuralAnswer(response);
  } else {
    // 3. Plain text — filter the table
    hideNeuralAnswer();
    applyDeepSearch();
  }
}

// ═════════════════════════════════════════════════════════════
//  RENDER — Classification Results table
// ═════════════════════════════════════════════════════════════
function render() {
  if (queue.length === 0) {
    tableContainer.innerHTML = `
      <div class="empty-state">
        <p>Click <strong>Select Files</strong> to pick files (all types allowed).</p>
        <p>Nothing moves until you click <strong>Confirm</strong> or <strong>Organize All</strong>.</p>
      </div>`;
    actionBar.classList.add("hidden");
    return;
  }

  let reviewCount = 0;

  const sorted = [...queue].map((f, i) => ({ ...f, _i: i }));
  sorted.sort((a, b) => (a.confidence || 0) - (b.confidence || 0));

  const rows = sorted.map((f) => {
    const i = f._i;
    if (f.requires_review) reviewCount++;

    const rowClass =
      f.status === "moved"  ? "row-moved" :
      f.status === "error"  ? "row-error" :
      f.hasPII              ? "row-pii"   :
      f.category === "Needs Review" ? "row-review" :
      f.isAIMatch           ? "ai-match"  : "";

    const cbOff = (f.status === "pending" || f.status === "moved") ? "disabled" : "";
    const cbChk = f.approved ? "checked" : "";
    const cbTd = `<td style="text-align:center">
      <input type="checkbox" class="approve-cb" data-i="${i}" ${cbChk} ${cbOff}/>
    </td>`;

    const fileTd = `<td>${esc(f.filename)}</td>`;

    let catTd, confTd, pathTd;

    if (f.status === "pending") {
      catTd  = `<td><span class="spinner"></span>Classifying...</td>`;
      confTd = `<td>--</td>`;
      pathTd = `<td>--</td>`;
    } else {
      if (f.status === "classified") {
        let conflictTag = "";
        if (f.conflictCategories && f.conflictCategories.length > 1) {
          conflictTag = `<span class="conflict-tag">${f.conflictCategories.map(esc).join(" vs ")}</span>`;
        }
        catTd = `<td><select class="cat-select" data-i="${i}">${catOptions(f.category)}</select>${conflictTag}</td>`;
      } else {
        catTd = `<td>${esc(formatCategory(f.category))}</td>`;
      }

      const c = f.confidence || 0;
      const fillClass = c >= 80 ? "fill-green" : c >= 50 ? "fill-amber" : "fill-red";
      confTd = `<td><div class="conf-bar-wrap">
        <div class="conf-bar-track"><div class="conf-bar-fill ${fillClass}" style="width:${c}%"></div></div>
        <span class="${confClass(c)}" style="font-size:11px;font-family:monospace">${c}%</span>
      </div></td>`;

      const pp = `${DEST_DIR}/${f.category}/${f.filename}`;
      pathTd = `<td class="path-cell">${esc(f.status === "error" ? f.errorMsg : pp)}</td>`;
    }

    // Rename button (only for classified/moved files, not pending/error)
    const canRename = f.status === "classified" || f.status === "moved";
    const renameTd = canRename
      ? `<td><button class="btn btn-ghost btn-sm rename-row-btn" data-i="${i}" data-path="${esc(f.status === "moved" ? `${DEST_DIR}/${f.category}/${f.filename}` : f.filePath)}" title="AI Rename">🏷️</button></td>`
      : `<td></td>`;

    return `<tr class="${rowClass}">${cbTd}${fileTd}${catTd}${confTd}${pathTd}${renameTd}</tr>`;
  }).join("");

  tableContainer.innerHTML = `
    <table class="results-table">
      <thead><tr>
        <th class="col-cb">Approve</th>
        <th>Current File</th>
        <th>Category</th>
        <th>Confidence</th>
        <th>Proposed Path</th>
        <th style="width:40px"></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  tableContainer.querySelectorAll(".approve-cb").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      queue[parseInt(e.target.dataset.i, 10)].approved = e.target.checked;
      updateBar();
    });
  });

  tableContainer.querySelectorAll(".cat-select").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      queue[parseInt(e.target.dataset.i, 10)].category = e.target.value;
      render();
    });
  });

  // Rename buttons in each row
  tableContainer.querySelectorAll(".rename-row-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.i, 10);
      const filePath = btn.dataset.path;
      openRenameModal(filePath, queue[i]?.extractedText || "");
    });
  });

  statFiles.textContent = queue.length;
  statReview.textContent = reviewCount;
  actionBar.classList.remove("hidden");
  updateBar();
}

function updateBar() {
  const classified = queue.filter((f) => f.status === "classified");
  const approved   = classified.filter((f) => f.approved);
  const pending    = queue.filter((f) => f.status === "pending");

  countLabel.textContent = `${approved.length} file${approved.length !== 1 ? "s" : ""} selected`;
  organizeBtn.disabled = classified.length === 0 || pending.length > 0;
  confirmBtn.disabled  = approved.length === 0 || pending.length > 0;
}

// ═════════════════════════════════════════════════════════════
//  PHASE 1 — Add files to queue (instant preview rows)
// ═════════════════════════════════════════════════════════════
function addFiles(paths) {
  for (const fp of paths) {
    if (queue.some((f) => f.filePath === fp)) continue;
    queue.push({
      filePath: fp,
      filename: basename(fp),
      status: "pending",
      category: null,
      confidence: 0,
      requires_review: false,
      isAIMatch: false,
      approved: false,
      errorMsg: null,
      extractedText: "",
      hasPII: false,
    });
  }
  render();
}

// ═════════════════════════════════════════════════════════════
//  PHASE 2 — Classify each pending file via ClassificationService
// ═════════════════════════════════════════════════════════════
async function classifyPending() {
  const pending = queue.filter((f) => f.status === "pending");
  if (!pending.length) return;

  feedAdd(`Classifying ${pending.length} file(s)...`);
  setStatus(false, "Classifying...");

  const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".webp"]);

  for (const entry of pending) {
    try {
      // Show OCR feedback for image files
      const ext = (entry.filename.includes(".") ? "." + entry.filename.split(".").pop() : "").toLowerCase();
      if (IMAGE_EXTS.has(ext)) {
        feedAdd(`Performing OCR on ${entry.filename}...`);
      }

      const r = await window.api.classify.file(entry.filePath, DEST_DIR);
      entry.status         = "classified";
      entry.category       = r.category || "Unknown";
      entry.originalCategory = r.category || "Unknown";
      entry.confidence     = r.confidence || 0;
      entry.requires_review = r.requires_review || false;
      entry.isAIMatch      = (r.match_level === "bullseye" || r.match_level === "specific" || r.match_level === "pool");
      entry.approved       = entry.confidence >= 30;
      entry.conflictCategories = r.conflict_categories || null;

      if (entry.category && !knownFolders.includes(entry.category)) {
        knownFolders.push(entry.category);
      }

      feedAdd(`${entry.filename} -> ${entry.category} (${entry.confidence}%)`);

      // Extract text for deep search + PII detection
      try {
        entry.extractedText = await window.api.extract.text(entry.filePath);
      } catch { entry.extractedText = ""; }

      // PII detection — flag SSNs
      if (hasPII(entry.extractedText)) {
        entry.hasPII = true;
        feedAdd(`RED FLAG: PII detected in ${entry.filename}`, true);
        try { await window.api.audit.write(`PII_DETECTED: ${entry.filename} -> ${entry.category}`); } catch {}
        // In Work mode, redirect to STRICTLY_SECURE + log structured incident
        if (currentMode === "work") {
          entry.category = "STRICTLY_SECURE";
          feedAdd(`${entry.filename} redirected to STRICTLY_SECURE (Work mode PII policy)`);
          try {
            await window.api.compliance.piiIncident(
              entry.filename, entry.filePath, ["PII"], "quarantined"
            );
          } catch {}
        }
      }

      // Audit log — plain text (both modes) + structured JSON (work only)
      try { await window.api.audit.write(`CLASSIFIED: ${entry.filename} -> ${entry.category} (${entry.confidence}%)`); } catch {}
      if (currentMode === "work") {
        try {
          await window.api.compliance.writeEntry("CLASSIFIED", {
            filename: entry.filename,
            folder: entry.category,
            aiConfidence: entry.confidence,
          });
        } catch {}
      }
    } catch (err) {
      entry.status   = "error";
      entry.errorMsg = String(err.message || err);
      feedAdd(`${entry.filename} ERROR: ${entry.errorMsg}`, true);
    }
    render();
  }

  const ok  = queue.filter((f) => f.status === "classified").length;
  const bad = queue.filter((f) => f.status === "error").length;
  setStatus(bad === 0, `Classified ${ok}` + (bad ? `, ${bad} error(s)` : ""));
  feedAdd("Done. Review the table, then click Confirm or Organize All.");
}

// ═════════════════════════════════════════════════════════════
//  PHASE 3 — Move files (the ONLY place file.move is called)
// ═════════════════════════════════════════════════════════════
async function organizeFiles(onlyApproved) {
  const toMove = onlyApproved
    ? queue.filter((f) => f.status === "classified" && f.approved)
    : queue.filter((f) => f.status === "classified");

  if (!toMove.length) { feedAdd("Nothing to organize."); return; }

  organizeBtn.disabled = true;
  confirmBtn.disabled  = true;
  setStatus(false, "Moving files...");

  let moved = 0, errors = 0;
  const corrections = [];

  for (const entry of toMove) {
    const dest = `${DEST_DIR}/${entry.category}/${entry.filename}`;
    try {
      await window.api.file.move(entry.filePath, dest);
      entry.status = "moved";
      moved++;
      feedAdd(`Moved: ${entry.filename} -> ${entry.category}/`);
      // Push to undo stack; any new move clears the redo stack
      undoStack.push({ from: entry.filePath, to: dest, filename: entry.filename });
      redoStack.length = 0;
      updateUndoRedoButtons();
      // Index file for chat search (fire-and-forget)
      try {
        window.api.chat.indexFile(dest, entry.category, entry.extractedText || "");
      } catch (_) {}
      corrections.push({
        filename: entry.filename,
        extension: entry.filename.includes(".") ? "." + entry.filename.split(".").pop() : "",
        aiGuess: entry.category,
        aiConfidence: entry.confidence,
        userChoice: entry.category,
      });
    } catch (err) {
      entry.status   = "error";
      entry.errorMsg = String(err.message || err);
      errors++;
      feedAdd(`FAILED: ${entry.filename} — ${entry.errorMsg}`, true);
    }
    render();
  }

  if (corrections.length) {
    try { await window.api.learning.recordBatch(corrections, DEST_DIR); } catch {}
  }

  // Audit log for each move (plain text — both modes; structured JSON — work only)
  for (const entry of toMove) {
    if (entry.status === "moved") {
      try { await window.api.audit.write(`MOVED: ${entry.filename} -> ${entry.category}/`); } catch {}
      if (currentMode === "work") {
        try {
          await window.api.compliance.writeEntry("MOVED", {
            filename:    entry.filename,
            from:        entry.filePath,
            to:          `${DEST_DIR}/${entry.category}/${entry.filename}`,
            folder:      entry.category,
            aiConfidence: entry.confidence,
          });
        } catch {}
      }
    }
  }

  // ── Association Learning: extract top nouns and save to smart_rules.json ──
  try {
    const rules = await window.api.smartRules.read() || {};
    let rulesUpdated = false;
    for (const entry of toMove) {
      if (entry.status !== "moved" || !entry.extractedText) continue;
      const nouns = extractTopNouns(entry.extractedText, 5);
      if (nouns.length === 0) continue;
      const cat = entry.category;
      if (!rules[cat]) rules[cat] = [];
      for (const n of nouns) {
        if (!rules[cat].includes(n)) rules[cat].push(n);
      }
      // Keep max 20 keywords per category
      rules[cat] = rules[cat].slice(-20);
      rulesUpdated = true;
    }
    if (rulesUpdated) {
      await window.api.smartRules.write(rules);
      const cats = [...new Set(toMove.filter(e => e.status === "moved").map(e => e.category))];
      for (const cat of cats) {
        showToast(`🧠 Learned new association for '${cat}'`);
      }
    }
  } catch {}

  // ── Reinforcement Learning: if file was "Needs Review" but user chose a real category ──
  try {
    for (const entry of toMove) {
      if (entry.status !== "moved") continue;
      // Check if original AI guess was "Needs Review" but user changed it
      if (entry.originalCategory === "Needs Review" && entry.category !== "Needs Review") {
        const nouns = extractTopNouns(entry.extractedText, 5);
        if (nouns.length > 0) {
          await window.api.knowledge.reinforce(entry.category, nouns);
          showToast(`Learned: added keywords to '${entry.category}'`);
        }
      }
    }
  } catch {}

  // ── Priority Learning: if file had a conflict and user resolved it, save priority rule ──
  try {
    for (const entry of toMove) {
      if (entry.status !== "moved") continue;
      if (entry.conflictCategories && entry.conflictCategories.length > 1 && entry.category !== "Needs Review") {
        const nouns = extractTopNouns(entry.extractedText, 5);
        await window.api.knowledge.savePriority(entry.conflictCategories, entry.category, nouns);
        showToast(`Priority rule saved: ${entry.conflictCategories.join(" vs ")} → ${entry.category}`);
      }
    }
  } catch {}

  try { await window.api.context.refresh(); } catch {}
  try {
    const s = await window.api.learning.stats();
    statCorrections.textContent = s.totalCorrections || 0;
  } catch {}

  organizeBtn.disabled = false;
  confirmBtn.disabled  = false;
  setStatus(errors === 0, `Done: ${moved} moved` + (errors ? `, ${errors} failed` : ""));
  feedAdd(`Complete: ${moved} moved, ${errors} failed.`);
}

// ═════════════════════════════════════════════════════════════
//  SELECT FILES — opens macOS file picker (openFile only)
// ═════════════════════════════════════════════════════════════
async function selectFiles() {
  const files = await window.api.dialog.openFiles();
  if (!files || !files.length) return;

  addFiles(files);
  feedAdd(`Added ${files.length} file(s).`);
  await classifyPending();
}

// ═════════════════════════════════════════════════════════════
//  SELECT FOLDER — opens folder picker, adds all files from it
// ═════════════════════════════════════════════════════════════
async function selectFolder() {
  const folder = await window.api.dialog.openFolder();
  if (!folder) return;
  const files = await window.api.scan.allFiles(folder, false);
  if (!files || !files.length) {
    feedAdd("No files found in that folder.", true);
    return;
  }
  addFiles(files);
  feedAdd(`Added ${files.length} file(s) from folder.`);
  await classifyPending();
}

// ═════════════════════════════════════════════════════════════
//  SCAN ALL FILES — pick a folder and recursively add all files
// ═════════════════════════════════════════════════════════════
async function scanAllFiles() {
  scanAllBtn.disabled = true;
  scanAllBtn.textContent = "Scanning...";

  const folder = await window.api.dialog.openFolder();
  if (!folder) {
    scanAllBtn.disabled = false;
    scanAllBtn.textContent = "Scan All Files";
    return;
  }

  const files = await window.api.scan.allFiles(folder, true);
  if (!files || !files.length) {
    feedAdd("No files found.", true);
    scanAllBtn.disabled = false;
    scanAllBtn.textContent = "Scan All Files";
    return;
  }
  feedAdd(`Scan found ${files.length} file(s) — adding to queue...`);
  addFiles(files);
  await classifyPending();
  scanAllBtn.disabled = false;
  scanAllBtn.textContent = "Scan All Files";
}

// ═════════════════════════════════════════════════════════════
//  SCAN NOW — scan DEST_DIR for existing subfolders
// ═════════════════════════════════════════════════════════════
async function scanFolder() {
  scanBtn.disabled = true;
  scanBtn.textContent = "Scanning...";
  feedAdd(`Scanning: ${DEST_DIR}`);

  try {
    const folders = await window.api.folders.scan(DEST_DIR);
    knownFolders = Array.isArray(folders) ? folders : [];
    const parentFolders = knownFolders.filter((f) => !f.includes("/"));
    const childFolders = knownFolders.filter((f) => f.includes("/"));
    statFolders.textContent = knownFolders.length;
    feedAdd(`Found ${parentFolders.length} categories with ${childFolders.length} subcategories (${knownFolders.length} total)`);

    await window.api.context.fingerprints(DEST_DIR);
    feedAdd("Fingerprints loaded.");

    try {
      const s = await window.api.learning.stats();
      statCorrections.textContent = s.totalCorrections || 0;
    } catch {}

    setStatus(true, "Ready");
  } catch (err) {
    feedAdd(`Scan error: ${err.message || err}`, true);
    setStatus(false, "Scan failed");
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = "Scan Now";
  }
}

// ── Toolbar helpers ──────────────────────────────────────────
function selectAll()   { queue.forEach((f) => { if (f.status === "classified") f.approved = true; }); render(); }
function deselectAll() { queue.forEach((f) => { f.approved = false; }); render(); }
function clearQueue()  {
  queue = [];
  render();
  statFiles.textContent = "0";
  statReview.textContent = "0";
  feedAdd("Queue cleared.");
}

// ═════════════════════════════════════════════════════════════
//  NEW CATEGORY — in-page dialog, create folder, instant refresh
// ═════════════════════════════════════════════════════════════

/** Show the New Category dialog overlay. */
function openNewCategoryDialog() {
  console.log("[renderer] + New Category button clicked — opening dialog");
  newCatInput.value = "";
  newCatOverlay.classList.remove("hidden");
  newCatInput.focus();
}

/** Actually create the folder and refresh everything. */
async function submitNewCategory() {
  const name = newCatInput.value.trim();
  newCatOverlay.classList.add("hidden");

  if (!name) {
    console.log("[renderer] New category cancelled — empty name");
    return;
  }

  console.log(`[renderer] Category "${name}" creating, refreshing list...`);
  feedAdd(`Creating category: ${name}...`);

  try {
    const result = await window.api.folders.create(name);
    // Backend returns { created, folders } — instant refresh, no second IPC call
    console.log(`[renderer] Category "${result.created}" created, refreshing list...`);
    feedAdd(`Created category: ${result.created}`);
    knownFolders = Array.isArray(result.folders) ? result.folders : [];
    statFolders.textContent = knownFolders.length;
    feedAdd(`Categories: ${knownFolders.join(", ")}`);

    // Invalidate fingerprint cache and rebuild so ClassificationService sees the new folder
    try {
      await window.api.context.refresh();
      await window.api.context.fingerprints(DEST_DIR);
    } catch {}

    // Re-render table so dropdowns pick up the new category instantly
    render();
    console.log(`[renderer] Dropdowns refreshed — ${knownFolders.length} categories available`);
    console.log(`[renderer] AI will now recognize "${result.created}" as a valid sorting target`);

    // ── Deep Recursive Search: Expansion + 2-Level Datamuse + Semantic Web + Wikipedia ──
    // PRIVACY: NO file content is uploaded. Only the category name is sent.
    feedAdd(`Deep Diving into '${result.created}'... expanding concepts + querying Datamuse + Wikipedia`);

    // Set up live progress listener for "Deepening Knowledge: [X/100]"
    let progressDiv = null;
    if (window.api.on && window.api.on.deepDiveProgress) {
      window.api.on.deepDiveProgress((current, target) => {
        const msg = `Deepening Knowledge: [${current}/${target}] concepts indexed...`;
        if (!progressDiv) {
          progressDiv = document.createElement("div");
          progressDiv.className = "feed-entry";
          feed.appendChild(progressDiv);
        }
        progressDiv.innerHTML = '<span class="feed-dot ok">&#9679;</span>' + esc(msg);
        feed.scrollTop = feed.scrollHeight;
      });
    }

    try {
      const kb = await window.api.knowledge.learnCategory(result.created);
      // Clear the progress line
      if (progressDiv) {
        progressDiv.innerHTML = '<span class="feed-dot ok">&#9679;</span>' +
          esc(`Deepening Knowledge: [${kb.concepts.length}/${100}] DONE`);
      }
      if (kb.alreadyKnown) {
        feedAdd(`Pool already knows '${result.created}' — ${kb.concepts.length} concepts (>=100, skipping)`);
        showToast(`Pool already knows '${result.created}' (${kb.concepts.length} concepts)`);
      } else if (kb.saved && kb.concepts.length > 0) {
        // Show expansion toast if the name was expanded
        if (kb.expandedName) {
          feedAdd(`Expanded '${result.created}' to '${kb.expandedName}' for better accuracy`);
          showToast(`Expanding '${result.created}' to '${kb.expandedName}' for better accuracy`, 4000);
          // Small delay so user sees the expansion toast before the final one
          await new Promise((r) => setTimeout(r, 1500));
        }
        feedAdd(`Deep Dive complete! Learned ${kb.concepts.length} concepts for "${result.created}" (e.g. ${kb.concepts.slice(0, 5).join(", ")})`);
        showToast(`Deep Dive complete! Learned ${kb.concepts.length} concepts for '${result.created}'`);
      } else {
        feedAdd(`No concepts found for "${result.created}" — AI will still classify by content.`);
      }
    } catch (err) {
      console.warn(`[renderer] Deep Dive failed: ${err}`);
      feedAdd(`Deep Dive skipped for "${result.created}" (offline?). Using original name.`);
    }
  } catch (err) {
    console.error(`[renderer] Failed to create category: ${err}`);
    feedAdd(`Failed to create category: ${err.message || err}`, true);
  }
}

// ═════════════════════════════════════════════════════════════
//  DUAL MODE SWITCHING
// ═════════════════════════════════════════════════════════════
async function switchMode(mode) {
  if (mode === currentMode) return;
  feedAdd(`Switching to ${mode === "work" ? "Work" : "Personal"} mode...`);
  setStatus(false, "Switching...");

  try {
    const result = await window.api.mode.switch(mode);
    currentMode = result.mode;
    DEST_DIR = result.baseDir;

    // Update visuals
    personalModeBtn.classList.toggle("active", mode === "personal");
    workModeBtn.classList.toggle("active", mode === "work");
    appHeader.classList.toggle("work-mode", mode === "work");
    icloudBadge.classList.toggle("visible", mode === "work");

    // Update dest banner
    if (mode === "work") {
      destBannerText.innerHTML = 'Sorting to: <strong>~/iCloud/AI_ORGANIZER_PRO</strong> ☁️';
    } else {
      destBannerText.innerHTML = 'Sorting to: <strong>~/Desktop/AI_SORTED_FILES</strong>';
    }

    // Refresh folders for new base dir
    knownFolders = Array.isArray(result.folders) ? result.folders : [];
    statFolders.textContent = knownFolders.length;

    // Clear queue — different mode = different context
    queue = [];
    render();
    statFiles.textContent = "0";
    statReview.textContent = "0";
    deepSearchInput.value = "";

    // Reload fingerprints
    try {
      await window.api.context.refresh();
      await window.api.context.fingerprints(DEST_DIR);
    } catch {}

    feedAdd(`${mode === "work" ? "Work" : "Personal"} mode active — ${knownFolders.length} folders`);
    setStatus(true, mode === "work" ? "Work Mode" : "Ready");
    showToast(mode === "work" ? "🏢 Work Mode — iCloud Synced" : "🏠 Personal Mode");

    // Show/hide the Folder Watcher bar in Work Mode
    const watcherBar = $("watcherBar");
    if (watcherBar) watcherBar.classList.toggle("hidden", mode !== "work");
  } catch (err) {
    feedAdd(`Mode switch failed: ${err.message || err}`, true);
    setStatus(false, "Switch failed");
  }
}

// ═════════════════════════════════════════════════════════════
//  BOSS DASHBOARD (PIN-gated)
// ═════════════════════════════════════════════════════════════
function openAdminPinDialog() {
  adminPinInput.value = "";
  adminPinOverlay.classList.remove("hidden");
  adminPinInput.focus();
}

async function verifyAdminPin() {
  const pin = adminPinInput.value.trim();
  adminPinOverlay.classList.add("hidden");

  if (pin !== "1234") {
    showToast("Invalid PIN. Access denied.");
    return;
  }

  tableContainer.classList.add("hidden");
  actionBar.classList.add("hidden");
  bossDashOverlay.classList.remove("hidden");

  if (currentMode === "work") {
    await openEnterpriseDashboard();
  } else {
    openPersonalDashboard();
  }
}

// ── Personal Mode Dashboard (simple) ──────────────────────────────────────────
function openPersonalDashboard() {
  const fileCount = queue.length;
  const roi = fileCount * 10;
  const piiCount = queue.filter(f => f.hasPII).length;

  $("bossDashTitle").textContent = "Dashboard";

  bossDashContent.innerHTML = `
    <div class="boss-stat">
      <div class="boss-label">ROI Calculator</div>
      <div class="boss-value">Total Estimated Savings: $${roi.toLocaleString()}</div>
    </div>
    <div class="boss-stat">
      <div class="boss-label">Security Report</div>
      <div class="boss-value danger">Sensitive Files Flagged: ${piiCount}</div>
    </div>
    <div class="boss-stat">
      <div class="boss-label">Current Mode</div>
      <div class="boss-value">🏠 Personal (Desktop)</div>
    </div>
    <div class="boss-stat">
      <div class="boss-label">Files Processed</div>
      <div class="boss-value">${fileCount}</div>
    </div>
  `;

  $("bossDashActions").innerHTML = `
    <button class="btn btn-primary btn-sm" id="exportKnowledgeBtn">Export Knowledge Graph</button>
    <button class="btn btn-warning btn-sm" id="cleanPoolBtn">Clean Pool (AI)</button>
    <button class="btn btn-danger btn-sm" id="exportLogBtn">Download Compliance Log</button>
    <button class="btn btn-success btn-sm" id="exitBossDashBtn">Close</button>
  `;
  $("exportKnowledgeBtn").addEventListener("click", exportKnowledgeGraph);
  $("cleanPoolBtn").addEventListener("click", cleanKnowledgePool);
  $("exportLogBtn").addEventListener("click", exportComplianceLog);
  $("exitBossDashBtn").addEventListener("click", exitBossDashboard);
}

// ── Enterprise Work Mode Dashboard ────────────────────────────────────────────
async function openEnterpriseDashboard() {
  $("bossDashTitle").textContent = "🏢 Enterprise Compliance Dashboard";
  bossDashContent.innerHTML = `<div style="text-align:center;padding:24px;color:#aaa;font-size:13px;">Loading compliance data…</div>`;

  $("bossDashActions").innerHTML = `
    <button class="btn btn-primary btn-sm" id="entExportPdfBtn">Export PDF Report</button>
    <button class="btn btn-ghost btn-sm" id="entRetentionBtn">⏱ Retention Rules</button>
    <button class="btn btn-ghost btn-sm" id="entLanBtn">🌐 LAN Config</button>
    <button class="btn btn-success btn-sm" id="exitBossDashBtn">Close</button>
  `;
  $("entExportPdfBtn").addEventListener("click", async () => {
    showToast("Generating PDF…");
    try {
      const res = await window.api.compliance.exportPDF();
      if (res && res.ok) showToast(`PDF saved: ${res.path ? res.path.split("/").pop() : "compliance_report.pdf"}`);
      else showToast("PDF export failed.");
    } catch (err) { showToast(`PDF error: ${err}`); }
  });
  $("entRetentionBtn").addEventListener("click", () => openRetentionModal());
  $("entLanBtn").addEventListener("click", () => openLanConfigModal());
  $("exitBossDashBtn").addEventListener("click", exitBossDashboard);

  try {
    const [stats, incidents, retention] = await Promise.all([
      window.api.compliance.stats(),
      window.api.compliance.piiIncidents(),
      window.api.compliance.scanRetention(),
    ]);

    const scoreColor = stats.complianceScore >= 80 ? "#34d399"
      : stats.complianceScore >= 50 ? "#fb923c" : "#f87171";

    // Top folders activity bars
    const maxCount = Math.max(...(stats.topFolders || []).map(f => f.count), 1);
    const folderBars = (stats.topFolders || []).map(f => `
      <div class="ent-bar-row">
        <span class="ent-bar-label">${f.folder}</span>
        <div class="ent-bar-track"><div class="ent-bar-fill" style="width:${Math.round((f.count / maxCount) * 100)}%"></div></div>
        <span class="ent-bar-count">${f.count}</span>
      </div>`).join("") || `<div style="color:#aaa;font-size:12px">No moves recorded yet.</div>`;

    // Unresolved PII table rows
    const unresolvedIncidents = (incidents || []).filter(i => !i.resolved).slice(0, 10);
    const piiRows = unresolvedIncidents.length === 0
      ? `<tr><td colspan="4" style="color:#aaa;text-align:center;padding:10px">No open PII incidents ✓</td></tr>`
      : unresolvedIncidents.map(i => `
          <tr>
            <td>${new Date(i.timestamp).toLocaleDateString()}</td>
            <td title="${i.fullPath}">${i.filename}</td>
            <td>${i.detectedTypes.join(", ") || "PII"}</td>
            <td><button class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 7px"
              data-pii-resolve="${i.id}">Resolve</button></td>
          </tr>`).join("");

    // Retention violation rows
    const retRows = (retention || []).length === 0
      ? `<tr><td colspan="4" style="color:#aaa;text-align:center;padding:10px">No violations ✓</td></tr>`
      : (retention || []).slice(0, 8).map(r => `
          <tr>
            <td title="${r.fullPath}">${r.filename}</td>
            <td>${r.folder}</td>
            <td>${r.ageDays}d</td>
            <td style="color:#fb923c;font-size:11px">${r.ruleLabel}</td>
          </tr>`).join("");

    bossDashContent.innerHTML = `
      <div class="ent-grid">
        <div class="ent-card" style="text-align:center">
          <div style="font-size:10px;text-transform:uppercase;color:#aaa;letter-spacing:.5px;margin-bottom:6px">Compliance Score</div>
          <div class="ent-score-ring" style="color:${scoreColor}">${stats.complianceScore}</div>
          <div style="font-size:10px;color:${scoreColor};margin-top:4px">/100</div>
        </div>
        <div class="ent-card">
          <div style="font-size:10px;text-transform:uppercase;color:#aaa;letter-spacing:.5px;margin-bottom:8px">Audit Summary</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div><div style="font-size:22px;font-weight:700;color:#e0e0e0">${stats.totalMoves}</div><div style="font-size:10px;color:#aaa">Files Organized</div></div>
            <div><div style="font-size:22px;font-weight:700;color:#e0e0e0">${stats.totalAuditEntries}</div><div style="font-size:10px;color:#aaa">Audit Entries</div></div>
            <div><div style="font-size:22px;font-weight:700;color:${stats.unresolvedPII > 0 ? "#f87171" : "#34d399"}">${stats.totalPIIIncidents}</div><div style="font-size:10px;color:#aaa">PII Incidents</div></div>
            <div><div style="font-size:22px;font-weight:700;color:${stats.retentionFlags > 0 ? "#fb923c" : "#34d399"}">${stats.retentionFlags}</div><div style="font-size:10px;color:#aaa">Retention Flags</div></div>
          </div>
        </div>
        <div class="ent-card">
          <div style="font-size:10px;text-transform:uppercase;color:#aaa;letter-spacing:.5px;margin-bottom:8px">Top Folders</div>
          ${folderBars}
        </div>
      </div>

      <div style="margin-bottom:10px">
        <div style="font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">
          🔐 Open PII Incidents ${stats.unresolvedPII > 0 ? `<span class="ent-badge danger">${stats.unresolvedPII}</span>` : ""}
        </div>
        <table class="ent-table">
          <thead><tr><th>Date</th><th>File</th><th>Type</th><th>Action</th></tr></thead>
          <tbody id="entPiiTbody">${piiRows}</tbody>
        </table>
      </div>

      <div>
        <div style="font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">
          ⏱ Retention Violations ${(retention || []).length > 0 ? `<span class="ent-badge warn">${retention.length}</span>` : ""}
        </div>
        <table class="ent-table">
          <thead><tr><th>File</th><th>Folder</th><th>Age</th><th>Rule</th></tr></thead>
          <tbody>${retRows}</tbody>
        </table>
      </div>
    `;

    // Wire PII resolve buttons
    bossDashContent.querySelectorAll("[data-pii-resolve]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.piiResolve;
        const ok = await window.api.compliance.resolvePII(id);
        if (ok) {
          btn.closest("tr").remove();
          showToast("PII incident resolved.");
          // Refresh score display after resolve
          const row = $("entPiiTbody");
          if (row && row.querySelectorAll("tr").length === 0) {
            row.innerHTML = `<tr><td colspan="4" style="color:#aaa;text-align:center;padding:10px">No open PII incidents ✓</td></tr>`;
          }
        } else {
          showToast("Failed to resolve incident.");
        }
      });
    });

  } catch (err) {
    bossDashContent.innerHTML = `<div style="color:#f87171;padding:16px;font-size:13px">Failed to load compliance data: ${err.message || err}</div>`;
  }
}

async function exportComplianceLog() {
  try {
    const log = await window.api.audit.read();
    const blob = new Blob([log || "No entries yet."], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `compliance_log_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Compliance log exported.");
  } catch {
    showToast("Failed to export log.");
  }
}

async function exportKnowledgeGraph() {
  try {
    const pool = await window.api.knowledge.exportPool();
    const blob = new Blob([pool], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `knowledge_graph_${currentMode}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Knowledge Graph exported.");
  } catch {
    showToast("Failed to export Knowledge Graph.");
  }
}

async function cleanKnowledgePool() {
  if (!window.api?.knowledge?.cleanPool) {
    showToast("Pool cleanup not available.");
    return;
  }
  showToast("Cleaning knowledge pool with AI... this may take a minute.");
  feedAdd("[Pool] Starting AI-powered cleanup — removing garbage concepts...");
  try {
    const stats = await window.api.knowledge.cleanPool();
    const catCount = stats.cleaned || 0;
    const removed = stats.totalRemoved || 0;
    showToast(`Pool cleaned! Removed ${removed} garbage concepts across ${catCount} categories.`);
    feedAdd(`[Pool] Cleanup complete: ${removed} concepts removed from ${catCount} categories.`);
    if (stats.details) {
      for (const [cat, detail] of Object.entries(stats.details)) {
        if (detail.removed > 0) {
          feedAdd(`  ${cat}: ${detail.before} → ${detail.afterAI || detail.afterBasic} (${detail.removed} removed)`);
        }
      }
    }
  } catch (err) {
    showToast("Pool cleanup failed: " + (err.message || err));
    feedAdd("[Pool] Cleanup failed: " + (err.message || err));
  }
}

function exitBossDashboard() {
  bossDashOverlay.classList.add("hidden");
  tableContainer.classList.remove("hidden");
  render();
}

// ── Settings panel ───────────────────────────────────────────
async function openSettings() {
  settingsOverlay.classList.remove("hidden");
  try {
    const c = await window.api.extract.capabilities();
    $("capPdf").textContent     = c.pdfParse ? "Installed" : "Missing";
    $("capPdf").classList.toggle("missing", !c.pdfParse);
    $("capMammoth").textContent = c.mammoth  ? "Installed" : "Missing";
    $("capMammoth").classList.toggle("missing", !c.mammoth);
    $("capAdmZip").textContent  = c.admZip   ? "Installed" : "Missing";
    $("capAdmZip").classList.toggle("missing", !c.admZip);
    $("capTesseract").textContent = c.tesseractJs ? "Installed" : "Missing";
    $("capTesseract").classList.toggle("missing", !c.tesseractJs);
  } catch {}
  try {
    const s = await window.api.learning.stats();
    $("capCorr").textContent = s.totalCorrections || 0;
  } catch {}
  try {
    const n = await window.api.context.noiseFolders();
    $("capNoise").textContent = Array.isArray(n) ? n.join(", ") : String(n);
  } catch {}
}

// ═════════════════════════════════════════════════════════════
//  BOOTSTRAP
// ═════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", async () => {
  feedAdd("AI Organizer loaded.");

  // ── Fetch destination path from main process FIRST ──
  if (!window.api) {
    setStatus(false, "No API");
    feedAdd("window.api not found — is preload.js loaded?", true);
    return;
  }

  try {
    DEST_DIR = await window.api.getDestDir();
    feedAdd(`Destination: ${DEST_DIR}`);
  } catch (err) {
    feedAdd("FATAL: Could not get destination path from main process.", true);
    setStatus(false, "Path error");
    return;
  }

  // ── Wire up buttons ──

  // Dual Mode
  personalModeBtn.addEventListener("click", () => switchMode("personal"));
  workModeBtn.addEventListener("click", () => switchMode("work"));

  // Neural Omnibar — live filter on typing, Q&A on Enter
  deepSearchInput.addEventListener("input", () => {
    hideNeuralAnswer();
    applyDeepSearch();
  });
  deepSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleOmnibarEnter();
    }
    if (e.key === "Escape") {
      deepSearchInput.value = "";
      hideNeuralAnswer();
      applyDeepSearch();
    }
  });

  // Admin / Boss Dashboard
  adminFooter.addEventListener("click", openAdminPinDialog);
  adminPinOkBtn.addEventListener("click", verifyAdminPin);
  adminPinCancelBtn.addEventListener("click", () => adminPinOverlay.classList.add("hidden"));
  adminPinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") verifyAdminPin();
    if (e.key === "Escape") adminPinOverlay.classList.add("hidden");
  });
  adminPinOverlay.addEventListener("click", (e) => {
    if (e.target === adminPinOverlay) adminPinOverlay.classList.add("hidden");
  });
  exportLogBtn.addEventListener("click", exportComplianceLog);
  exportKnowledgeBtn.addEventListener("click", exportKnowledgeGraph);
  exitBossDashBtn.addEventListener("click", exitBossDashboard);
  bossDashOverlay.addEventListener("click", (e) => {
    if (e.target === bossDashOverlay) exitBossDashboard();
  });

  selectFilesBtn.addEventListener("click", selectFiles);
  selectFolderBtn.addEventListener("click", selectFolder);
  scanAllBtn.addEventListener("click", scanAllFiles);
  newCategoryBtn.addEventListener("click", openNewCategoryDialog);
  scanBtn.addEventListener("click", scanFolder);
  organizeBtn.addEventListener("click", () => organizeFiles(false));
  confirmBtn.addEventListener("click",  () => organizeFiles(true));
  cancelBtn.addEventListener("click", clearQueue);
  selectAllBtn.addEventListener("click", selectAll);
  deselectAllBtn.addEventListener("click", deselectAll);
  settingsBtn.addEventListener("click", openSettings);
  closeSettingsBtn.addEventListener("click", () => settingsOverlay.classList.add("hidden"));

  // ── Undo / Redo buttons ──
  const undoBtnEl = $("undoBtn");
  const redoBtnEl = $("redoBtn");
  if (undoBtnEl) undoBtnEl.addEventListener("click", doUndo);
  if (redoBtnEl) redoBtnEl.addEventListener("click", doRedo);
  updateUndoRedoButtons();

  // ── Folder Watcher UI (Work Mode) ──
  initWatcherUI();

  // ── Rename Modal ──
  $("renameCancelBtn")?.addEventListener("click", () => $("renameOverlay").classList.add("hidden"));
  $("renameApplyBtn")?.addEventListener("click", applyRenameFromModal);

  clearLearningBtn.addEventListener("click", async () => {
    try {
      await window.api.learning.clear();
      $("capCorr").textContent = "0";
      statCorrections.textContent = "0";
      feedAdd("Learning data cleared.");
    } catch {}
  });

  refreshFpBtn.addEventListener("click", async () => {
    try {
      await window.api.context.refresh();
      await window.api.context.fingerprints(DEST_DIR);
      feedAdd("Fingerprints refreshed.");
    } catch {}
  });

  settingsOverlay.addEventListener("click", (e) => {
    if (e.target === settingsOverlay) settingsOverlay.classList.add("hidden");
  });

  // ── New Category dialog buttons ──
  newCatOkBtn.addEventListener("click", submitNewCategory);
  newCatCancelBtn.addEventListener("click", () => {
    newCatOverlay.classList.add("hidden");
  });
  newCatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitNewCategory();
    if (e.key === "Escape") newCatOverlay.classList.add("hidden");
  });
  newCatOverlay.addEventListener("click", (e) => {
    if (e.target === newCatOverlay) newCatOverlay.classList.add("hidden");
  });

  if (window.api.on) {
    window.api.on.ollamaError((m) => {
      setStatus(false, "Ollama error");
      feedAdd(`Ollama: ${m}`, true);
    });

    // ── Auto-Update events ──
    if (window.api.on.updateAvailable) {
      window.api.on.updateAvailable(() => {
        updateBanner.classList.remove("hidden");
        updateBannerText.textContent = "An update is available \u2014 downloading in background...";
      });
    }
    if (window.api.on.updateDownloaded) {
      window.api.on.updateDownloaded(() => {
        updateBanner.classList.remove("hidden");
        updateBannerText.innerHTML =
          'Update ready. Restart to apply. <button class="update-btn" id="updateRestartBtn">Restart Now</button>';
        const restartBtn = $("updateRestartBtn");
        if (restartBtn) {
          restartBtn.addEventListener("click", () => {
            window.api.update.install();
          });
        }
      });
    }

    // ── Watcher: background auto-organize notification ──
    if (window.api.on.watcherOrganized) {
      window.api.on.watcherOrganized((event) => {
        const label = event.disambiguated ? "✅ You chose" : "⚡ Auto-organized";
        showToast(`${label}: ${event.filename} → ${event.category}/`, 4000);
        feedAdd(`Auto-organized: ${event.filename} → ${event.category}/ (${event.confidence}%)`);
        // Push to undo stack so user can reverse it
        undoStack.push({ from: event.sourcePath, to: event.destPath, filename: event.filename });
        redoStack.length = 0;
        updateUndoRedoButtons();
        // Index for chat
        try { window.api.chat.indexFile(event.destPath, event.category, ""); } catch (_) {}
      });
    }

    // ── Disambiguation Pipeline: Step 3/4 ────────────────────────────────
    // Shown when AI confidence < 80% with two plausible folders.
    if (window.api.on.watcherNeedsDisambiguation) {
      window.api.on.watcherNeedsDisambiguation((data) => {
        showDisambiguationCard(data);
      });
    }
  }

  // ── Initial status check ──
  setStatus(false, "Checking...");

  try {
    const c = await window.api.extract.capabilities();
    const ok = c.pdfParse && c.mammoth && c.admZip;
    setStatus(ok, ok ? "Ready" : "Some extractors missing");
    feedAdd(`Extractors: pdf=${c.pdfParse}, mammoth=${c.mammoth}, zip=${c.admZip}, ocr=${c.tesseractJs}`);
  } catch {
    setStatus(false, "Backend error");
    feedAdd("Could not reach backend.", true);
  }

  // ── Auto-scan destination on startup to populate Category dropdown ──
  try {
    const folders = await window.api.folders.scan(DEST_DIR);
    knownFolders = Array.isArray(folders) ? folders : [];
    statFolders.textContent = knownFolders.length;
    if (knownFolders.length) {
      feedAdd(`Categories: ${knownFolders.join(", ")}`);
    }
  } catch {
    feedAdd(`${DEST_DIR} will be created on first organize.`);
  }

  // ── Load fingerprints for the destination ──
  try {
    await window.api.context.fingerprints(DEST_DIR);
    feedAdd("Fingerprints loaded.");
  } catch {}

  // ── Load learning stats ──
  try {
    const s = await window.api.learning.stats();
    statCorrections.textContent = s.totalCorrections || 0;
  } catch {}
});

// ── Folder Watcher UI ─────────────────────────────────────────────────────────

function initWatcherUI() {
  const bar         = $("watcherBar");
  const dot         = $("watcherDot");
  const label       = $("watcherLabel");
  const foldersEl   = $("watcherFolders");
  const addBtn      = $("watcherAddBtn");
  const toggleBtn   = $("watcherToggleBtn");
  if (!bar) return;

  let watcherConfig = { enabled: false, folders: [] };

  function renderWatcherBar() {
    dot.classList.toggle("active", watcherConfig.enabled && watcherConfig.activeWatchers > 0);
    label.textContent = watcherConfig.enabled
      ? `Auto-Organize: On (${watcherConfig.folders.length} folder${watcherConfig.folders.length !== 1 ? "s" : ""})`
      : "Auto-Organize: Off";
    toggleBtn.textContent = watcherConfig.enabled ? "Disable" : "Enable";
    toggleBtn.classList.toggle("active", watcherConfig.enabled);

    // Render folder chips
    foldersEl.innerHTML = watcherConfig.folders.map((f) => {
      const name = f.split("/").pop() || f;
      return `<span class="watcher-folder-chip" title="${f}">${name}<span class="chip-remove" data-folder="${f}">✕</span></span>`;
    }).join("");

    // Remove chips on ✕ click
    foldersEl.querySelectorAll(".chip-remove").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const folder = btn.dataset.folder;
        const res = await window.api.watcher.removeFolder(folder);
        if (res.ok) { watcherConfig = { ...res.config, activeWatchers: 0 }; renderWatcherBar(); }
      });
    });
  }

  // Load current state
  window.api.watcher.status().then((s) => { watcherConfig = s; renderWatcherBar(); }).catch(() => {});

  addBtn.addEventListener("click", async () => {
    const folder = await window.api.watcher.pickFolder();
    if (!folder) return;
    const res = await window.api.watcher.addFolder(folder);
    if (res.ok) {
      watcherConfig = { ...res.config, activeWatchers: watcherConfig.activeWatchers + 1 };
      renderWatcherBar();
      showToast(`Watching: ${folder.split("/").pop()}`);
    }
  });

  toggleBtn.addEventListener("click", async () => {
    const enabled = !watcherConfig.enabled;
    const res = await window.api.watcher.setEnabled(enabled);
    if (res.ok) {
      watcherConfig = { ...res.config, activeWatchers: enabled ? res.config.folders.length : 0 };
      renderWatcherBar();
      showToast(enabled ? "⚡ Auto-organize enabled" : "Auto-organize paused");
    }
  });
}

// ── AI Rename Modal ────────────────────────────────────────────────────────────

// Track currently open rename session
let _renameFilePath = null;
let _renameExtension = "";

async function openRenameModal(filePath, textContent) {
  const overlay  = $("renameOverlay");
  const origEl   = $("renameOriginal");
  const input    = $("renameInput");
  const confEl   = $("renameConfidence");
  const spinner  = $("renameSpinner");
  const applyBtn = $("renameApplyBtn");

  const filename = filePath.split("/").pop() || filePath;
  _renameFilePath = filePath;
  _renameExtension = filename.includes(".") ? "." + filename.split(".").pop() : "";

  origEl.textContent   = filename;
  input.value          = "";
  input.placeholder    = "Generating…";
  confEl.classList.add("hidden");
  spinner.classList.remove("hidden");
  applyBtn.disabled    = true;

  overlay.classList.remove("hidden");

  try {
    const res = await window.api.rename.suggest(filePath, textContent || "");
    spinner.classList.add("hidden");
    if (res.ok && res.suggestion) {
      input.value = res.suggestion.suggestedName;
      input.placeholder = "";
      applyBtn.disabled = false;
      confEl.classList.remove("hidden");
      confEl.textContent = `Confidence: ${res.suggestion.confidence} · ${res.suggestion.reasoning}`;
    } else {
      input.placeholder = "AI unavailable — type a name manually";
      applyBtn.disabled = false;
    }
  } catch (err) {
    spinner.classList.add("hidden");
    input.placeholder = "Error — type a name manually";
    applyBtn.disabled = false;
    feedAdd(`Rename suggestion failed: ${err}`, true);
  }

  input.focus();
  input.select();

  // Enable apply whenever the user types
  input.oninput = () => { applyBtn.disabled = input.value.trim().length === 0; };
}

async function applyRenameFromModal() {
  const overlay  = $("renameOverlay");
  const input    = $("renameInput");
  const applyBtn = $("renameApplyBtn");
  const newName  = input.value.trim();

  if (!newName || !_renameFilePath) return;

  // Ensure the extension is preserved
  const finalName = newName.endsWith(_renameExtension)
    ? newName
    : newName + _renameExtension;

  applyBtn.disabled = true;
  try {
    const res = await window.api.rename.apply(_renameFilePath, finalName);
    if (res.ok) {
      showToast(`Renamed → ${finalName}`);
      feedAdd(`Renamed: ${_renameFilePath.split("/").pop()} → ${finalName}`);
      overlay.classList.add("hidden");
      _renameFilePath = null;
    } else {
      showToast(`Rename failed: ${res.error}`);
      applyBtn.disabled = false;
    }
  } catch (err) {
    showToast(`Rename error: ${err}`);
    applyBtn.disabled = false;
  }
}

// ── Enterprise Retention Rules Modal ──────────────────────────────────────────

async function openRetentionModal() {
  const overlay     = $("retentionOverlay");
  const rulesList   = $("retentionRulesList");
  const folderSel   = $("retentionFolderSel");
  const daysInput   = $("retentionDaysInput");
  const labelInput  = $("retentionLabelInput");
  const addBtn      = $("retentionAddBtn");
  const closeBtn    = $("retentionCloseBtn");
  if (!overlay) return;

  overlay.classList.remove("hidden");

  // Populate folder dropdown from enterprise folders
  try {
    const folders = await window.api.enterprise.getFolders();
    folderSel.innerHTML = (folders || []).map(f =>
      `<option value="${f}">${f}</option>`).join("") ||
      `<option value="">No folders found</option>`;
  } catch {
    folderSel.innerHTML = `<option value="">Error loading folders</option>`;
  }

  async function renderRules() {
    try {
      const rules = await window.api.compliance.getRetentionRules();
      if (!rules || rules.length === 0) {
        rulesList.innerHTML = `<div style="color:#aaa;font-size:12px;padding:8px 0">No retention rules configured yet.</div>`;
        return;
      }
      rulesList.innerHTML = rules.map(r => `
        <div class="retention-rule-chip">
          <span><strong>${r.folder}</strong> · ${r.maxAgeDays}d · <em style="color:#aaa">${r.label}</em></span>
          <button class="chip-remove" data-rule-id="${r.id}" title="Delete rule">✕</button>
        </div>`).join("");

      rulesList.querySelectorAll("[data-rule-id]").forEach(btn => {
        btn.addEventListener("click", async () => {
          await window.api.compliance.deleteRetentionRule(btn.dataset.ruleId);
          renderRules();
          showToast("Retention rule deleted.");
        });
      });
    } catch {
      rulesList.innerHTML = `<div style="color:#f87171;font-size:12px">Failed to load rules.</div>`;
    }
  }

  renderRules();

  addBtn.onclick = async () => {
    const folder = folderSel.value.trim();
    const days   = parseInt(daysInput.value, 10);
    const label  = labelInput.value.trim();
    if (!folder || !days || days < 1) { showToast("Fill in all fields."); return; }
    await window.api.compliance.addRetentionRule(folder, days, label || `${folder} — ${days}d retention`);
    labelInput.value = "";
    renderRules();
    showToast("Retention rule added.");
  };

  closeBtn.onclick = () => overlay.classList.add("hidden");
  overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.add("hidden"); };
}

// ── Enterprise LAN Config Modal ────────────────────────────────────────────────

async function openLanConfigModal() {
  const overlay   = $("lanConfigOverlay");
  const urlInput  = $("lanOllamaUrl");
  const saveBtn   = $("lanSaveBtn");
  const cancelBtn = $("lanCancelBtn");
  if (!overlay) return;

  overlay.classList.remove("hidden");

  // Load existing config
  try {
    const cfg = await window.api.enterprise.getLanConfig();
    urlInput.value = (cfg && cfg.ollamaUrl) ? cfg.ollamaUrl : "";
  } catch {
    urlInput.value = "";
  }

  saveBtn.onclick = async () => {
    const url = urlInput.value.trim();
    if (!url) { showToast("Enter a valid Ollama URL."); return; }
    try {
      await window.api.enterprise.saveLanConfig({ ollamaUrl: url });
      showToast("LAN config saved. Restart the app for changes to take effect.");
      overlay.classList.add("hidden");
    } catch (err) {
      showToast(`Save failed: ${err.message || err}`);
    }
  };

  cancelBtn.onclick = () => overlay.classList.add("hidden");
  overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.add("hidden"); };
}

// ── Chat Panel ────────────────────────────────────────────────────────────────

(function initChat() {
  const chatBtn      = $("chatBtn");
  const chatPanel    = $("chatPanel");
  const chatOverlay  = $("chatOverlay");
  const chatCloseBtn = $("chatCloseBtn");
  const chatMessages = $("chatMessages");
  const chatInput    = $("chatInput");
  const chatSendBtn  = $("chatSendBtn");
  const chatSubtitle = $("chatSubtitle");

  // Conversation history for multi-turn context
  let history = [];
  let isStreaming = false;
  let currentAiBubble = null;

  // ── Open / Close ──────────────────────────────────────────
  function openChat() {
    chatPanel.classList.remove("hidden");
    chatOverlay.classList.remove("hidden");
    requestAnimationFrame(() => chatPanel.classList.add("open"));
    chatInput.focus();
    updateSubtitle();
    refreshReindexBar();
  }

  function closeChat() {
    chatPanel.classList.remove("open");
    chatOverlay.classList.add("hidden");
    setTimeout(() => chatPanel.classList.add("hidden"), 300);
  }

  async function updateSubtitle() {
    try {
      const stats = await window.api.chat.stats();
      if (stats.totalFiles > 0) {
        chatSubtitle.textContent = `${stats.totalFiles} files indexed across ${Object.keys(stats.folders).length} folders`;
        const notice = chatMessages.querySelector(".chat-no-index");
        if (notice) notice.remove();
      } else {
        chatSubtitle.textContent = "Organize files first to enable search";
        const welcome = chatMessages.querySelector(".chat-welcome");
        if (welcome && !chatMessages.querySelector(".chat-no-index")) {
          const notice = document.createElement("div");
          notice.className = "chat-no-index";
          notice.style.cssText = "background:rgba(251,146,60,0.08);border:1px solid rgba(251,146,60,0.2);border-radius:8px;padding:10px 14px;font-size:0.78rem;color:rgba(251,146,60,0.85);margin-top:12px;line-height:1.5;";
          notice.textContent = "⚠️ No files indexed yet. Organize files through the app and confirm the moves — they'll automatically become searchable here.";
          welcome.appendChild(notice);
        }
      }
    } catch (_) {}
  }

  chatBtn.addEventListener("click", openChat);
  chatCloseBtn.addEventListener("click", closeChat);
  chatOverlay.addEventListener("click", closeChat);

  // ── Reindex existing files ─────────────────────────────────
  const reindexBar  = $("chatReindexBar");
  const reindexBtn  = $("chatReindexBtn");
  const reindexProg = $("chatReindexProgress");
  const reindexFill = $("chatReindexFill");
  const reindexStat = $("chatReindexStatus");
  const reindexInfo = $("chatReindexInfo");

  // Show/hide the reindex bar based on index size
  async function refreshReindexBar() {
    try {
      const stats = await window.api.chat.stats();
      if (stats.totalFiles === 0) {
        reindexBar.classList.remove("hidden");
        reindexInfo.textContent = "No files indexed yet — scan your existing organized files to enable AI search.";
      } else {
        // Always show but with a softer message if already indexed
        reindexBar.classList.remove("hidden");
        reindexInfo.textContent = `${stats.totalFiles} files indexed. Re-scan if you moved files outside the app.`;
      }
    } catch (_) {}
  }

  reindexBtn.addEventListener("click", async () => {
    reindexBtn.disabled = true;
    reindexBtn.textContent = "Indexing…";
    reindexProg.classList.remove("hidden");
    reindexFill.style.width = "0%";
    reindexStat.textContent = "Starting scan…";

    // Listen for progress events
    let total = 0;
    window.api.on.reindexProgress((progress) => {
      if (progress.scanned > 0) {
        total = progress.scanned;
        const pct = Math.min(100, Math.round((progress.indexed / total) * 100));
        reindexFill.style.width = pct + "%";
        reindexStat.textContent = progress.done
          ? `Done — ${progress.indexed} files indexed`
          : `${progress.indexed} / ${total} · ${progress.currentFile}`;
      }
      if (progress.done) {
        reindexBtn.disabled = false;
        reindexBtn.textContent = "⚡ Index Existing Files";
        updateSubtitle();
        refreshReindexBar();
        reindexFill.style.width = "100%";
      }
    });

    try {
      await window.api.chat.reindexAll();
    } catch (err) {
      reindexStat.textContent = "Error: " + err;
      reindexBtn.disabled = false;
      reindexBtn.textContent = "⚡ Index Existing Files";
    }
  });

  // Suggestion chips
  chatMessages.addEventListener("click", (e) => {
    const btn = e.target.closest(".chat-suggestion");
    if (btn) sendMessage(btn.dataset.q);
  });

  // ── File Preview Panel ────────────────────────────────────
  // Shared preview panel injected once into the chat panel
  let previewPanel = null;

  function getPreviewPanel() {
    if (previewPanel) return previewPanel;
    previewPanel = document.createElement("div");
    previewPanel.className = "chat-preview hidden";
    previewPanel.innerHTML = `
      <div class="chat-preview-header">
        <div class="chat-preview-title" id="chatPreviewTitle">File Preview</div>
        <button class="chat-close" id="chatPreviewClose">✕</button>
      </div>
      <div class="chat-preview-body" id="chatPreviewBody"></div>`;
    chatPanel.appendChild(previewPanel);
    document.getElementById("chatPreviewClose").addEventListener("click", () => {
      previewPanel.classList.add("hidden");
    });
    return previewPanel;
  }

  function highlightText(text, queryWords) {
    if (!queryWords || queryWords.length === 0) return escapeHtml(text);
    const escaped = escapeHtml(text);
    // Build a regex that matches any query word (case-insensitive)
    const pattern = queryWords
      .filter((w) => w.length >= 3)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    if (!pattern) return escaped;
    return escaped.replace(
      new RegExp(`(${pattern})`, "gi"),
      '<mark class="chat-highlight">$1</mark>'
    );
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function openFilePreview(source, queryWords) {
    const panel = getPreviewPanel();
    const titleEl = document.getElementById("chatPreviewTitle");
    const bodyEl  = document.getElementById("chatPreviewBody");

    titleEl.textContent = source.filename;
    bodyEl.innerHTML = '<div style="color:rgba(255,255,255,0.35);font-size:0.8rem;padding:12px;">Loading...</div>';
    panel.classList.remove("hidden");

    try {
      // Get full text content via existing extract API
      const fullText = await window.api.extract.text(source.fullPath);
      const display  = fullText && fullText.trim() ? fullText : source.snippet;

      if (!display || !display.trim()) {
        bodyEl.innerHTML = '<div style="color:rgba(255,255,255,0.35);font-size:0.8rem;padding:12px;">No text content available for this file.</div>';
        return;
      }

      // Find the best snippet window (center around the first highlight hit)
      const lower = display.toLowerCase();
      let startPos = 0;
      for (const w of queryWords) {
        const idx = lower.indexOf(w.toLowerCase());
        if (idx !== -1) { startPos = Math.max(0, idx - 200); break; }
      }

      // Show up to 2000 chars centered around the match
      const excerpt = display.slice(startPos, startPos + 2000);
      const prefix  = startPos > 0 ? "…" : "";
      const suffix  = startPos + 2000 < display.length ? "…" : "";

      bodyEl.innerHTML = `
        <div class="chat-preview-meta">${source.folder}/ · ${source.filename}</div>
        <div class="chat-preview-text">${prefix}${highlightText(excerpt, queryWords)}${suffix}</div>`;

      // Scroll to first highlight
      requestAnimationFrame(() => {
        const mark = bodyEl.querySelector("mark");
        if (mark) mark.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    } catch (err) {
      bodyEl.innerHTML = `<div style="color:rgba(248,113,113,0.8);font-size:0.8rem;padding:12px;">Could not load file: ${escapeHtml(String(err))}</div>`;
    }
  }

  // ── Source Chips ──────────────────────────────────────────
  // The AI message's parent wrap gets source chips appended after chat:sources fires.
  // We store a reference to the last AI wrap so we can attach chips to it.
  let lastAiWrap = null;
  let pendingQuery = "";

  function appendSourceChips(sources, query) {
    if (!lastAiWrap || !sources || sources.length === 0) return;

    const queryWords = query
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length >= 3);

    const chipsWrap = document.createElement("div");
    chipsWrap.className = "chat-sources";

    const label = document.createElement("div");
    label.className = "chat-sources-label";
    label.textContent = "Sources";
    chipsWrap.appendChild(label);

    const chips = document.createElement("div");
    chips.className = "chat-chips";

    for (const src of sources) {
      const chip = document.createElement("button");
      chip.className = "chat-chip";
      chip.title = `${src.folder}/${src.filename}`;
      // File type icon based on extension
      const ext = src.filename.split(".").pop()?.toLowerCase() || "";
      const icon = ext === "pdf" ? "📄" : ext === "docx" || ext === "doc" ? "📝"
        : ext === "xlsx" || ext === "xls" ? "📊" : ext === "txt" ? "📃" : "📁";
      chip.innerHTML = `${icon} <span>${escapeHtml(src.filename)}</span>`;
      chip.addEventListener("click", () => openFilePreview(src, queryWords));
      chips.appendChild(chip);
    }

    chipsWrap.appendChild(chips);
    lastAiWrap.appendChild(chipsWrap);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // ── Message Rendering ─────────────────────────────────────
  function appendMessage(role, text) {
    const welcome = chatMessages.querySelector(".chat-welcome");
    if (welcome) welcome.remove();

    const wrap = document.createElement("div");
    wrap.className = `chat-msg chat-msg-${role === "user" ? "user" : "ai"}`;

    const label = document.createElement("div");
    label.className = "chat-msg-label";
    label.textContent = role === "user" ? "You" : "AI";

    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    bubble.textContent = text;

    wrap.appendChild(label);
    wrap.appendChild(bubble);
    chatMessages.appendChild(wrap);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    if (role === "ai") lastAiWrap = wrap;
    return bubble;
  }

  function appendTypingIndicator() {
    const welcome = chatMessages.querySelector(".chat-welcome");
    if (welcome) welcome.remove();

    const wrap = document.createElement("div");
    wrap.className = "chat-msg chat-msg-ai";
    wrap.id = "chatTyping";

    const label = document.createElement("div");
    label.className = "chat-msg-label";
    label.textContent = "AI";

    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    bubble.innerHTML = '<span class="chat-typing-dot"></span><span class="chat-typing-dot"></span><span class="chat-typing-dot"></span>';

    wrap.appendChild(label);
    wrap.appendChild(bubble);
    chatMessages.appendChild(wrap);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return wrap;
  }

  // ── Loading bar helper ──────────────────────────────────────
  function appendReadingIndicator() {
    const welcome = chatMessages.querySelector(".chat-welcome");
    if (welcome) welcome.remove();

    const wrap = document.createElement("div");
    wrap.className = "chat-msg chat-msg-ai";
    wrap.id = "chatReadingProgress";

    const label = document.createElement("div");
    label.className = "chat-msg-label";
    label.textContent = "AI";

    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";

    const bar = document.createElement("div");
    bar.className = "chat-reading-bar";
    bar.innerHTML = `
      <div class="chat-reading-label">Reading files...</div>
      <div class="chat-reading-track">
        <div class="chat-reading-fill active" style="width:0%"></div>
      </div>`;

    bubble.appendChild(bar);
    wrap.appendChild(label);
    wrap.appendChild(bubble);
    chatMessages.appendChild(wrap);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return wrap;
  }

  function updateReadingProgress(el, { current, total, filename }) {
    if (!el) return;
    const pct = Math.round((current / total) * 100);
    const fill = el.querySelector(".chat-reading-fill");
    const lbl = el.querySelector(".chat-reading-label");
    if (fill) fill.style.width = pct + "%";
    if (lbl) lbl.textContent = `Reading file ${current}/${total}: ${filename}`;
  }

  // ── Send Message ──────────────────────────────────────────
  async function sendMessage(text) {
    const msg = (text || chatInput.value).trim();
    if (!msg || isStreaming) return;

    chatInput.value = "";
    isStreaming = true;
    chatSendBtn.disabled = true;
    pendingQuery = msg;

    appendMessage("user", msg);
    const readingEl = appendReadingIndicator();
    let typingEl = null;

    // Progress updates while reading full file content
    window.api.on.chatReadingFiles((progress) => {
      updateReadingProgress(readingEl, progress);
    });

    window.api.on.chatToken((token) => {
      // First token arrives → swap loading bar for AI bubble
      if (!currentAiBubble) {
        readingEl.remove();
        if (typingEl) typingEl.remove();
        currentAiBubble = appendMessage("ai", "");
        currentAiBubble.textContent = "";
      }
      currentAiBubble.textContent += token;
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });

    window.api.on.chatDone(() => {
      const finalText = currentAiBubble ? currentAiBubble.textContent : "";
      if (finalText) {
        history.push({ role: "user", content: msg });
        history.push({ role: "assistant", content: finalText });
        if (history.length > 20) history = history.slice(-20);
      }
      if (!currentAiBubble) { readingEl.remove(); if (typingEl) typingEl.remove(); }
      currentAiBubble = null;
      isStreaming = false;
      chatSendBtn.disabled = false;
      chatInput.focus();
    });

    window.api.on.chatSources((sources, query) => {
      appendSourceChips(sources, query || pendingQuery);
    });

    window.api.on.chatError((errMsg) => {
      readingEl.remove();
      if (typingEl) typingEl.remove();
      appendMessage("ai", `⚠️ ${errMsg || "Something went wrong. Is Ollama running?"}`);
      currentAiBubble = null;
      isStreaming = false;
      chatSendBtn.disabled = false;
    });

    try {
      await window.api.chat.send(msg, history);
    } catch (err) {
      readingEl.remove();
      if (typingEl) typingEl.remove();
      appendMessage("ai", `⚠️ ${err.message || "Failed to connect to AI"}`);
      currentAiBubble = null;
      isStreaming = false;
      chatSendBtn.disabled = false;
    }
  }

  chatSendBtn.addEventListener("click", () => sendMessage());
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
})();

// ═══════════════════════════════════════════════════════════════
//  CLOUD CONNECTORS UI  (Google Drive + iCloud)
//  Works in BOTH Personal and Work modes — purely additive.
// ═══════════════════════════════════════════════════════════════

(function cloudConnectorsModule() {
  // DOM refs
  const cloudBar         = $("cloudBar");
  const cloudChips       = $("cloudChips");
  const cloudSettingsBtn = $("cloudSettingsBtn");
  const cloudSyncNowBtn  = $("cloudSyncNowBtn");
  const cloudSyncProgress = $("cloudSyncProgress");
  const cloudSyncFill    = $("cloudSyncFill");
  const cloudOverlay     = $("cloudOverlay");
  const cloudConnectorsList = $("cloudConnectorsList");
  const cloudDetectBtn   = $("cloudDetectBtn");
  const cloudSyncLogBtn  = $("cloudSyncLogBtn");
  const cloudSyncLogPanel = $("cloudSyncLogPanel");
  const cloudCloseBtn    = $("cloudCloseBtn");

  // Early exit if DOM elements missing (safety)
  if (!cloudBar || !cloudOverlay) return;

  let cloudConnectors = [];

  // ── Initialize on load ──────────────────────────────────────
  async function initCloudUI() {
    try {
      cloudConnectors = await window.api.cloud.list();
    } catch {
      cloudConnectors = [];
    }
    renderCloudBar();
  }

  // ── Cloud bar (main page) ───────────────────────────────────
  function renderCloudBar() {
    if (!cloudConnectors || cloudConnectors.length === 0) {
      cloudBar.classList.add("hidden");
      return;
    }

    cloudBar.classList.remove("hidden");
    cloudChips.innerHTML = "";

    for (const c of cloudConnectors) {
      const chip = document.createElement("span");
      chip.className = `cloud-chip ${c.enabled ? "enabled" : "disabled"}`;
      chip.innerHTML = `${providerIcon(c.id)} ${esc(c.label)}`;

      const toggle = document.createElement("span");
      toggle.className = "chip-toggle";
      toggle.textContent = c.enabled ? "✓" : "○";
      toggle.title = c.enabled ? "Click to disable" : "Click to enable";
      toggle.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          if (c.enabled) {
            await window.api.cloud.disable(c.id);
          } else {
            const res = await window.api.cloud.enable(c.id);
            if (!res.ok) {
              showToast(`⚠️ ${res.error}`, 4000);
              return;
            }
          }
          cloudConnectors = await window.api.cloud.list();
          renderCloudBar();
          feedAdd(`Cloud: ${c.label} ${c.enabled ? "disabled" : "enabled"}`);
        } catch (err) {
          showToast(`Cloud error: ${err.message || err}`, 4000);
        }
      });

      chip.appendChild(toggle);
      cloudChips.appendChild(chip);
    }

    const anyEnabled = cloudConnectors.some((c) => c.enabled);
    cloudSyncNowBtn.disabled = !anyEnabled;
  }

  function providerIcon(id) {
    if (id === "icloud") return "☁️";
    if (id === "googledrive") return "📁";
    return "🔗";
  }

  // ── Cloud Settings Modal ────────────────────────────────────
  function renderCloudSettings() {
    cloudConnectorsList.innerHTML = "";

    if (cloudConnectors.length === 0) {
      cloudConnectorsList.innerHTML =
        '<p style="font-size:12px;color:var(--ds-text-dim);text-align:center;padding:20px;">No cloud providers detected. Click "Re-detect Providers" or set a custom path.</p>';
      return;
    }

    for (const c of cloudConnectors) {
      const row = document.createElement("div");
      row.className = "cloud-connector-row";

      const statusClass = c.accessible ? "ok" : "err";
      const statusText = c.accessible
        ? (c.enabled ? "Enabled — syncing organized files" : "Detected — not enabled")
        : "Path not accessible";

      row.innerHTML = `
        <div class="cc-info">
          <div class="cc-name">${providerIcon(c.id)} ${esc(c.label)}</div>
          <div class="cc-path" title="${esc(c.basePath)}">${esc(c.basePath)}/${esc(c.subfolder)}</div>
          <div class="cc-status ${statusClass}">${statusText}</div>
        </div>
        <div class="cc-actions">
          <button class="btn btn-ghost btn-sm cc-path-btn" data-id="${c.id}" title="Set custom path">📂</button>
          <div class="cloud-toggle ${c.enabled ? "on" : ""}" data-id="${c.id}" title="${c.enabled ? "Disable" : "Enable"}"></div>
        </div>
      `;

      // Toggle handler
      const toggleEl = row.querySelector(".cloud-toggle");
      toggleEl.addEventListener("click", async () => {
        try {
          if (c.enabled) {
            await window.api.cloud.disable(c.id);
          } else {
            const res = await window.api.cloud.enable(c.id);
            if (!res.ok) {
              showToast(`⚠️ ${res.error}`, 4000);
              return;
            }
          }
          cloudConnectors = await window.api.cloud.list();
          renderCloudSettings();
          renderCloudBar();
        } catch (err) {
          showToast(`Error: ${err.message || err}`, 3000);
        }
      });

      // Custom path handler
      const pathBtn = row.querySelector(".cc-path-btn");
      pathBtn.addEventListener("click", async () => {
        try {
          const res = await window.api.cloud.setPath(c.id);
          if (res && res.ok) {
            cloudConnectors = await window.api.cloud.list();
            renderCloudSettings();
            renderCloudBar();
            showToast(`Path updated for ${c.label}`, 2000);
          }
        } catch (err) {
          showToast(`Error: ${err.message || err}`, 3000);
        }
      });

      cloudConnectorsList.appendChild(row);
    }
  }

  // ── Sync Now ────────────────────────────────────────────────
  async function doSyncNow() {
    cloudSyncNowBtn.disabled = true;
    cloudSyncNowBtn.textContent = "Syncing...";
    cloudSyncProgress.classList.remove("hidden");
    cloudSyncFill.style.width = "0%";

    try {
      // Listen for progress
      if (window.api.on.cloudSyncProgress) {
        window.api.on.cloudSyncProgress((current, total) => {
          const pct = total > 0 ? Math.round((current / total) * 100) : 0;
          cloudSyncFill.style.width = `${pct}%`;
        });
      }

      const result = await window.api.cloud.syncNow();
      if (result.ok) {
        showToast(`☁️ Synced ${result.synced} files (${result.failed} failed)`, 4000);
        feedAdd(`Cloud sync complete: ${result.synced} synced, ${result.failed} failed`);
      } else {
        showToast(`⚠️ ${result.error}`, 4000);
      }
    } catch (err) {
      showToast(`Sync error: ${err.message || err}`, 4000);
    }

    cloudSyncNowBtn.textContent = "Sync Now";
    cloudSyncNowBtn.disabled = false;
    setTimeout(() => {
      cloudSyncProgress.classList.add("hidden");
      cloudSyncFill.style.width = "0%";
    }, 2000);
  }

  // ── Sync Log ────────────────────────────────────────────────
  async function showSyncLog() {
    const isVisible = !cloudSyncLogPanel.classList.contains("hidden");
    if (isVisible) {
      cloudSyncLogPanel.classList.add("hidden");
      return;
    }

    try {
      const log = await window.api.cloud.syncLog();
      if (!log || log.length === 0) {
        cloudSyncLogPanel.innerHTML = '<em style="color:var(--ds-text-dim)">No sync activity yet.</em>';
      } else {
        const recent = log.slice(-50).reverse();
        cloudSyncLogPanel.innerHTML = recent.map((entry) => {
          const icon = entry.success ? "✓" : "✗";
          const color = entry.success ? "var(--ds-emerald)" : "var(--ds-red)";
          const filename = entry.sourcePath ? entry.sourcePath.split("/").pop() : "unknown";
          return `<div style="margin-bottom:4px;"><span style="color:${color}">${icon}</span> ${esc(filename)} → ${esc(entry.label)}${entry.error ? ` <span style="color:var(--ds-red)">(${esc(entry.error)})</span>` : ""}</div>`;
        }).join("");
      }
    } catch {
      cloudSyncLogPanel.innerHTML = '<em style="color:var(--ds-red)">Failed to load sync log.</em>';
    }

    cloudSyncLogPanel.classList.remove("hidden");
  }

  // ── Event Listeners ─────────────────────────────────────────
  cloudSettingsBtn.addEventListener("click", () => {
    renderCloudSettings();
    cloudOverlay.classList.remove("hidden");
  });

  cloudCloseBtn.addEventListener("click", () => {
    cloudOverlay.classList.add("hidden");
    cloudSyncLogPanel.classList.add("hidden");
  });

  cloudOverlay.addEventListener("click", (e) => {
    if (e.target === cloudOverlay) {
      cloudOverlay.classList.add("hidden");
      cloudSyncLogPanel.classList.add("hidden");
    }
  });

  cloudSyncNowBtn.addEventListener("click", doSyncNow);

  cloudDetectBtn.addEventListener("click", async () => {
    try {
      cloudConnectors = await window.api.cloud.detect();
      renderCloudSettings();
      renderCloudBar();
      showToast(`Found ${cloudConnectors.length} cloud provider(s)`, 2000);
    } catch (err) {
      showToast(`Detection error: ${err.message || err}`, 3000);
    }
  });

  cloudSyncLogBtn.addEventListener("click", showSyncLog);

  // ── Initialize on page load ─────────────────────────────────
  // Delay slightly to let main bootstrap finish first
  setTimeout(initCloudUI, 500);
})();

// ═══════════════════════════════════════════════════════════════
//  DRAG & DROP — HTML5 file drop support
// ═══════════════════════════════════════════════════════════════

(function dragDropModule() {
  const dropOverlay = $("dropOverlay");
  if (!dropOverlay) return;

  let dragCounter = 0;

  // Prevent default browser behavior for all drag events
  document.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
  document.addEventListener("dragenter", (e) => { e.preventDefault(); e.stopPropagation(); });
  document.addEventListener("dragleave", (e) => { e.preventDefault(); e.stopPropagation(); });
  document.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); });

  // Show overlay when files are dragged over the window
  document.addEventListener("dragenter", (e) => {
    dragCounter++;
    if (e.dataTransfer && e.dataTransfer.types.includes("Files")) {
      dropOverlay.classList.add("active");
    }
  });

  document.addEventListener("dragleave", () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropOverlay.classList.remove("active");
    }
  });

  // Handle the drop
  document.addEventListener("drop", async (e) => {
    dragCounter = 0;
    dropOverlay.classList.remove("active");

    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;

    // Collect file paths from the dropped items
    const filePaths = [];
    for (const file of e.dataTransfer.files) {
      if (file.path) {
        filePaths.push(file.path);
      }
    }

    if (filePaths.length === 0) return;

    // Use the same addFiles + classifyPending flow as "Select Files"
    if (typeof addFiles === "function" && typeof classifyPending === "function") {
      addFiles(filePaths);
      feedAdd(`Dropped ${filePaths.length} file(s).`);
      await classifyPending();
    }
  });
})();

// ═══════════════════════════════════════════════════════════════
//  ONBOARDING WIZARD — First-run experience
// ═══════════════════════════════════════════════════════════════

(function onboardingModule() {
  const overlay = $("onboardingOverlay");
  const card = $("onboardingCard");
  if (!overlay || !card) return;

  const ONBOARDING_KEY = "ai_organizer_onboarded";
  let currentStep = 0;

  const steps = [
    {
      icon: "🗂️",
      title: "Welcome to AI Organizer",
      subtitle: "Your intelligent file organization assistant. Let's get you set up in under a minute.",
      content: `
        <div class="onboarding-steps">
          <div class="onboarding-step">
            <div class="onboarding-step-num">1</div>
            <div class="onboarding-step-text"><strong>Select files</strong> using the button, drag & drop, or Cmd+O</div>
          </div>
          <div class="onboarding-step">
            <div class="onboarding-step-num">2</div>
            <div class="onboarding-step-text">The AI <strong>classifies each file</strong> into the best folder</div>
          </div>
          <div class="onboarding-step">
            <div class="onboarding-step-num">3</div>
            <div class="onboarding-step-text"><strong>Review & confirm</strong> — nothing moves until you approve</div>
          </div>
        </div>
      `,
      buttons: [
        { label: "Skip", class: "btn btn-ghost btn-sm", action: "close" },
        { label: "Next", class: "btn btn-primary btn-sm", action: "next" },
      ],
    },
    {
      icon: "🏠",
      title: "Two Modes",
      subtitle: "Switch between Personal and Work mode based on your needs.",
      content: `
        <div class="onboarding-steps">
          <div class="onboarding-step">
            <div class="onboarding-step-num" style="background:linear-gradient(135deg,var(--ds-blue),#6366f1);">P</div>
            <div class="onboarding-step-text"><strong>Personal Mode</strong> — Organizes to ~/Desktop/AI_SORTED_FILES. Great for homework, personal docs, media files.</div>
          </div>
          <div class="onboarding-step">
            <div class="onboarding-step-num" style="background:linear-gradient(135deg,#7c3aed,#6d28d9);">W</div>
            <div class="onboarding-step-text"><strong>Work Mode</strong> — Cloud-synced with compliance tracking, PII detection, retention policies, and auto-organize via folder watching.</div>
          </div>
        </div>
      `,
      buttons: [
        { label: "Back", class: "btn btn-ghost btn-sm", action: "back" },
        { label: "Next", class: "btn btn-primary btn-sm", action: "next" },
      ],
    },
    {
      icon: "💡",
      title: "Pro Tips",
      subtitle: "Get the most out of AI Organizer with these features.",
      content: `
        <div class="onboarding-steps">
          <div class="onboarding-step">
            <div class="onboarding-step-num">⌨</div>
            <div class="onboarding-step-text"><strong>Keyboard shortcuts</strong> — Cmd+O to open, Cmd+Z to undo, Cmd+F to search. Check Help menu for full list.</div>
          </div>
          <div class="onboarding-step">
            <div class="onboarding-step-num">🧠</div>
            <div class="onboarding-step-text"><strong>The AI learns</strong> — When you correct a classification, it remembers for next time. The more you use it, the smarter it gets.</div>
          </div>
          <div class="onboarding-step">
            <div class="onboarding-step-num">💬</div>
            <div class="onboarding-step-text"><strong>Ask AI</strong> — Use the chat to find files by content, ask questions about your organized files, or teach the AI new keywords.</div>
          </div>
          <div class="onboarding-step">
            <div class="onboarding-step-num">☁️</div>
            <div class="onboarding-step-text"><strong>Cloud Sync</strong> — Connect Google Drive or iCloud to automatically back up organized files to the cloud.</div>
          </div>
        </div>
      `,
      buttons: [
        { label: "Back", class: "btn btn-ghost btn-sm", action: "back" },
        { label: "Get Started!", class: "btn btn-success btn-sm", action: "close" },
      ],
    },
  ];

  function renderStep(stepIndex) {
    const step = steps[stepIndex];
    card.innerHTML = `
      <div class="onboarding-icon">${step.icon}</div>
      <div class="onboarding-title">${step.title}</div>
      <div class="onboarding-subtitle">${step.subtitle}</div>
      <div class="onboarding-dots">
        ${steps.map((_, i) => `<div class="onboarding-dot ${i === stepIndex ? "active" : ""}"></div>`).join("")}
      </div>
      ${step.content}
      <div class="onboarding-actions">
        ${step.buttons.map((b) => `<button class="${b.class}" data-action="${b.action}">${b.label}</button>`).join("")}
      </div>
    `;

    // Wire buttons
    card.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        if (action === "next") {
          currentStep = Math.min(currentStep + 1, steps.length - 1);
          renderStep(currentStep);
        } else if (action === "back") {
          currentStep = Math.max(currentStep - 1, 0);
          renderStep(currentStep);
        } else if (action === "close") {
          closeOnboarding();
        }
      });
    });
  }

  function closeOnboarding() {
    overlay.classList.add("hidden");
    try { localStorage.setItem(ONBOARDING_KEY, "true"); } catch {}
  }

  // Show onboarding on first run
  function checkFirstRun() {
    try {
      if (!localStorage.getItem(ONBOARDING_KEY)) {
        showOnboarding();
      }
    } catch {
      // localStorage unavailable — skip
    }
  }

  function showOnboarding() {
    currentStep = 0;
    renderStep(0);
    overlay.classList.remove("hidden");
  }

  // Expose globally so Help menu can trigger it
  window._showOnboarding = showOnboarding;

  // Check on load (delayed to let main bootstrap finish)
  setTimeout(checkFirstRun, 800);
})();

// ═══════════════════════════════════════════════════════════════
//  MENU BAR ACTIONS — Handle keyboard shortcuts & menu clicks
// ═══════════════════════════════════════════════════════════════

(function menuActionsModule() {
  if (!window.api || !window.api.on || !window.api.on.menuAction) return;

  window.api.on.menuAction((action) => {
    switch (action) {
      case "open-files":
        if (typeof selectFiles === "function") selectFiles();
        break;
      case "open-folder":
        if (typeof selectFolder === "function") selectFolder();
        break;
      case "new-category":
        if (typeof openNewCategoryDialog === "function") openNewCategoryDialog();
        break;
      case "undo":
        if (typeof doUndo === "function") doUndo();
        break;
      case "redo":
        if (typeof doRedo === "function") doRedo();
        break;
      case "open-settings":
        if (typeof openSettings === "function") openSettings();
        break;
      case "focus-search": {
        const searchInput = $("deepSearchInput");
        if (searchInput) searchInput.focus();
        break;
      }
      case "mode-personal":
        if (typeof switchMode === "function") switchMode("personal");
        break;
      case "mode-work":
        if (typeof switchMode === "function") switchMode("work");
        break;
      case "open-chat": {
        const chatBtn = $("chatBtn");
        if (chatBtn) chatBtn.click();
        break;
      }
      case "open-dashboard": {
        const adminFooter = $("adminFooter");
        if (adminFooter) adminFooter.click();
        break;
      }
      case "cloud-sync": {
        const syncBtn = $("cloudSyncNowBtn");
        if (syncBtn) syncBtn.click();
        break;
      }
      case "show-onboarding":
        if (window._showOnboarding) window._showOnboarding();
        break;
      case "show-shortcuts": {
        const shortcutsOverlay = $("shortcutsOverlay");
        if (shortcutsOverlay) shortcutsOverlay.classList.remove("hidden");
        break;
      }
      case "show-privacy": {
        const privacyOverlay = $("privacyOverlay");
        if (privacyOverlay) privacyOverlay.classList.remove("hidden");
        break;
      }
      case "show-terms": {
        const termsOverlay = $("termsOverlay");
        if (termsOverlay) termsOverlay.classList.remove("hidden");
        break;
      }
    }
  });

  // ── Close buttons for new modals ──
  const shortcutsClose = $("shortcutsCloseBtn");
  const privacyClose = $("privacyCloseBtn");
  const termsClose = $("termsCloseBtn");
  const shortcutsOverlay = $("shortcutsOverlay");
  const privacyOverlay = $("privacyOverlay");
  const termsOverlay = $("termsOverlay");

  if (shortcutsClose) shortcutsClose.addEventListener("click", () => shortcutsOverlay.classList.add("hidden"));
  if (privacyClose) privacyClose.addEventListener("click", () => privacyOverlay.classList.add("hidden"));
  if (termsClose) termsClose.addEventListener("click", () => termsOverlay.classList.add("hidden"));

  // Close on overlay click
  [shortcutsOverlay, privacyOverlay, termsOverlay].forEach((ov) => {
    if (ov) ov.addEventListener("click", (e) => {
      if (e.target === ov) ov.classList.add("hidden");
    });
  });
})();

// ═══════════════════════════════════════════════════════════════
//  ERROR RECOVERY UX — Ollama failure dialog with troubleshooting
// ═══════════════════════════════════════════════════════════════

(function errorRecoveryModule() {
  const overlay = $("errorRecoveryOverlay");
  const msgEl = $("errorRecoveryMsg");
  const retryBtn = $("errorRecoveryRetryBtn");
  const dismissBtn = $("errorRecoveryDismissBtn");
  if (!overlay || !msgEl) return;

  function showErrorDialog(errorMessage) {
    msgEl.textContent = errorMessage || "Unknown error";
    overlay.classList.remove("hidden");
  }

  function hideErrorDialog() {
    overlay.classList.add("hidden");
  }

  // Listen for Ollama errors from main process
  if (window.api && window.api.on && window.api.on.ollamaError) {
    window.api.on.ollamaError((msg) => {
      showErrorDialog(msg);
    });
  }

  if (retryBtn) {
    retryBtn.addEventListener("click", async () => {
      hideErrorDialog();
      showToast("Retrying AI engine…");
      feedAdd("Retrying Ollama…");
      setStatus(false, "Retrying…");
      retryBtn.disabled = true;
      try {
        const result = await window.api.ollama.retry();
        if (result.success) {
          setStatus(true, `AI ready (${result.model})`);
          showToast(`AI engine ready — using ${result.model}`);
          feedAdd(`Ollama loaded: ${result.model} (${result.tier} tier)`);
        } else if (result.rulesOnly) {
          setStatus(false, "Low RAM — rules only");
          // low-ram banner will appear via IPC event
        } else {
          setStatus(false, "AI unavailable");
          showErrorDialog(result.error || "Could not start AI engine");
        }
      } catch (err) {
        setStatus(false, "AI unavailable");
        showErrorDialog(err.message);
      } finally {
        retryBtn.disabled = false;
      }
    });
  }

  if (dismissBtn) {
    dismissBtn.addEventListener("click", () => {
      hideErrorDialog();
      showToast("Continuing without AI — file classification unavailable.");
      feedAdd("AI engine dismissed. Manual organization only.", true);
      setStatus(false, "No AI");
    });
  }

  // Close on overlay click
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) hideErrorDialog();
  });
})();

// ═══════════════════════════════════════════════════════════════
//  CONFIGURABLE DESTINATION — let users choose where files go
// ═══════════════════════════════════════════════════════════════

(function configurableDestModule() {
  const destBanner = $("destBanner");
  const destBannerText = $("destBannerText");
  if (!destBanner || !destBannerText) return;

  // Add a "Change" button to the destination banner
  const changeBtn = document.createElement("button");
  changeBtn.className = "btn btn-ghost btn-sm";
  changeBtn.textContent = "Change";
  changeBtn.setAttribute("aria-label", "Change destination folder");
  changeBtn.style.cssText = "margin-left:8px;font-size:10px;padding:4px 10px;";
  destBanner.appendChild(changeBtn);

  // Add a "Reset" button (hidden by default)
  const resetBtn = document.createElement("button");
  resetBtn.className = "btn btn-ghost btn-sm";
  resetBtn.textContent = "Reset";
  resetBtn.setAttribute("aria-label", "Reset destination to default");
  resetBtn.style.cssText = "margin-left:4px;font-size:10px;padding:4px 10px;display:none;";
  destBanner.appendChild(resetBtn);

  changeBtn.addEventListener("click", async () => {
    if (!window.api || !window.api.setDestDir) return;
    try {
      const result = await window.api.setDestDir(currentMode);
      if (result && result.ok) {
        DEST_DIR = result.dir;
        // Shorten path for display
        const home = "~";
        const displayPath = result.dir.replace(/^\/Users\/[^/]+/, home)
          .replace(/^C:\\Users\\[^\\]+/, home);
        destBannerText.innerHTML = `Sorting to: <strong>${esc(displayPath)}</strong>`;
        knownFolders = Array.isArray(result.folders) ? result.folders : [];
        statFolders.textContent = knownFolders.length;
        resetBtn.style.display = "inline-block";
        showToast("Destination folder updated.");
        feedAdd(`Destination changed to: ${result.dir}`);
        render();
      }
    } catch (err) {
      showToast("Failed to change destination.");
    }
  });

  resetBtn.addEventListener("click", async () => {
    if (!window.api || !window.api.resetDestDir) return;
    try {
      const result = await window.api.resetDestDir(currentMode);
      if (result && result.ok) {
        DEST_DIR = result.dir;
        const displayPath = result.dir.replace(/^\/Users\/[^/]+/, "~")
          .replace(/^C:\\Users\\[^\\]+/, "~");
        destBannerText.innerHTML = `Sorting to: <strong>${esc(displayPath)}</strong>`;
        knownFolders = Array.isArray(result.folders) ? result.folders : [];
        statFolders.textContent = knownFolders.length;
        resetBtn.style.display = "none";
        showToast("Destination reset to default.");
        feedAdd(`Destination reset to: ${result.dir}`);
        render();
      }
    } catch (err) {
      showToast("Failed to reset destination.");
    }
  });
})();

// ═══════════════════════════════════════════════════════════════
//  GOOGLE DRIVE BROWSER — Full two-way Drive integration UI
// ═══════════════════════════════════════════════════════════════

(function googleDriveModule() {
  const panel = $("gdrivePanel");
  const openBtn = $("gdriveBtn");
  const closeBtn = $("gdriveCloseBtn");
  const content = $("gdriveContent");
  const breadcrumb = $("gdriveBreadcrumb");
  const searchInput = $("gdriveSearchInput");
  const organizeAllBtn = $("gdriveOrganizeAllBtn");
  const refreshBtn = $("gdriveRefreshBtn");
  const logoutBtn = $("gdriveLogoutBtn");
  const footerStatus = $("gdriveFooterStatus");
  const subtitle = $("gdriveSubtitle");

  if (!panel || !content) return;
  if (!window.api || !window.api.gdrive) return;

  const gdrive = window.api.gdrive;

  let currentFolderId = "root";
  let folderStack = [{ id: "root", name: "My Drive" }];
  let currentFiles = [];
  let selectedFiles = new Set();
  let isSearching = false;

  // ── Open / Close ──────────────────────────────────────────
  if (openBtn) {
    openBtn.addEventListener("click", async () => {
      panel.classList.remove("hidden");
      await checkAuthAndRender();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      panel.classList.add("hidden");
    });
  }

  // ── Auth Check ────────────────────────────────────────────
  async function checkAuthAndRender() {
    try {
      const status = await gdrive.authStatus();
      if (!status.isAuthenticated) {
        renderLoginPrompt();
      } else {
        footerStatus.textContent = "Connected to Google Drive";
        footerStatus.className = "gdrive-status-msg";
        await loadFolder(currentFolderId);
      }
    } catch (err) {
      renderError(err.message || String(err));
    }
  }

  // ── Login Prompt ──────────────────────────────────────────
  function renderLoginPrompt() {
    subtitle.textContent = "Connect your account";
    content.innerHTML = `
      <div class="gdrive-auth-card">
        <div class="gdrive-auth-icon">
          <svg width="40" height="40" viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg">
            <path d="M6.6 66.85L29.7 78l22.8-39.5-22.8-39.5L6.6 10.85 29.4 39z" fill="#0066DA"/>
            <path d="M57.6 78L80.7 66.85 57.9 27.35H10.9L0 47.25z" fill="#00AC47"/>
            <path d="M29.7 0l22.8 39.5H87.3L64.5 0z" fill="#EA4335"/>
            <path d="M29.7 0L6.6 10.85l22.8 28.15L52.5 39.5z" fill="#00832D"/>
            <path d="M52.5 39.5L80.7 66.85l6.6-19.6L57.6 0z" fill="#2684FC"/>
            <path d="M80.7 66.85L57.6 78l-5.1-38.5z" fill="#FFBA00"/>
          </svg>
        </div>
        <div class="gdrive-auth-title">Google Drive</div>
        <div class="gdrive-auth-desc">
          Browse, organize, and classify your Google Drive files<br>
          using AI — all from right here.
        </div>
        <div class="gdrive-auth-actions" style="margin-top:16px;">
          <button class="btn btn-ghost btn-sm" id="gdriveLoginCancelBtn">Cancel</button>
          <button class="btn btn-primary btn-sm" id="gdriveLoginBtn"
            style="display:inline-flex;align-items:center;gap:6px;padding:7px 18px;">
            <svg width="16" height="16" viewBox="0 0 48 48" style="flex-shrink:0;">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            </svg>
            Sign in with Google
          </button>
        </div>
      </div>
    `;

    $("gdriveLoginCancelBtn").addEventListener("click", () => panel.classList.add("hidden"));
    $("gdriveLoginBtn").addEventListener("click", () => startLogin());
  }

  async function startLogin() {
    content.innerHTML = `
      <div class="gdrive-auth-card">
        <div class="gdrive-auth-icon"><span class="spinner" style="width:24px;height:24px;"></span></div>
        <div class="gdrive-auth-title">Waiting for Google...</div>
        <div class="gdrive-auth-desc">
          A browser window should have opened. Complete the sign-in there.<br>
          This will connect automatically when done.
        </div>
      </div>
    `;

    try {
      const result = await gdrive.login();
      if (result.ok) {
        showToast("Connected to Google Drive!");
        footerStatus.textContent = "Connected to Google Drive";
        footerStatus.className = "gdrive-status-msg";
        await loadFolder("root");
      } else {
        renderError(result.error || "Login failed");
      }
    } catch (err) {
      renderError(err.message || String(err));
    }
  }

  // ── File Listing ──────────────────────────────────────────
  async function loadFolder(folderId) {
    currentFolderId = folderId;
    selectedFiles.clear();
    isSearching = false;
    updateOrganizeBtn();

    content.innerHTML = `
      <div style="text-align:center;padding:40px;color:rgba(255,255,255,0.4);font-size:13px;">
        <span class="spinner"></span> Loading files...
      </div>
    `;

    try {
      const files = await gdrive.listFiles(folderId, 200);
      currentFiles = files;
      subtitle.textContent = `${files.length} items`;
      renderFileList(files);
      renderBreadcrumb();
    } catch (err) {
      renderError(err.message || String(err));
    }
  }

  function renderFileList(files) {
    if (files.length === 0) {
      content.innerHTML = `
        <div style="text-align:center;padding:48px;color:rgba(255,255,255,0.35);font-size:13px;">
          This folder is empty.
        </div>
      `;
      return;
    }

    const isFolder = (f) => f.mimeType === "application/vnd.google-apps.folder";
    const isGDoc = (f) => f.mimeType && f.mimeType.startsWith("application/vnd.google-apps.");

    // Sort: folders first, then files by name
    const sorted = [...files].sort((a, b) => {
      if (isFolder(a) && !isFolder(b)) return -1;
      if (!isFolder(a) && isFolder(b)) return 1;
      return (a.name || "").localeCompare(b.name || "");
    });

    let html = `
      <div class="gdrive-col-header">
        <span></span>
        <span>Name</span>
        <span>Size</span>
        <span>Modified</span>
        <span>Action</span>
      </div>
      <div class="gdrive-file-list">
    `;

    for (const file of sorted) {
      const folder = isFolder(file);
      const gDoc = isGDoc(file);
      const icon = folder ? "📁" : getFileIcon(file.name, file.mimeType);
      const size = file.size ? formatBytes(parseInt(file.size)) : (gDoc ? "Google Doc" : "—");
      const date = file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString() : "—";
      const sel = selectedFiles.has(file.id) ? " selected" : "";

      const actionHtml = folder
        ? ""
        : gDoc
          ? `<span style="font-size:0.65rem;color:rgba(255,255,255,0.25);">G-Doc</span>`
          : `<button class="gdrive-organize-btn" data-organize-id="${esc(file.id)}"
              data-organize-name="${esc(file.name)}"
              data-organize-parent="${esc((file.parents && file.parents[0]) || "root")}"
              aria-label="Organize ${esc(file.name)} with AI">
              Organize
            </button>`;

      html += `
        <div class="gdrive-file-row${sel}"
          data-file-id="${esc(file.id)}"
          data-is-folder="${folder}"
          data-parent="${esc((file.parents && file.parents[0]) || "root")}">
          <span class="gdrive-file-icon">${icon}</span>
          <span class="gdrive-file-name${folder ? " folder" : ""}">${esc(file.name)}</span>
          <span class="gdrive-file-size">${size}</span>
          <span class="gdrive-file-date">${date}</span>
          <span class="gdrive-file-action">${actionHtml}</span>
        </div>
      `;
    }

    html += "</div>";
    content.innerHTML = html;

    // Wire events
    content.querySelectorAll(".gdrive-file-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        // Don't navigate if clicking organize button
        if (e.target.closest(".gdrive-organize-btn")) return;

        const fileId = row.dataset.fileId;
        const isFolder = row.dataset.isFolder === "true";

        if (isFolder) {
          // Navigate into folder
          const name = row.querySelector(".gdrive-file-name").textContent;
          folderStack.push({ id: fileId, name });
          loadFolder(fileId);
        } else {
          // Toggle selection
          if (selectedFiles.has(fileId)) {
            selectedFiles.delete(fileId);
            row.classList.remove("selected");
          } else {
            selectedFiles.add(fileId);
            row.classList.add("selected");
          }
          updateOrganizeBtn();
        }
      });
    });

    content.querySelectorAll(".gdrive-organize-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const fileId = btn.dataset.organizeId;
        const fileName = btn.dataset.organizeName;
        const parentId = btn.dataset.organizeParent;
        await classifyAndOrganizeSingle(fileId, fileName, parentId, btn);
      });
    });
  }

  // ── Breadcrumb Navigation ─────────────────────────────────
  function renderBreadcrumb() {
    breadcrumb.innerHTML = "";
    folderStack.forEach((item, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "gdrive-breadcrumb-sep";
        sep.textContent = " › ";
        breadcrumb.appendChild(sep);
      }
      const crumb = document.createElement("span");
      crumb.className = "gdrive-breadcrumb-item";
      crumb.textContent = item.name;
      crumb.dataset.id = item.id;
      crumb.addEventListener("click", () => {
        // Navigate back to this level
        folderStack = folderStack.slice(0, i + 1);
        loadFolder(item.id);
      });
      breadcrumb.appendChild(crumb);
    });
  }

  // ── Classify & Organize ───────────────────────────────────
  async function classifyAndOrganizeSingle(fileId, fileName, parentId, btn) {
    const origText = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:10px;height:10px;border-width:1.5px;"></span> AI...';

    try {
      const result = await gdrive.classifyAndOrganize(fileId, fileName, parentId);

      if (result.organized) {
        btn.textContent = "✓ " + result.category;
        btn.style.borderColor = "rgba(52,211,153,0.5)";
        btn.style.color = "#34d399";
        showToast(`Organized: ${fileName} → ${result.category}/`);
        feedAdd(`[Drive] ${fileName} → ${result.category}/ (${result.confidence}%)`);
      } else {
        btn.textContent = result.category || "Review";
        btn.style.borderColor = "rgba(251,146,60,0.5)";
        btn.style.color = "#fb923c";
        showToast(`${fileName}: ${result.category || "Needs Review"} (${result.confidence}%)`);
      }
    } catch (err) {
      btn.textContent = "Error";
      btn.style.borderColor = "rgba(248,113,113,0.5)";
      btn.style.color = "#f87171";
      showToast(`Failed: ${err.message || err}`);
    }
  }

  // ── Organize All Selected ─────────────────────────────────
  if (organizeAllBtn) {
    organizeAllBtn.addEventListener("click", async () => {
      if (selectedFiles.size === 0) {
        showToast("Select files to organize first.");
        return;
      }

      organizeAllBtn.disabled = true;
      organizeAllBtn.textContent = `Organizing ${selectedFiles.size}...`;
      let success = 0;
      let failed = 0;

      for (const fileId of selectedFiles) {
        const file = currentFiles.find((f) => f.id === fileId);
        if (!file) continue;

        const parentId = (file.parents && file.parents[0]) || "root";
        try {
          const result = await gdrive.classifyAndOrganize(fileId, file.name, parentId);
          if (result.organized) {
            success++;
            feedAdd(`[Drive] ${file.name} → ${result.category}/ (${result.confidence}%)`);
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }

      selectedFiles.clear();
      organizeAllBtn.disabled = false;
      organizeAllBtn.textContent = "Organize Selected";
      showToast(`Drive: ${success} organized, ${failed} need review.`);

      // Refresh current folder
      await loadFolder(currentFolderId);
    });
  }

  function updateOrganizeBtn() {
    if (organizeAllBtn) {
      organizeAllBtn.textContent = selectedFiles.size > 0
        ? `Organize Selected (${selectedFiles.size})`
        : "Organize Selected";
    }
  }

  // ── Search ────────────────────────────────────────────────
  let searchTimer = null;
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const q = searchInput.value.trim();
      if (!q) {
        if (isSearching) loadFolder(currentFolderId);
        return;
      }
      searchTimer = setTimeout(async () => {
        isSearching = true;
        subtitle.textContent = `Searching: "${q}"`;
        content.innerHTML = `
          <div style="text-align:center;padding:40px;color:rgba(255,255,255,0.4);font-size:13px;">
            <span class="spinner"></span> Searching...
          </div>
        `;
        try {
          const files = await gdrive.search(q);
          currentFiles = files;
          subtitle.textContent = `${files.length} results for "${q}"`;
          renderFileList(files);
        } catch (err) {
          renderError(err.message);
        }
      }, 500);
    });

    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        searchInput.value = "";
        if (isSearching) loadFolder(currentFolderId);
      }
    });
  }

  // ── Refresh & Logout ──────────────────────────────────────
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => loadFolder(currentFolderId));
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await gdrive.logout();
        showToast("Signed out of Google Drive.");
        footerStatus.textContent = "Not connected";
        footerStatus.className = "";
        renderLoginPrompt();
      } catch {}
    });
  }

  // ── Helpers ───────────────────────────────────────────────
  function renderError(msg) {
    content.innerHTML = `
      <div class="gdrive-auth-card">
        <div class="gdrive-auth-icon">⚠️</div>
        <div class="gdrive-auth-title" style="color:var(--ds-red);">Error</div>
        <div class="gdrive-auth-desc">${esc(msg)}</div>
        <div class="gdrive-auth-actions">
          <button class="btn btn-primary btn-sm" id="gdriveRetryBtn">Retry</button>
        </div>
      </div>
    `;
    $("gdriveRetryBtn")?.addEventListener("click", () => checkAuthAndRender());
  }

  function getFileIcon(name, mimeType) {
    if (!name) return "📄";
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    const map = {
      pdf: "📕", doc: "📘", docx: "📘", xls: "📊", xlsx: "📊",
      ppt: "📙", pptx: "📙", txt: "📝", csv: "📊", json: "📋",
      jpg: "🖼️", jpeg: "🖼️", png: "🖼️", gif: "🖼️", svg: "🖼️", webp: "🖼️",
      mp4: "🎬", mov: "🎬", avi: "🎬", mkv: "🎬",
      mp3: "🎵", wav: "🎵", flac: "🎵",
      zip: "📦", rar: "📦", "7z": "📦", tar: "📦", gz: "📦",
      js: "💻", ts: "💻", py: "💻", java: "💻", cpp: "💻", c: "💻", rb: "💻",
      html: "🌐", css: "🎨", xml: "📋", md: "📝",
    };
    return map[ext] || "📄";
  }

  function formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  }

  // Wire menu action for Drive
  if (window.api && window.api.on && window.api.on.menuAction) {
    // Add Drive to existing menu handler
    const origHandler = window.api.on.menuAction;
    // The menu action "open-drive" can be added to appMenu.js later
  }
})();

// ═══════════════════════════════════════════════════════════════
//  LOW-RAM WARNING BANNER
// ═══════════════════════════════════════════════════════════════
(function ramWarningModule() {
  if (!window.api) return;

  const banner    = document.getElementById("ramWarningBanner");
  const bannerTxt = document.getElementById("ramBannerText");
  const retryBtn  = document.getElementById("ramBannerRetryBtn");
  const closeBtn  = document.getElementById("ramBannerDismissBtn");
  if (!banner) return;

  function showRamBanner(freeMB, totalMB) {
    if (bannerTxt) {
      bannerTxt.textContent =
        `AI features are paused — only ${freeMB} MB of RAM free ` +
        `(${totalMB} MB total). Close other apps and click Retry AI.`;
    }
    banner.classList.remove("hidden");
  }

  function hideRamBanner() {
    banner.classList.add("hidden");
  }

  // Listen for low-RAM event from main process
  if (window.api.on && window.api.on.ollamaLowRam) {
    window.api.on.ollamaLowRam(({ freeMB, totalMB }) => {
      showRamBanner(freeMB, totalMB);
      if (typeof setStatus === "function") setStatus(false, "Low RAM — rules only");
      if (typeof feedAdd === "function")
        feedAdd(`AI paused: only ${freeMB} MB free RAM. Rules-based classification active.`, true);
    });
  }

  // Listen for successful model load (e.g. after retry)
  if (window.api.on && window.api.on.ollamaModelReady) {
    window.api.on.ollamaModelReady(({ model, tier }) => {
      hideRamBanner();
      if (typeof setStatus === "function") setStatus(true, `AI ready (${model})`);
      if (typeof showToast === "function") showToast(`AI engine ready — using ${model}`);
      if (typeof feedAdd === "function")
        feedAdd(`Ollama loaded: ${model} (${tier} tier)`);
    });
  }

  // Retry button
  if (retryBtn) {
    retryBtn.addEventListener("click", async () => {
      retryBtn.disabled = true;
      retryBtn.textContent = "Retrying…";
      try {
        const result = await window.api.ollama.retry();
        if (result.success) {
          hideRamBanner();
          // ollamaModelReady IPC will update status
        } else if (result.rulesOnly) {
          // Still not enough RAM — update banner message
          const res = await window.api.ollama.status();
          showRamBanner("?", "?"); // message updated by IPC event
          retryBtn.textContent = "Retry AI";
          retryBtn.disabled = false;
        } else {
          retryBtn.textContent = "Retry AI";
          retryBtn.disabled = false;
          if (typeof showToast === "function")
            showToast(`Could not start AI: ${result.error || "unknown error"}`);
        }
      } catch (err) {
        retryBtn.textContent = "Retry AI";
        retryBtn.disabled = false;
        if (typeof showToast === "function") showToast(`Retry failed: ${err.message}`);
      }
    });
  }

  // Dismiss button
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      hideRamBanner();
      if (typeof showToast === "function")
        showToast("AI paused. File organizing continues with rules-based matching.");
    });
  }
})();

// ═══════════════════════════════════════════════════════════════
//  SYSTEM REQUIREMENTS CHECK (first launch only)
// ═══════════════════════════════════════════════════════════════
(function sysCheckModule() {
  if (!window.api || !window.api.system) return;

  const overlay   = document.getElementById("sysCheckOverlay");
  const list      = document.getElementById("sysCheckList");
  const closeBtn  = document.getElementById("sysCheckCloseBtn");
  if (!overlay || !list) return;

  function makeRow(icon, label, detail) {
    const row = document.createElement("div");
    row.className = "sys-check-row";
    row.innerHTML =
      `<div class="sys-check-icon">${icon}</div>` +
      `<div><div class="sys-check-label">${label}</div>` +
      `<div class="sys-check-detail">${detail}</div></div>`;
    return row;
  }

  async function runChecks() {
    list.innerHTML = "";

    let checks;
    try {
      checks = await window.api.system.check();
    } catch (e) {
      list.appendChild(makeRow("⚠️", "Could not run checks", e.message));
      return;
    }

    const { totalRamGB, freeRamGB, diskFreeGB, ollamaInstalled } = checks;

    // RAM check
    const ramOk = totalRamGB >= 8;
    list.appendChild(makeRow(
      ramOk ? "✅" : "⚠️",
      `System RAM: ${totalRamGB} GB`,
      ramOk
        ? `You have plenty of RAM. AI features will work at full quality.`
        : `Less than 8 GB total RAM detected. AI will use a lighter model — everything still works.`
    ));

    // Disk check
    const diskOk = diskFreeGB === null || diskFreeGB >= 10;
    list.appendChild(makeRow(
      diskOk ? "✅" : "⚠️",
      diskFreeGB !== null ? `Free Disk: ${diskFreeGB} GB` : "Free Disk: unable to detect",
      diskOk
        ? `Enough disk space for AI models and your organized files.`
        : `Less than 10 GB free disk space. Ollama model downloads may fail.`
    ));

    // Ollama check
    list.appendChild(makeRow(
      ollamaInstalled ? "✅" : "⚠️",
      ollamaInstalled ? "Ollama: installed" : "Ollama: not detected",
      ollamaInstalled
        ? `Local AI engine is available. Classification will use AI.`
        : `Ollama not found. The app still organizes files using smart keyword rules — AI classification won't be available until Ollama is installed.`
    ));

    // Free RAM note
    list.appendChild(makeRow(
      freeRamGB >= 1.5 ? "✅" : "⚠️",
      `Available RAM right now: ${freeRamGB} GB`,
      freeRamGB >= 4
        ? `Great — full AI model (3B) will load.`
        : freeRamGB >= 1.5
        ? `Enough for the lightweight 1B model. Quality is still good.`
        : `Very low available RAM. Close other apps before using AI features.`
    ));
  }

  async function show() {
    await runChecks();
    overlay.classList.remove("hidden");
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", async () => {
      overlay.classList.add("hidden");
      try { await window.api.system.markFirstRunSeen(); } catch { /* ignore */ }
    });
  }

  // Show on first launch (after a short delay so the app finishes loading)
  setTimeout(async () => {
    try {
      const isFirst = await window.api.system.isFirstRun();
      if (isFirst) show();
    } catch { /* ignore — non-critical */ }
  }, 1500);

  // Expose globally so it can be triggered from settings
  window._showSystemCheck = show;
})();

// ═══════════════════════════════════════════════════════════════
//  MODEL DOWNLOAD (first launch, model not yet cached)
// ═══════════════════════════════════════════════════════════════
(function modelDownloadModule() {
  if (!window.api || !window.api.model || !window.api.on) return;

  const overlay   = document.getElementById("modelDownloadOverlay");
  const nameEl    = document.getElementById("modelDlName");
  const bar       = document.getElementById("modelDlBar");
  const pctEl     = document.getElementById("modelDlPct");
  const statusEl  = document.getElementById("modelDlStatus");
  const retryBtn  = document.getElementById("modelDlRetryBtn");
  if (!overlay) return;

  let currentModel = null;

  const TIER_LABELS = {
    high:   "3B model — best quality (requires ~4 GB RAM)",
    medium: "1B model — good quality, lighter",
    low:    "Quantized model — ultra-light (low RAM)",
  };

  function showOverlay(model, tier) {
    currentModel = model;
    if (nameEl) nameEl.textContent = `${model}  ·  ${TIER_LABELS[tier] || tier}`;
    setProgress(0, "Connecting to Ollama...");
    if (retryBtn) retryBtn.classList.add("hidden");
    overlay.classList.remove("hidden");
  }

  function hideOverlay() {
    overlay.classList.add("hidden");
  }

  function setProgress(pct, status) {
    if (bar)      bar.style.width = `${pct}%`;
    if (pctEl)    pctEl.textContent = `${pct}%`;
    if (statusEl) statusEl.textContent = status || "";
  }

  function showError(msg) {
    if (statusEl) statusEl.textContent = `Download failed: ${msg}`;
    if (retryBtn) retryBtn.classList.remove("hidden");
  }

  async function startPull(model) {
    if (retryBtn) retryBtn.classList.add("hidden");
    setProgress(0, "Starting download...");

    // Register progress listener
    window.api.on.modelPullProgress(({ pct }) => {
      setProgress(pct, pct < 100 ? `Downloading... ${pct}%` : "Finalizing...");
    });

    window.api.on.modelPullDone(() => {
      setProgress(100, "Done!");
      if (typeof showToast === "function") showToast(`AI model ready — ${model}`);
      if (typeof feedAdd === "function") feedAdd(`AI model downloaded: ${model}`);
      setTimeout(hideOverlay, 800);
    });

    window.api.on.modelPullError(({ error }) => {
      showError(error || "unknown error");
    });

    // Invoke the pull (returns when complete or failed — events carry real-time progress)
    try {
      await window.api.model.pull(model);
    } catch (err) {
      showError(err.message);
    }
  }

  // Main trigger: main process sends this after Ollama starts if model isn't cached
  window.api.on.modelNeedsDownload(({ model, tier }) => {
    showOverlay(model, tier);
    startPull(model);
  });

  // Retry button
  if (retryBtn) {
    retryBtn.addEventListener("click", () => {
      if (currentModel) startPull(currentModel);
    });
  }
})();

// ── Search index background upgrade banner ─────────────────────────────────
(function searchUpgradeModule() {
  const banner  = document.getElementById("searchUpgradeBanner");
  const label   = document.getElementById("searchUpgradeLabel");
  const bar     = document.getElementById("searchUpgradeBar");
  const pctEl   = document.getElementById("searchUpgradePct");

  if (!banner || !window.api?.on?.searchUpgradeProgress) return;

  window.api.on.searchUpgradeProgress((data) => {
    if (data.done) {
      // Briefly show 100% then hide
      if (bar) bar.style.width = "100%";
      if (pctEl) pctEl.textContent = "100%";
      if (label) label.textContent = "Search index upgrade complete";
      setTimeout(() => banner.classList.add("hidden"), 2000);
      return;
    }
    const { current, total } = data;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    banner.classList.remove("hidden");
    if (label) label.textContent = `Upgrading search index... (${current}/${total} files)`;
    if (bar)   bar.style.width   = `${pct}%`;
    if (pctEl) pctEl.textContent = `${pct}%`;
  });
})();

// ── Background Learner Indicator ──────────────────────────────────────────
// A tiny animated pill in the bottom-right corner that appears only while
// the idle-time learner is actively enriching the concept pools.
// Invisible at rest — users never feel interrupted.

(function initLearnerIndicator() {
  const indicator  = document.getElementById("learnerIndicator");
  const labelEl    = document.getElementById("learnerLabel");
  const statsEl    = document.getElementById("learnerStats");
  if (!indicator || !window.api?.on?.learnerStatus) return;

  let _hideTimer = null;

  function updateIndicator(status) {
    if (!status) return;

    const { running, paused, filesProcessed, termsAdded, currentFolder } = status;

    // Show only while actively running
    if (!running || filesProcessed === 0) {
      indicator.classList.remove("visible");
      return;
    }

    if (paused) {
      indicator.classList.add("paused");
      if (labelEl) labelEl.textContent = "Learning paused";
      if (statsEl) statsEl.textContent = "";
    } else {
      indicator.classList.remove("paused");
      if (labelEl) {
        labelEl.textContent = currentFolder
          ? `Learning: ${currentFolder}`
          : "Learning…";
      }
      if (statsEl) {
        statsEl.textContent = termsAdded > 0 ? `+${termsAdded} terms` : "";
      }
    }

    indicator.classList.add("visible");

    // Auto-hide 5 s after the learner goes idle
    clearTimeout(_hideTimer);
    if (!running || paused) {
      _hideTimer = setTimeout(() => indicator.classList.remove("visible"), 5000);
    }
  }

  // Listen for push updates from the main process
  window.api.on.learnerStatus(updateIndicator);

  // Also poll once on load to pick up a session that started before the window
  if (window.api.learner) {
    window.api.learner.status().then(updateIndicator).catch(() => {});
  }

  // Clicking the indicator opens a tooltip showing total stats
  indicator.addEventListener("click", async () => {
    if (!window.api.learner) return;
    try {
      const s = await window.api.learner.status();
      if (!s) return;
      const msg = `Background learning: ${s.filesProcessed} files scanned, ${s.termsAdded} terms added to concept pools.\n\nThis runs automatically during idle time and makes the AI more accurate over time.`;
      showToast(msg, 6000);
    } catch (_) {}
  });
})();

// ── Disambiguation Card ────────────────────────────────────────────────────
// Shows when the watcher emits "watcher:needs-disambiguation".
// The user picks one of the two candidate folders; the choice is sent back
// via watcher.disambiguationChoice() and the file is moved + saved to Learning Data.

(function initDisambiguationCard() {
  const overlay     = document.getElementById("disambigOverlay");
  const filenameEl  = document.getElementById("disambigFilename");
  const reasonEl    = document.getElementById("disambigReason");
  const choicesEl   = document.getElementById("disambigChoices");
  const confirmBtn  = document.getElementById("disambigConfirmBtn");
  const skipBtn     = document.getElementById("disambigSkipBtn");
  if (!overlay) return;

  // State held for the current disambiguation session
  let _payload   = null;  // full data from IPC
  let _selection = null;  // "A" | "B"

  function esc(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function buildKeywordChips(keywords, highlight) {
    if (!keywords || keywords.length === 0) return '<span style="color:rgba(255,255,255,0.25);font-size:11px;">no keywords found</span>';
    return keywords.slice(0, 8).map(kw =>
      `<span class="disambig-kw${highlight ? " highlight" : ""}">${esc(kw)}</span>`
    ).join("");
  }

  function renderChoices(data) {
    const confA = Math.round(data.catAConfidence || 0);
    const confB = Math.round(data.catBConfidence || 0);

    choicesEl.innerHTML = `
      <button class="disambig-choice-btn" data-choice="A" title="Move to ${esc(data.catA)}">
        <div class="disambig-choice-name">
          📁 ${esc(data.catA)}
          <span class="disambig-choice-conf">${confA}%</span>
        </div>
        <div class="disambig-keywords">${buildKeywordChips(data.catAKeywords, true)}</div>
      </button>
      <button class="disambig-choice-btn" data-choice="B" title="Move to ${esc(data.catB)}">
        <div class="disambig-choice-name">
          📁 ${esc(data.catB)}
          <span class="disambig-choice-conf">${confB}%</span>
        </div>
        <div class="disambig-keywords">${buildKeywordChips(data.catBKeywords, false)}</div>
      </button>
    `;

    // Wire up selection clicks
    choicesEl.querySelectorAll(".disambig-choice-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        choicesEl.querySelectorAll(".disambig-choice-btn").forEach(b => b.classList.remove("selected"));
        btn.classList.add("selected");
        _selection = btn.dataset.choice;
        confirmBtn.disabled = false;
      });
    });
  }

  function hide() {
    overlay.classList.add("hidden");
    _payload   = null;
    _selection = null;
    confirmBtn.disabled = true;
    if (choicesEl) choicesEl.innerHTML = "";
  }

  // Public: called from the IPC listener
  window.showDisambiguationCard = function(data) {
    _payload   = data;
    _selection = null;
    confirmBtn.disabled = true;

    if (filenameEl) filenameEl.textContent = data.filename || "Unknown file";
    if (reasonEl) {
      const reason = data.reasoning
        ? data.reasoning
        : "The AI found this file could fit in two folders. Pick the right one.";
      reasonEl.textContent = reason + " Your choice teaches the AI for next time.";
    }

    renderChoices(data);
    overlay.classList.remove("hidden");
  };

  // Confirm button — send choice to main process
  confirmBtn.addEventListener("click", async () => {
    if (!_payload || !_selection) return;

    const chosen  = _selection === "A" ? _payload.catA : _payload.catB;
    const other   = _selection === "A" ? _payload.catB : _payload.catA;
    const chosenKw = _selection === "A" ? (_payload.catAKeywords || []) : (_payload.catBKeywords || []);
    const otherKw  = _selection === "A" ? (_payload.catBKeywords || []) : (_payload.catAKeywords || []);

    confirmBtn.disabled = true;
    confirmBtn.textContent = "Moving…";

    try {
      const res = await window.api.watcher.disambiguationChoice({
        filePath:          _payload.filePath,
        filename:          _payload.filename,
        chosenCategory:    chosen,
        otherCategory:     other,
        catAKeywords:      chosenKw,
        catBKeywords:      otherKw,
        aiConfidence:      _payload.catAConfidence || 0,
      });

      if (res && res.success) {
        showToast(`✅ Moved to ${chosen}/ — saved to Learning Data`, 4000);
      } else {
        showToast(`⚠️ Move failed: ${res?.error || "unknown error"}`, 4000);
      }
    } catch (err) {
      showToast(`⚠️ Disambiguation error: ${err.message || err}`, 4000);
    } finally {
      confirmBtn.textContent = "Confirm →";
      hide();
    }
  });

  // Skip button — dismiss without moving, release queue lock so next item shows
  skipBtn.addEventListener("click", async () => {
    showToast("Skipped — file left in place.", 3000);
    hide();
    // Tell main process to unblock the queue (next pending file can show)
    try { await window.api.watcher.disambiguationSkip(); } catch (_) {}
  });

  // Clicking outside the card also dismisses
  overlay.addEventListener("click", async (e) => {
    if (e.target === overlay) {
      showToast("Skipped — file left in place.", 3000);
      hide();
      try { await window.api.watcher.disambiguationSkip(); } catch (_) {}
    }
  });
})();
