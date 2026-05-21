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
var ClassificationService_exports = {};
__export(ClassificationService_exports, {
  checkDisambiguationRules: () => checkDisambiguationRules,
  classifyBatch: () => classifyBatch,
  classifyFile: () => classifyFile,
  disambiguateCategories: () => disambiguateCategories,
  findExistingEquivalent: () => findExistingEquivalent,
  getFolderDistinctiveTerms: () => getFolderDistinctiveTerms,
  getPoolHealthReport: () => getPoolHealthReport,
  getResultConfidenceTier: () => getResultConfidenceTier,
  submitCorrection: () => submitCorrection
});
module.exports = __toCommonJS(ClassificationService_exports);
var import_fs = __toESM(require("fs"));
var import_http = __toESM(require("http"));
var import_path = __toESM(require("path"));
var import_LearningService = require("./LearningService");
var import_PoolEnrichmentService = require("./PoolEnrichmentService");
var import_ConsistencyService = require("./ConsistencyService");
var import_ContextService = require("./ContextService");
var import_TextExtractionService = require("./TextExtractionService");
var import_universal_pool_manager = require("../intelligence/universal-pool-manager");
var import_accuracy_monitor = require("../validation/accuracy-monitor");
const { scanUserFolders } = require("./fileService");
let _indexSearchFiles = null;
function getIndexSearch() {
  if (!_indexSearchFiles) {
    try {
      _indexSearchFiles = require("./SearchIndexService").searchFiles;
    } catch {
    }
  }
  return _indexSearchFiles;
}
const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const PREFERRED_MODELS = ["llama3.2:3b", "llama3.2:1b", "llama3.2", "llama3:latest"];
let resolvedModelName = null;
async function getModelName() {
  if (resolvedModelName) return resolvedModelName;
  try {
    const available = await new Promise((resolve) => {
      const req = import_http.default.request(
        { hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: "/api/tags", method: "GET", timeout: 5e3 },
        (res) => {
          let body = "";
          res.on("data", (c) => body += c.toString());
          res.on("end", () => {
            try {
              const data = JSON.parse(body);
              resolve((data.models || []).map((m) => m.name));
            } catch {
              resolve([]);
            }
          });
        }
      );
      req.on("error", () => resolve([]));
      req.on("timeout", () => {
        req.destroy();
        resolve([]);
      });
      req.end();
    });
    for (const preferred of PREFERRED_MODELS) {
      if (available.some((m) => m === preferred || m.startsWith(preferred.split(":")[0] + ":"))) {
        const exact = available.find((m) => m === preferred);
        resolvedModelName = exact || available.find((m) => m.startsWith(preferred.split(":")[0] + ":")) || preferred;
        console.log(`[Classification] Using model: ${resolvedModelName}`);
        return resolvedModelName;
      }
    }
  } catch {
  }
  resolvedModelName = "llama3.2:1b";
  return resolvedModelName;
}
const MODEL_NAME = "llama3.2:1b";
const REQUEST_TIMEOUT_MS = 9e4;
const REVIEW_THRESHOLD = 60;
const NOISE_FOLDER_PENALTY = 30;
const DOMAIN_CONFIDENCE_THRESHOLD = 60;
const DOMAIN_CLASSIFIER_WORDS = 2e3;
const BULLSEYE_CONTENT_WORDS = 100;
const HEADER_ZONE_CHARS = 500;
const FULL_TEXT_SAMPLE_THRESHOLD = 5e4;
const MAX_OLLAMA_CONTENT_WORDS = 3e3;
const RECENCY_WINDOW_MS = 90 * 24 * 60 * 60 * 1e3;
async function sampleFileContent(filePath) {
  const raw = await (0, import_TextExtractionService.extractForClassification)(filePath);
  if (!raw) return "";
  const words = raw.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= FULL_TEXT_SAMPLE_THRESHOLD) return words.join(" ");
  const firstChunk = words.slice(0, 3e3).join(" ");
  const midStart = Math.floor(words.length / 2) - 1e3;
  const middleChunk = words.slice(midStart, midStart + 2e3).join(" ");
  const lastChunk = words.slice(-2e3).join(" ");
  return [
    firstChunk,
    "\n\n[... middle section ...]\n\n",
    middleChunk,
    "\n\n[... end section ...]\n\n",
    lastChunk
  ].join("");
}
const GLOBAL_DOMAINS = {
  Education: {
    examples: "Homework, syllabi, textbooks, courses, school assignments, academic papers, lectures, exams",
    folderHints: ["School", "Courses", "Academic", "Classes", "Education", "Study"]
  },
  Finance: {
    examples: "Taxes, invoices, bank statements, budgets, receipts, payroll, financial reports, investments",
    folderHints: ["Finance", "Financial", "Money", "Banking", "Accounting", "Taxes"]
  },
  Legal: {
    examples: "Contracts, terms of service, legal briefs, court documents, agreements, compliance, NDAs",
    folderHints: ["Legal", "Law", "Contracts"]
  },
  Medical: {
    examples: "Lab results, prescriptions, medical records, insurance claims, health reports, clinical notes",
    folderHints: ["Medical", "Health", "Healthcare"]
  },
  Personal: {
    examples: "Travel plans, recipes, family documents, personal letters, journals, hobbies, photos",
    folderHints: ["Personal", "Home", "Family", "Life"]
  },
  Tech: {
    examples: "Source code, technical manuals, API docs, system documentation, configs, architecture diagrams",
    folderHints: ["Tech", "Code", "Development", "Engineering", "Programming"]
  },
  Work: {
    examples: "Resumes, business reports, project plans, presentations, meeting notes, proposals, professional docs",
    folderHints: ["Work", "Business", "Career", "Professional", "Projects"]
  },
  Mathematics: {
    examples: "Calculus, algebra, geometry, statistics, proofs, equations, theorems, trigonometry, precalculus, linear algebra",
    folderHints: [
      "Math",
      "Mathematics",
      "Precalculus",
      "PreCalc",
      "Pre-Calc",
      "Pre Calc",
      "Calculus",
      "Algebra",
      "Geometry",
      "Statistics",
      "Trigonometry",
      "STEM"
    ]
  }
};
function callOllama(systemPrompt, userMessage, opts) {
  const temperature = opts?.temperature ?? 0.1;
  const numCtx = opts?.numCtx ?? 4096;
  const timeout = opts?.timeout ?? REQUEST_TIMEOUT_MS;
  return getModelName().then((modelName) => new Promise((resolve, reject) => {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: userMessage });
    const payload = JSON.stringify({
      model: modelName,
      messages,
      stream: false,
      options: { temperature, num_ctx: numCtx }
    });
    const req = import_http.default.request(
      {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: "/api/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => body += chunk.toString());
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            resolve(data.message?.content || "");
          } catch {
            reject(new Error("Failed to parse Ollama response"));
          }
        });
        res.on("error", (err) => reject(err));
      }
    );
    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Ollama request timed out"));
    });
    req.write(payload);
    req.end();
  }));
}
function isFileRecent(filePath) {
  try {
    const stat = import_fs.default.statSync(filePath);
    const created = stat.birthtimeMs || stat.mtimeMs;
    return Date.now() - created < RECENCY_WINDOW_MS;
  } catch {
    return false;
  }
}
function tokenize(text) {
  const tokens = /* @__PURE__ */ new Set();
  const raw = text.toLowerCase().replace(/[-_.,;:!?()\[\]{}'"/\\@#$%^&*+=~`<>]/g, " ");
  const words = raw.split(/\s+/).filter((w) => w.length >= 2);
  for (const word of words) {
    tokens.add(word);
    const alphaPrefix = word.match(/^([a-z]+)\d/);
    if (alphaPrefix && alphaPrefix[1].length >= 2) {
      tokens.add(alphaPrefix[1]);
    }
    const alphaSuffix = word.match(/\d([a-z]{2,})$/);
    if (alphaSuffix) {
      tokens.add(alphaSuffix[1]);
    }
  }
  return tokens;
}
function tokenMatchesWord(token, word) {
  if (token === word) return true;
  const shorter = token.length <= word.length ? token : word;
  const longer = token.length > word.length ? token : word;
  if (shorter.length <= 2) {
    return longer.startsWith(shorter);
  }
  return longer.startsWith(shorter) && shorter.length / longer.length >= 0.6;
}
function sortBySpecificity(folders, fingerprints) {
  return [...folders].sort((a, b) => {
    const fpA = fingerprints[a];
    const fpB = fingerprints[b];
    const topicsA = fpA?.coreTopics?.length || 0;
    const topicsB = fpB?.coreTopics?.length || 0;
    if (topicsA !== topicsB) return topicsB - topicsA;
    const wordsA = a.split(/[\s_-]+/).length;
    const wordsB = b.split(/[\s_-]+/).length;
    if (wordsA !== wordsB) return wordsB - wordsA;
    return b.length - a.length;
  });
}
function tryBullseyeMatch(filename, fileContent, fingerprints, activeFolders) {
  function collectHits(tokens2, viaPrefix) {
    const found = [];
    for (const folder of activeFolders) {
      const fp = fingerprints[folder];
      if (!fp || fp.isNoiseFolder) continue;
      const nameWords = folder.replace(/[-_]/g, " ").split(/\s+/).map((w) => w.toLowerCase()).filter((w) => w.length >= 2);
      if (nameWords.length > 0) {
        const matched = nameWords.filter(
          (w) => [...tokens2].some((t) => tokenMatchesWord(t, w))
        );
        if (matched.length === nameWords.length) {
          found.push({
            folder,
            matched: matched.length,
            total: nameWords.length,
            via: `${viaPrefix}folder name [${matched.join(", ")}]`
          });
          continue;
        }
      }
      {
        const normFolder = folder.toLowerCase().replace(/[-_\s+.]/g, "");
        const rawText = [
          filename.replace(/\.[^.]+$/, ""),
          fileContent ? fileContent.split(/\s+/).slice(0, BULLSEYE_CONTENT_WORDS).join(" ") : ""
        ].join(" ").toLowerCase().replace(/[-_]/g, "");
        if (normFolder.length >= 3 && rawText.includes(normFolder)) {
          found.push({
            folder,
            matched: normFolder.length,
            total: normFolder.length,
            via: `${viaPrefix}normalised-name substring "${normFolder}"`
          });
          continue;
        }
      }
      for (const topic of fp.coreTopics) {
        const topicWords = topic.toLowerCase().split(/[\s,]+/).filter((w) => w.length >= 2);
        if (topicWords.length === 0) continue;
        const matched = topicWords.filter(
          (w) => [...tokens2].some((t) => tokenMatchesWord(t, w))
        );
        if (matched.length >= Math.ceil(topicWords.length * 0.75)) {
          found.push({
            folder,
            matched: matched.length,
            total: topicWords.length,
            via: `${viaPrefix}Core Topic "${topic}" [${matched.join(", ")}]`
          });
        }
      }
    }
    return found;
  }
  function pickBest(hits2) {
    hits2.sort((a, b) => {
      if (a.matched !== b.matched) return b.matched - a.matched;
      return b.folder.length - a.folder.length;
    });
    const best = hits2[0];
    const reasoning = `BULLSEYE: "${best.folder}" matched via ${best.via} (${best.matched}/${best.total} words).`;
    console.log(`[Classification] ${reasoning}`);
    return {
      category: best.folder,
      confidence: 100,
      reasoning,
      isNewFolder: false,
      detected_concepts: [],
      concept_abstraction: `Direct token match \u2014 ${best.via}`,
      requires_review: false,
      was_noise_penalized: false,
      global_domain: "",
      global_subdomain: "",
      suggested_path: "",
      match_level: "bullseye"
    };
  }
  const headerZone = fileContent ? fileContent.slice(0, HEADER_ZONE_CHARS) : "";
  if (headerZone) {
    const headerTokens = tokenize(headerZone);
    const headerHits = collectHits(headerTokens, "HEADER ");
    if (headerHits.length > 0) {
      console.log(
        `[Classification] HEADER AUTHORITY: ${headerHits.length} match(es) in first ${HEADER_ZONE_CHARS} chars \u2014 header overrides body.`
      );
      return pickBest(headerHits);
    }
  }
  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent ? fileContent.split(/\s+/).slice(0, BULLSEYE_CONTENT_WORDS).join(" ") : "";
  const tokens = tokenize(nameNoExt + " " + contentHead);
  const hits = collectHits(tokens, "");
  if (hits.length === 0) return null;
  return pickBest(hits);
}
function tryMetadataBullseye(metadata, activeFolders, fingerprints, filename) {
  if (!metadata) return null;
  const metaText = [
    metadata.title,
    metadata.subject,
    metadata.keywords,
    metadata.description,
    metadata.creator
  ].filter(Boolean).join(" ");
  if (metaText.trim().length < 3) return null;
  const metaTokens = tokenize(metaText);
  for (const folder of activeFolders) {
    const fp = fingerprints[folder];
    if (!fp || fp.isNoiseFolder) continue;
    const nameWords = folder.replace(/[-_]/g, " ").split(/\s+/).map((w) => w.toLowerCase()).filter((w) => w.length >= 2);
    if (nameWords.length > 0) {
      const matched = nameWords.filter(
        (w) => [...metaTokens].some((t) => tokenMatchesWord(t, w))
      );
      if (matched.length === nameWords.length) {
        const reasoning = `METADATA BULLSEYE: folder "${folder}" matched via document metadata \u2014 subject="${metadata.subject || ""}" keywords="${metadata.keywords || ""}"`;
        console.log(`[Classification] ${reasoning}`);
        console.log(`[Classification] PDF metadata hit: subject='${metadata.subject || ""}'`);
        return {
          category: folder,
          confidence: 100,
          reasoning,
          isNewFolder: false,
          detected_concepts: [metadata.subject || metadata.title || folder],
          concept_abstraction: `Document metadata match`,
          requires_review: false,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: "bullseye"
        };
      }
    }
    for (const topic of fp.coreTopics) {
      const topicWords = topic.toLowerCase().split(/[\s,]+/).filter((w) => w.length >= 2);
      if (topicWords.length === 0) continue;
      const matched = topicWords.filter(
        (w) => [...metaTokens].some((t) => tokenMatchesWord(t, w))
      );
      if (matched.length >= Math.ceil(topicWords.length * 0.75)) {
        const reasoning = `METADATA BULLSEYE: folder "${folder}" Core Topic "${topic}" matched via metadata`;
        console.log(`[Classification] ${reasoning}`);
        return {
          category: folder,
          confidence: 100,
          reasoning,
          isNewFolder: false,
          detected_concepts: [topic],
          concept_abstraction: `Document metadata match`,
          requires_review: false,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: "bullseye"
        };
      }
    }
  }
  return null;
}
const KEYWORD_MAP = [
  // ── APUSH — checked FIRST. Uses folderMatcher so it works whether the
  //    folder is named "APUSH", "AP US History", "US History", etc. ──────
  {
    // Unambiguous APUSH identifiers → 100% confidence
    keywords: [
      "amsco",
      "apush",
      "ap us history",
      "ap united states history",
      "united states history",
      "period 4",
      "period 5",
      "period 6",
      "period 7",
      "period 8",
      "period 9",
      "dbq",
      "document based question",
      "leq",
      "long essay question",
      "saq",
      "short answer question"
    ],
    folderMatcher: (folders) => folders.find(
      (f) => [
        "apush",
        "ushistory",
        "us history",
        "american history",
        "united states",
        "usgov",
        "us gov",
        "history"
      ].some(
        (s) => f.toLowerCase().replace(/[-_\s+.]/g, "").includes(s.replace(/\s/g, ""))
      )
    ),
    confidence: 100
  },
  {
    // Common APUSH event/era terms → 88% (avoid over-routing general docs)
    keywords: [
      "reconstruction",
      "civil war",
      "manifest destiny",
      "new deal",
      "great depression",
      "american revolution",
      "constitutional convention",
      "gilded age",
      "progressive era",
      "cold war",
      "new frontier",
      "jacksonian democracy",
      "antebellum",
      "emancipation proclamation"
    ],
    folderMatcher: (folders) => folders.find(
      (f) => [
        "apush",
        "ushistory",
        "us history",
        "american history",
        "united states",
        "history"
      ].some(
        (s) => f.toLowerCase().replace(/[-_\s+.]/g, "").includes(s.replace(/\s/g, ""))
      )
    ),
    confidence: 88
  },
  // ── AP Seminar — folderMatcher so "AP Seminar", "Seminar", "APSem" all work ──
  {
    keywords: [
      "ap seminar",
      "college board",
      "performance task",
      "individual research report",
      "individual multimedia presentation",
      "team multimedia presentation",
      "irr",
      "imp",
      "tmp",
      "stimulus material",
      "cross-curricular",
      "geopolitics",
      "international relations",
      "diplomacy",
      "national security",
      "foreign policy"
    ],
    folderMatcher: (folders) => folders.find(
      (f) => ["seminar", "apsem", "apresearch", "research"].some(
        (s) => f.toLowerCase().replace(/[-_\s+.]/g, "").includes(s)
      )
    ),
    confidence: 95
  },
  // ── FBLA — folderMatcher so "FBLA", "Business", "BizLead" all work ──
  {
    keywords: [
      "fbla",
      "future business leaders",
      "competitive event",
      "business plan",
      "business financial plan",
      "entrepreneurship",
      "business presentation",
      "parliamentary procedure",
      "business ethics"
    ],
    folderMatcher: (folders) => folders.find(
      (f) => ["fbla", "business", "deca", "entrepreneurship"].some(
        (s) => f.toLowerCase().replace(/[-_\s+.]/g, "").includes(s)
      )
    ),
    confidence: 95
  },
  // ── Career / Finance — still folder-name matched but case-insensitive ──
  {
    keywords: [
      "resume",
      "cover letter",
      "curriculum vitae",
      "job application",
      "linkedin",
      "career objective"
    ],
    folderMatcher: (folders) => folders.find(
      (f) => ["career", "job", "resume", "employment"].some(
        (s) => f.toLowerCase().replace(/[-_\s+.]/g, "").includes(s)
      )
    ),
    confidence: 95
  },
  {
    keywords: [
      "invoice",
      "tax return",
      "w-2",
      "1099",
      "bank statement",
      "financial statement",
      "balance sheet",
      "income statement"
    ],
    folderMatcher: (folders) => folders.find(
      (f) => ["finance", "financial", "money", "tax", "accounting", "banking"].some(
        (s) => f.toLowerCase().replace(/[-_\s+.]/g, "").includes(s)
      )
    ),
    confidence: 95
  },
  // ── Math compound phrases → dynamic folder match ──────────
  {
    keywords: [
      // Compound / multi-word phrases (high specificity)
      "cross product",
      "dot product",
      "vectors in the plane",
      "3d coordinate",
      "coordinate system",
      "vector applications",
      "vectors in space",
      "unit vector",
      "direction angles",
      "dot products",
      "linear combination",
      "parametric equation",
      "polar coordinates",
      "conic section",
      "complex number",
      "rational function",
      "polynomial function",
      "logarithm",
      "trigonometric",
      "radian",
      "derivative",
      "integral",
      "limit of",
      "sequences and series",
      // Single-word math-specific terms (unambiguous in student notes)
      "precalculus",
      "pre-calculus",
      "precalc",
      "pre calc",
      "unit circle",
      "pythagorean",
      "sinusoidal",
      "completing the square",
      "vertex form",
      "standard form",
      "law of sines",
      "law of cosines",
      "arithmetic sequence",
      "geometric sequence",
      "binomial theorem",
      "angle of elevation",
      "angle of depression",
      "inverse function",
      "composition of functions",
      "sum and difference",
      "double angle",
      "half angle",
      "amplitude",
      "period",
      "phase shift",
      "asymptote",
      "discontinuity",
      "slope intercept",
      "point slope",
      "standard form",
      "quadratic formula",
      "discriminant",
      "imaginary number",
      "complex plane"
    ],
    folderMatcher: (folders) => folders.find(
      (f) => [
        "precalc",
        "calc",
        "math",
        "mathematics",
        "algebra",
        "geometry",
        "trig",
        "stem"
      ].some(
        (s) => f.toLowerCase().includes(s)
      )
    ),
    confidence: 88
  }
];
function tryKeywordMatch(filename, fileContent, activeFolders) {
  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent ?? "";
  const searchText = (nameNoExt + " " + contentHead).toLowerCase();
  for (const entry of KEYWORD_MAP) {
    let actualFolder;
    if (entry.folderMatcher) {
      actualFolder = entry.folderMatcher(activeFolders);
    } else if (entry.folder) {
      const folderExists = activeFolders.some(
        (f) => f.toLowerCase() === entry.folder.toLowerCase()
      );
      if (folderExists) {
        actualFolder = activeFolders.find(
          (f) => f.toLowerCase() === entry.folder.toLowerCase()
        );
      }
    }
    if (!actualFolder) continue;
    for (const keyword of entry.keywords) {
      const kw = keyword.toLowerCase();
      const matched = kw.length < 5 ? new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(searchText) : searchText.includes(kw);
      if (matched) {
        const conf = entry.confidence;
        const reasoning = `KEYWORD MAP: "${keyword}" found in content \u2192 routed to "${actualFolder}" (${conf}%)`;
        console.log(`[Classification] ${reasoning}`);
        return {
          category: actualFolder,
          confidence: conf,
          reasoning,
          isNewFolder: false,
          detected_concepts: [keyword],
          concept_abstraction: `Keyword-mapped to ${actualFolder} via "${keyword}"`,
          requires_review: false,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: conf === 100 ? "bullseye" : "specific"
        };
      }
    }
  }
  return null;
}
const SUBJECT_GROUPS = {
  MATH: {
    folderHints: [
      "math",
      "calc",
      "precalc",
      "algebra",
      "geometry",
      "trig",
      "statistics",
      "stats",
      "arithmetic"
    ],
    keywords: [
      "equation",
      "formula",
      "sine",
      "cosine",
      "tangent",
      "derivative",
      "integral",
      "algebra",
      "geometry",
      "trigonometry",
      "function",
      "calculus",
      "precalc",
      "problem set",
      "polynomial",
      "quadratic",
      "logarithm",
      "exponent",
      "matrix",
      "vector",
      "variable",
      "coefficient",
      "slope",
      "intercept",
      "asymptote",
      "limit"
    ]
  },
  SCIENCE: {
    folderHints: [
      "science",
      "bio",
      "chem",
      "physics",
      "anatomy",
      "ecology",
      "enviro",
      "astro",
      "geology"
    ],
    keywords: [
      "cell",
      "dna",
      "gene",
      "atom",
      "molecule",
      "reaction",
      "force",
      "energy",
      "gravity",
      "lab report",
      "experiment",
      "data",
      "analysis",
      "hypothesis",
      "organism",
      "evolution",
      "photosynthesis",
      "mitosis",
      "meiosis",
      "protein",
      "enzyme",
      "element",
      "compound",
      "velocity",
      "acceleration",
      "nucleus",
      "chromosome",
      "ecosystem"
    ]
  },
  HUMANITIES: {
    folderHints: [
      "history",
      "apush",
      "gov",
      "government",
      "civics",
      "social",
      "geography",
      "econ",
      "economics",
      "politics",
      "anthropology"
    ],
    keywords: [
      "history",
      "war",
      "treaty",
      "constitution",
      "century",
      "period",
      "era",
      "amsco",
      "document",
      "primary source",
      "context",
      "civilization",
      "revolution",
      "amendment",
      "congress",
      "democracy",
      "republic",
      "colony",
      "independence",
      "reconstruction",
      "civil rights",
      "legislation",
      "sovereignty"
    ]
  },
  LITERATURE: {
    folderHints: [
      "english",
      "lit",
      "writing",
      "composition",
      "lang",
      "rhetoric",
      "creative writing",
      "journalism"
    ],
    keywords: [
      "essay",
      "novel",
      "poem",
      "thesis",
      "analysis",
      "literary",
      "theme",
      "quote",
      "draft",
      "composition",
      "metaphor",
      "simile",
      "narrative",
      "rhetoric",
      "argument",
      "author",
      "protagonist",
      "symbolism",
      "allegory",
      "irony",
      "tone",
      "diction"
    ]
  },
  ACADEMIC_RESEARCH: {
    folderHints: [
      "seminar",
      "research",
      "capstone",
      "thesis",
      "academic",
      "ap seminar",
      "ap research"
    ],
    keywords: [
      "seminar",
      "college board",
      "performance task",
      "irr",
      "tmp",
      "iwa",
      "source",
      "academic",
      "bibliography",
      "citation",
      "methodology",
      "abstract",
      "peer review",
      "literature review",
      "research question",
      "annotated",
      "works cited"
    ]
  },
  BUSINESS: {
    folderHints: [
      "business",
      "fbla",
      "deca",
      "entrepreneurship",
      "marketing",
      "management",
      "accounting"
    ],
    keywords: [
      "business",
      "finance",
      "marketing",
      "entrepreneur",
      "revenue",
      "profit",
      "loss",
      "investment",
      "budget",
      "competitive",
      "market analysis",
      "stakeholder",
      "strategy",
      "roi",
      "supply chain",
      "inventory",
      "cash flow"
    ]
  },
  COMPUTER_SCIENCE: {
    folderHints: [
      "cs",
      "compsci",
      "programming",
      "coding",
      "apcsa",
      "apcsp",
      "software",
      "cyber"
    ],
    keywords: [
      "algorithm",
      "variable",
      "loop",
      "function",
      "class",
      "object",
      "array",
      "string",
      "boolean",
      "recursion",
      "iteration",
      "data structure",
      "binary",
      "compiler",
      "runtime",
      "debug",
      "api",
      "database",
      "server",
      "client",
      "html",
      "python",
      "java"
    ]
  }
};
const SMART_GROUP_MIN_HITS = 3;
const SMART_GROUP_CONFIDENCE = 85;
function trySmartGroupMatch(filename, fileContent, activeFolders) {
  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent ?? "";
  const searchText = (nameNoExt + " " + contentHead).toLowerCase();
  const scores = [];
  for (const folder of activeFolders) {
    if ((0, import_ContextService.isNoiseFolderName)(folder)) continue;
    const folderLower = folder.toLowerCase();
    for (const [groupName, group] of Object.entries(SUBJECT_GROUPS)) {
      const hintMatch = group.folderHints.some(
        (hint) => folderLower.includes(hint)
      );
      if (!hintMatch) continue;
      const matchedKeywords = [];
      for (const kw of group.keywords) {
        if (searchText.includes(kw)) {
          matchedKeywords.push(kw);
        }
      }
      if (matchedKeywords.length >= SMART_GROUP_MIN_HITS) {
        scores.push({
          folder,
          group: groupName,
          hits: matchedKeywords.length,
          matchedKeywords
        });
      }
    }
  }
  if (scores.length === 0) return null;
  scores.sort((a, b) => b.hits - a.hits);
  {
    const filenamePlain = filename.toLowerCase().replace(/[-_\s+.]/g, "");
    for (const entry of scores) {
      const folderPlain = entry.folder.toLowerCase().replace(/[-_\s+.]/g, "");
      if (folderPlain.length >= 3 && filenamePlain.includes(folderPlain)) {
        entry.hits += 1e4;
      }
      const grp = SUBJECT_GROUPS[entry.group];
      if (grp) {
        for (const hint of grp.folderHints) {
          const hintPlain = hint.replace(/[-_\s+.]/g, "");
          if (hintPlain.length >= 4 && filenamePlain.includes(hintPlain)) {
            entry.hits += 100;
            break;
          }
        }
      }
    }
    scores.sort((a, b) => b.hits - a.hits);
  }
  const best = scores[0];
  const reasoning = `SMART GROUP: folder "${best.folder}" matched group ${best.group} \u2014 ${best.hits} keyword(s) found: [${best.matchedKeywords.slice(0, 5).join(", ")}]`;
  console.log(`[Classification] ${reasoning}`);
  return {
    category: best.folder,
    confidence: SMART_GROUP_CONFIDENCE,
    reasoning,
    isNewFolder: false,
    detected_concepts: best.matchedKeywords.slice(0, 5),
    concept_abstraction: `${best.group} subject detected \u2014 routed to "${best.folder}"`,
    requires_review: false,
    was_noise_penalized: false,
    global_domain: "",
    global_subdomain: "",
    suggested_path: "",
    match_level: "specific"
  };
}
const POOL_MIN_HITS = 3;
function readJsonFile(filePath) {
  try {
    if (import_fs.default.existsSync(filePath)) {
      return JSON.parse(import_fs.default.readFileSync(filePath, "utf-8"));
    }
  } catch {
  }
  return {};
}
function readMergedPool(targetDir) {
  const pool = readJsonFile(import_path.default.join(targetDir, "global_concepts.json"));
  const kb = readJsonFile(import_path.default.join(targetDir, "knowledge_base.json"));
  for (const [cat, concepts] of Object.entries(kb)) {
    if (!pool[cat]) {
      pool[cat] = concepts;
    } else {
      pool[cat] = [.../* @__PURE__ */ new Set([...pool[cat], ...concepts])];
    }
  }
  return pool;
}
function scalePoolConfidence(hits) {
  if (hits >= 8) return 85;
  if (hits >= 5) return 70;
  if (hits >= 3) return 60;
  return 0;
}
function tryPoolMatch(filename, fileContent, activeFolders, targetDir) {
  const pool = readMergedPool(targetDir);
  const categories = Object.keys(pool);
  if (categories.length === 0) return null;
  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent ?? "";
  const searchText = (nameNoExt + " " + contentHead).toLowerCase();
  if (searchText.length < 10) return null;
  const totalFolders = categories.length;
  const conceptFreq = {};
  for (const cats of Object.values(pool)) {
    for (const c of cats) {
      const k = c.toLowerCase();
      conceptFreq[k] = (conceptFreq[k] || 0) + 1;
    }
  }
  function getDistinctiveness(term) {
    const folderCount = conceptFreq[term.toLowerCase()] || 1;
    return Math.max(0, (1 - folderCount / totalFolders) * 100);
  }
  let bestCategory = null;
  let bestScore = 0;
  let bestHits = 0;
  let bestMatched = [];
  for (const [category, concepts] of Object.entries(pool)) {
    const folderMatch = activeFolders.find(
      (f) => f.toLowerCase() === category.toLowerCase()
    );
    if (!folderMatch) continue;
    let score = 0;
    const matched = [];
    for (const concept of concepts) {
      if (concept.length >= 3 && searchText.includes(concept.toLowerCase())) {
        matched.push(concept);
        const distinctiveness = getDistinctiveness(concept.toLowerCase());
        score += Math.max(0.1, distinctiveness / 100);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestHits = matched.length;
      bestCategory = folderMatch;
      bestMatched = matched;
    }
  }
  if (!bestCategory || bestHits < POOL_MIN_HITS) return null;
  if (bestScore < 1.5) return null;
  const confidence = scalePoolConfidence(bestHits);
  const reasoning = `POOL MATCH: folder "${bestCategory}" matched ${bestHits} concept(s): [${bestMatched.slice(0, 8).join(", ")}]`;
  console.log(`[Classification] ${reasoning}`);
  return {
    category: bestCategory,
    confidence,
    reasoning,
    isNewFolder: false,
    detected_concepts: bestMatched.slice(0, 5),
    concept_abstraction: `Pool concept match \u2014 routed to "${bestCategory}"`,
    requires_review: false,
    was_noise_penalized: false,
    global_domain: "",
    global_subdomain: "",
    suggested_path: "",
    match_level: "pool"
  };
}
const INTERNET_RETRY_CONFIDENCE = 65;
const INTERNET_RETRY_MIN_OVERLAP = 3;
const CLASSIFY_STOP_WORDS = /* @__PURE__ */ new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "shall",
  "may",
  "might",
  "can",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "not",
  "no",
  "so",
  "if",
  "then",
  "than",
  "when",
  "where",
  "how",
  "what",
  "which",
  "who",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "some",
  "any",
  "many",
  "much",
  "such",
  "very",
  "just",
  "also",
  "into",
  "over",
  "after",
  "before",
  "about",
  "as",
  "up",
  "out",
  "one",
  "two",
  "new",
  "used",
  "first",
  "other",
  "file",
  "document",
  "page"
]);
function extractNouns(text, count) {
  if (!text) return [];
  const words = text.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/);
  const freq = {};
  for (const w of words) {
    if (w.length < 3 || CLASSIFY_STOP_WORDS.has(w)) continue;
    freq[w] = (freq[w] || 0) + 1;
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, count).map(([word]) => word);
}
function fetchDatamuseForTerm(term) {
  const https = require("https");
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(term);
    const url = `https://api.datamuse.com/words?ml=${encoded}&max=30`;
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const words = Array.isArray(parsed) ? parsed.map((e) => e.word).filter(Boolean) : [];
          resolve(words);
        } catch {
          resolve([]);
        }
      });
      res.on("error", () => resolve([]));
    }).on("error", () => resolve([]));
  });
}
async function tryInternetRetry(filename, fileContent, activeFolders, targetDir) {
  const pool = readMergedPool(targetDir);
  if (Object.keys(pool).length === 0) return null;
  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent ?? "";
  const nouns = extractNouns(nameNoExt + " " + contentHead, 3);
  if (nouns.length === 0) return null;
  console.log(`[Classification] INTERNET RETRY: querying Datamuse for nouns [${nouns.join(", ")}]`);
  const apiResults = await Promise.all(nouns.map(fetchDatamuseForTerm));
  const allApiWords = new Set(apiResults.flat());
  const conceptFreq = {};
  for (const cats of Object.values(pool)) {
    for (const c of cats) {
      const k = c.toLowerCase();
      conceptFreq[k] = (conceptFreq[k] || 0) + 1;
    }
  }
  let bestFolder = null;
  let bestOverlap = 0;
  let bestScore = 0;
  let bestOverlapWords = [];
  for (const [category, concepts] of Object.entries(pool)) {
    const folderMatch = activeFolders.find(
      (f) => f.toLowerCase() === category.toLowerCase()
    );
    if (!folderMatch) continue;
    let score = 0;
    const overlap = [];
    for (const concept of concepts) {
      if (concept.length >= 3 && allApiWords.has(concept.toLowerCase())) {
        overlap.push(concept);
        const freq = conceptFreq[concept.toLowerCase()] || 1;
        score += 1 / freq;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestOverlap = overlap.length;
      bestFolder = folderMatch;
      bestOverlapWords = overlap;
    }
  }
  if (!bestFolder || bestOverlap < INTERNET_RETRY_MIN_OVERLAP) return null;
  try {
    const datamuseStopWords = /* @__PURE__ */ new Set([
      "the",
      "and",
      "for",
      "with",
      "from",
      "this",
      "that",
      "have",
      "will",
      "your",
      "they",
      "been",
      "were",
      "are",
      "its",
      "has",
      "but",
      "not"
    ]);
    const candidateConcepts = [...allApiWords].filter(
      (w) => w.length >= 4 && !datamuseStopWords.has(w.toLowerCase())
    );
    const added = (0, import_universal_pool_manager.addTermsToPool)(candidateConcepts.slice(0, 30), bestFolder, targetDir);
    if (added > 0) {
      console.log(`[Classification] INTERNET RETRY: added ${added} validated concepts to "${bestFolder}" pool`);
    }
  } catch {
  }
  const reasoning = `INTERNET RETRY: nouns [${nouns.join(", ")}] \u2192 Datamuse \u2192 ${bestOverlap} overlap(s) with "${bestFolder}": [${bestOverlapWords.slice(0, 5).join(", ")}]`;
  console.log(`[Classification] ${reasoning}`);
  return {
    category: bestFolder,
    confidence: INTERNET_RETRY_CONFIDENCE,
    reasoning,
    isNewFolder: false,
    detected_concepts: bestOverlapWords.slice(0, 5),
    concept_abstraction: `Internet retry match \u2014 routed to "${bestFolder}"`,
    requires_review: false,
    was_noise_penalized: false,
    global_domain: "",
    global_subdomain: "",
    suggested_path: "",
    match_level: "pool"
  };
}
const DEEP_LINK_CONFIDENCE = 62;
const DEEP_LINK_MIN_OVERLAP = 2;
async function tryDeepLinkMatch(filename, fileContent, activeFolders, targetDir) {
  const pool = readMergedPool(targetDir);
  if (activeFolders.length === 0) return null;
  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent ?? "";
  const nouns = extractNouns(nameNoExt + " " + contentHead, 5);
  if (nouns.length === 0) return null;
  console.log(`[Classification] DEEP LINK MATCH: reverse-querying Datamuse for nouns [${nouns.join(", ")}]`);
  const apiResults = await Promise.all(nouns.map(fetchDatamuseForTerm));
  const allApiWords = new Set(apiResults.flat().map((w) => w.toLowerCase()));
  if (allApiWords.size === 0) return null;
  const conceptFreq = {};
  for (const cats of Object.values(pool)) {
    for (const c of cats) {
      const k = c.toLowerCase();
      conceptFreq[k] = (conceptFreq[k] || 0) + 1;
    }
  }
  let bestFolder = null;
  let bestScore = 0;
  let bestEvidence = [];
  for (const folder of activeFolders) {
    if ((0, import_ContextService.isNoiseFolderName)(folder)) continue;
    let score = 0;
    const evidence = [];
    const nameWords = folder.toLowerCase().replace(/[-_]/g, " ").split(/\s+/).filter((w) => w.length >= 2);
    for (const nw of nameWords) {
      if (allApiWords.has(nw)) {
        score += 3;
        evidence.push(`name:"${nw}"`);
      }
    }
    const concepts = pool[folder] || [];
    for (const concept of concepts) {
      if (concept.length >= 3 && allApiWords.has(concept.toLowerCase())) {
        const freq = conceptFreq[concept.toLowerCase()] || 1;
        score += 1 / freq;
        evidence.push(concept);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestFolder = folder;
      bestEvidence = evidence;
    }
  }
  if (!bestFolder || bestScore < DEEP_LINK_MIN_OVERLAP) return null;
  try {
    const datamuseStopWords = /* @__PURE__ */ new Set([
      "the",
      "and",
      "for",
      "with",
      "from",
      "this",
      "that",
      "have",
      "will",
      "your",
      "they",
      "been",
      "were",
      "are",
      "its",
      "has",
      "but",
      "not"
    ]);
    const candidateConcepts = [...allApiWords].filter(
      (w) => w.length >= 4 && !datamuseStopWords.has(w.toLowerCase())
    );
    const added = (0, import_universal_pool_manager.addTermsToPool)(candidateConcepts.slice(0, 25), bestFolder, targetDir);
    if (added > 0) {
      console.log(`[Classification] DEEP LINK: added ${added} validated concepts to "${bestFolder}" pool`);
    }
  } catch {
  }
  const reasoning = `DEEP LINK MATCH: nouns [${nouns.join(", ")}] \u2192 Datamuse reverse lookup \u2192 matched "${bestFolder}" (score=${bestScore}): [${bestEvidence.slice(0, 6).join(", ")}]`;
  console.log(`[Classification] ${reasoning}`);
  return {
    category: bestFolder,
    confidence: DEEP_LINK_CONFIDENCE,
    reasoning,
    isNewFolder: false,
    detected_concepts: bestEvidence.slice(0, 5),
    concept_abstraction: `Deep Link reverse match \u2014 routed to "${bestFolder}"`,
    requires_review: false,
    was_noise_penalized: false,
    global_domain: "",
    global_subdomain: "",
    suggested_path: "",
    match_level: "pool"
  };
}
const ENTITY_RECOGNITION_CONFIDENCE = 68;
const ENTITY_MIN_POOL_OVERLAP = 2;
function extractEntities(text) {
  if (!text) return [];
  const matches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
  const acronyms = text.match(/\b[A-Z]{2,}\b/g) || [];
  const commonPhrases = /* @__PURE__ */ new Set(["The", "This", "That", "These", "Those", "United States"]);
  const entities = [.../* @__PURE__ */ new Set([...matches, ...acronyms])].filter((e) => !commonPhrases.has(e) && e.length >= 3).slice(0, 5);
  return entities;
}
function fetchEntitySummary(entity) {
  const https = require("https");
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(entity.replace(/\s+/g, "_"));
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`;
    https.get(url, { headers: { "User-Agent": "AIOrganizer/1.0" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const extract = parsed.extract || "";
          const words = extract.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !CLASSIFY_STOP_WORDS.has(w));
          resolve([...new Set(words)]);
        } catch {
          resolve([]);
        }
      });
      res.on("error", () => resolve([]));
    }).on("error", () => resolve([]));
  });
}
async function tryEntityRecognition(filename, fileContent, activeFolders, targetDir) {
  const pool = readMergedPool(targetDir);
  if (Object.keys(pool).length === 0) return null;
  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent ?? "";
  const entities = extractEntities(nameNoExt + " " + contentHead);
  if (entities.length === 0) return null;
  console.log(`[Classification] ENTITY RECOGNITION: found entities [${entities.join(", ")}]`);
  const summaryResults = await Promise.all(entities.map(fetchEntitySummary));
  const allSummaryWords = new Set(summaryResults.flat());
  if (allSummaryWords.size === 0) return null;
  const conceptFreq = {};
  for (const cats of Object.values(pool)) {
    for (const c of cats) {
      const k = c.toLowerCase();
      conceptFreq[k] = (conceptFreq[k] || 0) + 1;
    }
  }
  let bestFolder = null;
  let bestOverlap = 0;
  let bestScore = 0;
  let bestEvidence = [];
  for (const [category, concepts] of Object.entries(pool)) {
    const folderMatch = activeFolders.find(
      (f) => f.toLowerCase() === category.toLowerCase()
    );
    if (!folderMatch) continue;
    let score = 0;
    const overlap = [];
    for (const concept of concepts) {
      if (concept.length >= 3 && allSummaryWords.has(concept.toLowerCase())) {
        overlap.push(concept);
        const freq = conceptFreq[concept.toLowerCase()] || 1;
        score += 1 / freq;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestOverlap = overlap.length;
      bestFolder = folderMatch;
      bestEvidence = overlap;
    }
  }
  if (!bestFolder || bestOverlap < ENTITY_MIN_POOL_OVERLAP) return null;
  const reasoning = `ENTITY RECOGNITION: entities [${entities.join(", ")}] \u2192 Wikipedia \u2192 ${bestOverlap} pool overlap(s) with "${bestFolder}": [${bestEvidence.slice(0, 5).join(", ")}]`;
  console.log(`[Classification] ${reasoning}`);
  return {
    category: bestFolder,
    confidence: ENTITY_RECOGNITION_CONFIDENCE,
    reasoning,
    isNewFolder: false,
    detected_concepts: bestEvidence.slice(0, 5),
    concept_abstraction: `Historical Entity Match \u2014 routed to "${bestFolder}"`,
    requires_review: false,
    was_noise_penalized: false,
    global_domain: "",
    global_subdomain: "",
    suggested_path: "",
    match_level: "pool"
  };
}
const CONFLICT_THRESHOLD = 70;
const DENSITY_MIN_PERCENT = 5;
const SUBSET_OVERLAP_THRESHOLD = 0.5;
function scoreAllPoolCategories(filename, fileContent, activeFolders, targetDir) {
  const pool = readMergedPool(targetDir);
  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const contentHead = fileContent ?? "";
  const searchText = (nameNoExt + " " + contentHead).toLowerCase();
  const totalWords = searchText.split(/\s+/).filter((w) => w.length >= 2).length;
  if (searchText.length < 10 || totalWords < 3) return [];
  const conceptFreq = {};
  for (const cats of Object.values(pool)) {
    for (const c of cats) {
      const k = c.toLowerCase();
      conceptFreq[k] = (conceptFreq[k] || 0) + 1;
    }
  }
  const scores = [];
  for (const [category, concepts] of Object.entries(pool)) {
    const folderMatch = activeFolders.find(
      (f) => f.toLowerCase() === category.toLowerCase()
    );
    if (!folderMatch) continue;
    let score = 0;
    const matched = [];
    for (const concept of concepts) {
      if (concept.length >= 3 && searchText.includes(concept.toLowerCase())) {
        matched.push(concept);
        const freq = conceptFreq[concept.toLowerCase()] || 1;
        score += 1 / freq;
      }
    }
    if (matched.length < POOL_MIN_HITS) continue;
    const categoryConceptCount = concepts.length;
    if (categoryConceptCount === 0) continue;
    const density = matched.length / categoryConceptCount * 100;
    if (density < DENSITY_MIN_PERCENT) {
      console.log(
        `[Classification] DENSITY DROP: "${folderMatch}" density ${density.toFixed(1)}% (${matched.length}/${categoryConceptCount} concepts) < ${DENSITY_MIN_PERCENT}% \u2014 ignored as brief mention`
      );
      continue;
    }
    scores.push({
      folder: folderMatch,
      hits: score,
      confidence: scalePoolConfidence(matched.length),
      matched,
      density
    });
  }
  scores.sort((a, b) => b.hits - a.hits || b.confidence - a.confidence);
  return scores;
}
function isSubsetOf(matchedKeywordsA, poolConceptsB) {
  if (matchedKeywordsA.length === 0) return false;
  const poolSetB = new Set(poolConceptsB.map((c) => c.toLowerCase()));
  let overlapCount = 0;
  for (const kw of matchedKeywordsA) {
    if (poolSetB.has(kw.toLowerCase())) overlapCount++;
  }
  return overlapCount / matchedKeywordsA.length >= SUBSET_OVERLAP_THRESHOLD;
}
function readPriorityRulesFile(targetDir) {
  const rulesPath = import_path.default.join(targetDir, "priority_rules.json");
  try {
    if (import_fs.default.existsSync(rulesPath)) {
      return JSON.parse(import_fs.default.readFileSync(rulesPath, "utf-8"));
    }
  } catch {
  }
  return [];
}
function detectPoolConflicts(filename, fileContent, activeFolders, targetDir) {
  const allScores = scoreAllPoolCategories(filename, fileContent, activeFolders, targetDir);
  if (allScores.length < 2) return null;
  const strongCategories = allScores.filter((s) => s.confidence >= CONFLICT_THRESHOLD);
  if (strongCategories.length < 2) return null;
  const pool = readMergedPool(targetDir);
  for (let i = 0; i < strongCategories.length; i++) {
    for (let j = i + 1; j < strongCategories.length; j++) {
      const catA = strongCategories[i];
      const catB = strongCategories[j];
      const poolA = pool[catA.folder] || [];
      const poolB = pool[catB.folder] || [];
      const aInsideB = isSubsetOf(catA.matched, poolB);
      const bInsideA = isSubsetOf(catB.matched, poolA);
      if (aInsideB && !bInsideA) {
        const reasoning2 = `SPECIFICITY OVERRIDE: "${catA.folder}" keywords found inside "${catB.folder}" pool \u2192 "${catB.folder}" wins (Specific beats General). Density: ${catA.folder}=${catA.density.toFixed(1)}%, ${catB.folder}=${catB.density.toFixed(1)}%`;
        console.log(`[Classification] ${reasoning2}`);
        return {
          category: catB.folder,
          confidence: catB.confidence,
          reasoning: reasoning2,
          isNewFolder: false,
          detected_concepts: catB.matched.slice(0, 5),
          concept_abstraction: `Specificity override \u2014 "${catB.folder}" is more specific than "${catA.folder}"`,
          requires_review: false,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: "pool"
        };
      }
      if (bInsideA && !aInsideB) {
        const reasoning2 = `SPECIFICITY OVERRIDE: "${catB.folder}" keywords found inside "${catA.folder}" pool \u2192 "${catA.folder}" wins (Specific beats General). Density: ${catA.folder}=${catA.density.toFixed(1)}%, ${catB.folder}=${catB.density.toFixed(1)}%`;
        console.log(`[Classification] ${reasoning2}`);
        return {
          category: catA.folder,
          confidence: catA.confidence,
          reasoning: reasoning2,
          isNewFolder: false,
          detected_concepts: catA.matched.slice(0, 5),
          concept_abstraction: `Specificity override \u2014 "${catA.folder}" is more specific than "${catB.folder}"`,
          requires_review: false,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: "pool"
        };
      }
    }
  }
  const conflictNames = strongCategories.map((s) => s.folder);
  console.log(
    `[Classification] TRUE CONFLICT CANDIDATE: ${conflictNames.join(" vs ")} (${strongCategories.map((s) => `${s.folder}=${s.confidence}% density=${s.density.toFixed(1)}%`).join(", ")})`
  );
  const rules = readPriorityRulesFile(targetDir);
  for (const rule of rules) {
    const ruleSet = new Set(rule.conflictCategories.map((c) => c.toLowerCase()));
    const conflictSet = new Set(conflictNames.map((c) => c.toLowerCase()));
    const isMatch = [...conflictSet].every((c) => ruleSet.has(c));
    if (isMatch && conflictNames.map((c) => c.toLowerCase()).includes(rule.winner.toLowerCase())) {
      const actualWinner = activeFolders.find(
        (f) => f.toLowerCase() === rule.winner.toLowerCase()
      ) || rule.winner;
      const winnerScore = strongCategories.find(
        (s) => s.folder.toLowerCase() === rule.winner.toLowerCase()
      );
      const reasoning2 = `PRIORITY RULE: conflict [${conflictNames.join(" vs ")}] auto-resolved \u2192 "${actualWinner}" (saved rule from previous correction)`;
      console.log(`[Classification] ${reasoning2}`);
      return {
        category: actualWinner,
        confidence: winnerScore?.confidence || 80,
        reasoning: reasoning2,
        isNewFolder: false,
        detected_concepts: winnerScore?.matched.slice(0, 5) || [],
        concept_abstraction: `Priority rule resolved conflict \u2014 routed to "${actualWinner}"`,
        requires_review: false,
        was_noise_penalized: false,
        global_domain: "",
        global_subdomain: "",
        suggested_path: "",
        match_level: "pool"
      };
    }
  }
  const reasoning = `TRUE CONFLICT: ${conflictNames.join(" vs ")} both scored >=${CONFLICT_THRESHOLD}%, neither is a sub-topic of the other. Scores: ${strongCategories.map((s) => `${s.folder}=${s.confidence}% (density ${s.density.toFixed(1)}%)`).join(", ")}. Routed to Needs Review for manual resolution.`;
  console.log(`[Classification] ${reasoning}`);
  return {
    category: "Needs Review",
    confidence: 0,
    reasoning,
    isNewFolder: false,
    detected_concepts: strongCategories[0].matched.slice(0, 5),
    concept_abstraction: `True Conflict \u2014 ${conflictNames.join(" vs ")}`,
    requires_review: true,
    was_noise_penalized: false,
    global_domain: "",
    global_subdomain: "",
    suggested_path: "",
    match_level: "fallback",
    conflict_categories: conflictNames
  };
}
const SIBLING_TIME_WINDOW_MS = 48 * 60 * 60 * 1e3;
const SIBLING_MIN_COUNT = 2;
const SIBLING_MIN_CONFIDENCE = 80;
const SIBLING_BOOST = 40;
function extractNamingPattern(filename) {
  const nameNoExt = filename.replace(/\.[^.]+$/, "");
  const sequenceMatch = nameNoExt.match(
    /^(.*?)\s*(?:chapter|unit|week|lecture|module|part|section|lesson|period|lab)\s*(?:\d+|[IVX]+)/i
  );
  if (sequenceMatch) {
    const prefix = sequenceMatch[1].trim();
    const afterNum = nameNoExt.replace(sequenceMatch[0], "").trim();
    const combined = [prefix, afterNum].filter((s) => s.length >= 2).join(" ").trim();
    if (combined.length >= 3) return combined;
  }
  const numberedMatch = nameNoExt.match(/^(.+?)\s+\d+\s*$/);
  if (numberedMatch && numberedMatch[1].trim().length >= 4) {
    return numberedMatch[1].trim();
  }
  const words = nameNoExt.replace(/\d+/g, "").replace(/[-_]/g, " ").split(/\s+/).filter((w) => w.length >= 3);
  if (words.length >= 2) return words.slice(0, 3).join(" ");
  return null;
}
async function trySiblingSignal(filename, filePath, activeFolders) {
  const searchFn = getIndexSearch();
  if (!searchFn) return null;
  const pattern = extractNamingPattern(filename);
  if (!pattern) return null;
  const ext = import_path.default.extname(filename).toLowerCase();
  let currentMtime = Date.now();
  try {
    const stat = import_fs.default.statSync(filePath);
    currentMtime = stat.mtimeMs;
  } catch {
  }
  let results = [];
  try {
    results = searchFn(pattern, 30);
  } catch {
    return null;
  }
  const siblings = results.filter((r) => {
    if (import_path.default.extname(r.filename).toLowerCase() !== ext) return false;
    if ((0, import_ContextService.isNoiseFolderName)(r.folder)) return false;
    if (!activeFolders.some((f) => f.toLowerCase() === r.folder.toLowerCase())) return false;
    const timeDiff = Math.abs(r.timestamp - currentMtime);
    return timeDiff <= SIBLING_TIME_WINDOW_MS;
  });
  if (siblings.length < SIBLING_MIN_COUNT) return null;
  const folderCounts = {};
  for (const s of siblings) {
    const folderKey = s.folder.toLowerCase();
    folderCounts[folderKey] = (folderCounts[folderKey] || 0) + 1;
  }
  const best = Object.entries(folderCounts).sort(([, a], [, b]) => b - a)[0];
  if (!best || best[1] < SIBLING_MIN_COUNT) return null;
  const actualFolder = activeFolders.find((f) => f.toLowerCase() === best[0]);
  if (!actualFolder) return null;
  console.log(
    `[Classification] Sibling signal: ${best[1]} similar files already in "${actualFolder}" \u2014 boosting confidence`
  );
  return { folder: actualFolder, boost: SIBLING_BOOST, count: best[1] };
}
async function classifyGlobalDomain(filename, extension, fileContent) {
  const domainList = Object.entries(GLOBAL_DOMAINS).map(([name, cfg]) => `- ${name}: ${cfg.examples}`).join("\n");
  const contentPreview = fileContent ? fileContent.split(/\s+/).slice(0, DOMAIN_CLASSIFIER_WORDS).join(" ") : "";
  const prompt = [
    "Classify this document into exactly ONE domain and identify its specific sub-topic.",
    "",
    "DOMAINS:",
    domainList,
    "",
    `Filename: ${filename}`,
    extension ? `Type: ${extension}` : "",
    "",
    contentPreview ? `CONTENT (first ${DOMAIN_CLASSIFIER_WORDS} words):
${contentPreview}` : "No content available. Classify by filename only.",
    "",
    "Respond with ONLY valid JSON:",
    '{"domain": "Education", "subdomain": "US History", "confidence": 85}',
    "",
    "Rules:",
    "- Pick exactly ONE domain from the list above.",
    '- subdomain: Be as SPECIFIC as possible. "AP US History" is better than "History".',
    '  "Tax Returns" is better than "Finance". "AP Seminar" is better than "School".',
    "- confidence: 0-100. How clearly does this content fit the domain?"
  ].join("\n");
  try {
    const raw = await callOllama("", prompt, {
      numCtx: 2048,
      timeout: 3e4
    });
    let cleaned = raw.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];
    const parsed = JSON.parse(cleaned);
    const rawDomain = String(parsed.domain || "").trim();
    const subdomain = String(parsed.subdomain || "").trim();
    const confidence = Math.min(100, Math.max(0, Number(parsed.confidence) || 0));
    const domain = Object.keys(GLOBAL_DOMAINS).find(
      (d) => d.toLowerCase() === rawDomain.toLowerCase()
    ) || "";
    if (domain) {
      console.log(
        `[Classification] STEP 2a \u2014 Global domain: ${domain} / ${subdomain} (${confidence}%)`
      );
      return { domain, subdomain, confidence };
    }
    console.warn(`[Classification] STEP 2a \u2014 Unrecognised domain "${rawDomain}"`);
    return null;
  } catch (err) {
    console.warn(`[Classification] STEP 2a \u2014 Global domain call failed: ${err}`);
    return null;
  }
}
function normForDedup(name) {
  return name.toLowerCase().replace(/[-_\s+.]/g, "").replace(/\b(pre)\b/g, "pre");
}
const COMMON_ABBREVS = [
  [/calculus$/i, "calc"],
  [/precalculus$/i, "precalc"],
  [/biology$/i, "bio"],
  [/chemistry$/i, "chem"],
  [/physics$/i, "phys"],
  [/statistics$/i, "stats"],
  [/psychology$/i, "psych"],
  [/economics$/i, "econ"],
  [/government$/i, "gov"],
  [/geography$/i, "geo"],
  [/literature$/i, "lit"],
  [/philosophy$/i, "phil"],
  [/sociology$/i, "soc"],
  [/technology$/i, "tech"],
  [/engineering$/i, "eng"],
  [/trigonometry$/i, "trig"],
  [/environmental$/i, "enviro"],
  [/^bio$/i, "biology"],
  [/^chem$/i, "chemistry"],
  [/^calc$/i, "calculus"],
  [/^precalc$/i, "precalculus"],
  [/^stats$/i, "statistics"],
  [/^psych$/i, "psychology"],
  [/^econ$/i, "economics"],
  [/^gov$/i, "government"],
  [/^geo$/i, "geography"],
  [/^lit$/i, "literature"],
  [/^phil$/i, "philosophy"],
  [/^trig$/i, "trigonometry"],
  [/^phys$/i, "physics"],
  [/^eng$/i, "engineering"]
];
function getNameVariants(name) {
  const norm = normForDedup(name);
  const variants = /* @__PURE__ */ new Set([norm]);
  for (const [pattern, replacement] of COMMON_ABBREVS) {
    if (pattern.test(norm)) {
      variants.add(normForDedup(norm.replace(pattern, replacement)));
    }
  }
  return variants;
}
function findExistingEquivalent(suggestedName, existingFolders) {
  if (!suggestedName || existingFolders.length === 0) return null;
  const sugNorm = normForDedup(suggestedName);
  const sugVariants = getNameVariants(suggestedName);
  for (const folder of existingFolders) {
    const folderNorm = normForDedup(folder);
    if (sugNorm === folderNorm) return folder;
    const folderVariants = getNameVariants(folder);
    for (const sv of sugVariants) {
      if (folderVariants.has(sv)) return folder;
    }
    if (sugNorm.length >= 3 && folderNorm.length >= 3) {
      if (sugNorm.includes(folderNorm) || folderNorm.includes(sugNorm)) {
        const shorter = Math.min(sugNorm.length, folderNorm.length);
        const longer = Math.max(sugNorm.length, folderNorm.length);
        if (shorter / longer >= 0.6) return folder;
      }
    }
  }
  return null;
}
function sanitizeFolderName(name) {
  return name.replace(/[<>:"|?*\x00-\x1f]/g, "").replace(/^\.+/, "").trim().slice(0, 40) || "Misc";
}
function buildSuggestedPath(globalDomain, validFolders, aiSuggestedName) {
  if (aiSuggestedName.includes("/")) {
    return aiSuggestedName.split("/").map(sanitizeFolderName).join("/");
  }
  if (!globalDomain?.domain) {
    return sanitizeFolderName(aiSuggestedName);
  }
  const domainCfg = GLOBAL_DOMAINS[globalDomain.domain];
  if (!domainCfg) return sanitizeFolderName(aiSuggestedName);
  const child = sanitizeFolderName(
    aiSuggestedName || globalDomain.subdomain || globalDomain.domain
  );
  for (const hint of domainCfg.folderHints) {
    const existing = validFolders.find(
      (f) => f.toLowerCase() === hint.toLowerCase()
    );
    if (existing) return `${existing}/${child}`;
  }
  return `${domainCfg.folderHints[0]}/${child}`;
}
function buildSystemPrompt(folderContextMap, globalDomain, folderNames, currentFilename, currentExtension) {
  const learningBlock = (0, import_LearningService.buildLearningBlock)(currentFilename, currentExtension);
  const domainActive = globalDomain !== null && globalDomain.confidence >= DOMAIN_CONFIDENCE_THRESHOLD;
  const folderDescriptions = [];
  let folderCount = 0;
  for (const [folderName, context] of Object.entries(folderContextMap)) {
    if (context.isNoiseFolder) continue;
    folderCount++;
    const lines = [`  \u{1F4C1} ${folderName}`];
    const folderNameWords = folderName.split(/[\s_-]+/).filter((w) => w.length >= 3).map((w) => w.toLowerCase());
    const combinedKw = context.autoKeywords ? `${folderNameWords.join(", ")}, ${context.autoKeywords}` : folderNameWords.join(", ");
    lines.push(`     Keywords: [${combinedKw}]`);
    if (context.coreTopics) {
      lines.push(`     \u2B50 Core Topics: ${context.coreTopics}`);
    }
    folderDescriptions.push(lines.join("\n"));
  }
  const parts = [];
  if (domainActive) {
    parts.push(
      "\u2500\u2500 UNIVERSAL CLASSIFICATION (Pre-Analysis) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
      "The Universal Topic Router has pre-classified this document:",
      `  Domain:     ${globalDomain.domain}`,
      `  Sub-topic:  ${globalDomain.subdomain}`,
      `  Confidence: ${globalDomain.confidence}%`,
      "",
      "DOMAIN-AWARE RULES:",
      `- This is a ${globalDomain.domain} document about "${globalDomain.subdomain}".`,
      `- STRONGLY prefer folders whose keywords or Core Topics relate to ${globalDomain.domain.toLowerCase()}.`,
      "- Do NOT match to generic catch-all folders (Archives, Misc, Documents, Old, etc.).",
      `- If no existing folder covers "${globalDomain.subdomain}", you MUST set isNewFolder: true`,
      "  and suggest a specific, descriptive folder name \u2014 not a generic one.",
      '- ALWAYS provide suggested_path in "Parent/Child" format',
      '  (e.g., "Math/Calculus", "Science/Chemistry", "History/APUSH", "Finance/Taxes").',
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
      ""
    );
  }
  if (folderNames && folderNames.length > 0) {
    const nonNoise = folderNames.filter((f) => !(0, import_ContextService.isNoiseFolderName)(f));
    parts.push(
      `AVAILABLE CATEGORIES (exact names): ${nonNoise.join(", ")}`,
      "You MUST pick from this list unless none fit. Only suggest a new folder if no category above applies.",
      ""
    );
  }
  parts.push(
    "You are an Expert Librarian AI. Your job is to file documents into the correct folder",
    "by understanding the ABSTRACT IDEAS in the text, not by matching surface keywords.",
    "",
    "PREFER the MOST SPECIFIC folder. 'AP Seminar' is better than 'School'.",
    "'Tax Returns' is better than 'Finance'. Match to the NARROWEST topic that fits.",
    "",
    `AVAILABLE FOLDERS (${folderCount} topic folders):`,
    "",
    "Each folder has Keywords (extracted from existing files) and optional Core Topics",
    "(user-defined semantic aliases). Core Topics are AUTHORITATIVE \u2014 trust them over keywords.",
    "",
    folderDescriptions.join("\n\n"),
    ""
  );
  if (learningBlock) {
    parts.push(learningBlock, "");
  }
  parts.push(
    "TASK \u2014 Follow these steps IN ORDER:",
    "",
    "STEP 1 \u2014 ABSTRACT:",
    "  Read the document content carefully.",
    "  Identify the HIGH-LEVEL DOMAIN this document belongs to.",
    "  Write a single sentence describing what field/discipline this document is from.",
    "",
    "STEP 2 \u2014 CONCEPTUALIZE:",
    "  List exactly 3 abstract concepts/themes present in this document.",
    "  These should be domain-specific ideas, not generic words.",
    '  Good: "constitutional law", "cellular respiration", "market segmentation"',
    '  Bad: "document", "information", "file"',
    "",
    "STEP 3 \u2014 MAP:",
    "  Compare your concepts against EACH folder's Keywords and Core Topics.",
    "  \u2B50 Core Topics take PRIORITY \u2014 if a folder has Core Topics that match, it wins.",
    "  Look for SEMANTIC PROXIMITY, not just exact word matches.",
    "  CHECK THE MOST SPECIFIC FOLDERS FIRST \u2014 a precise match beats a vague one.",
    "",
    "STEP 4 \u2014 MATCH:",
    "  Pick the SINGLE folder whose domain best matches the document.",
    "  If NO existing folder covers this domain, suggest a new folder name (1-2 words)."
  );
  parts.push(
    "",
    "STEP 5 \u2014 HIERARCHY (ALWAYS required):",
    '  ALWAYS provide a suggested_path in "Parent/Child" format.',
    "  Use a BROAD parent category and a SPECIFIC child subcategory.",
    "  Common parent categories: Math, Science, History, English, CS, Business, Finance, Art, Music, Languages, Health, Engineering, Law, Personal",
    '  Examples: "Math/Precalculus", "Science/Biology", "History/APUSH", "CS/Python", "English/Essays", "Finance/Taxes"',
    "  If the file matches an existing folder that is ALREADY a child (e.g., 'Math/Precalculus'), use that exact path.",
    "  If the file matches a top-level folder (e.g., 'Precalculus'), place it under the correct parent (e.g., 'Math/Precalculus')."
  );
  parts.push(
    "",
    "OUTPUT \u2014 Respond with ONLY valid JSON:",
    "{",
    '  "concept_abstraction": "This document is from the field of X, specifically Y.",',
    '  "detected_concepts": ["concept1", "concept2", "concept3"],',
    `  "reasoning": "The document discusses X. This matches FolderName because its Core Topic 'Y' covers this domain.",`,
    '  "best_fit_folder": "FolderName",',
    '  "confidence": 0-100,',
    '  "isNewFolder": false,',
    '  "suggested_path": ""',
    "}",
    "",
    "RULES:",
    "- concept_abstraction: REQUIRED. A sentence describing the document's academic/professional field.",
    "- detected_concepts: EXACTLY 3 domain-specific themes.",
    "- reasoning: MUST reference specific Core Topics or Keywords that match.",
    "- confidence: 0-100. Above 80 = strong match. Below 60 = weak.",
    "- isNewFolder: true ONLY when no folder's domain overlaps.",
    "- When isNewFolder is true, best_fit_folder should be a concise name (1-2 words).",
    '- suggested_path: ALWAYS provide a "Parent/Child" path (e.g., "Math/Precalculus", "Science/Chemistry"). This is REQUIRED for every classification.',
    "- User's past corrections ALWAYS override your analysis.",
    "- Prefer EXISTING folders. Only suggest new ones for genuinely novel domains.",
    "- \u2B50 Core Topics are AUTHORITATIVE \u2014 trust them over auto-detected keywords.",
    "- \u26A0\uFE0F NEVER suggest a new folder that is a synonym, abbreviation, or variant of an existing one.",
    '  For example: if "PreCalc" exists, do NOT suggest "Precalculus", "Pre-Calculus", or "Pre Calc".',
    '  If "Bio" exists, do NOT suggest "Biology". If "Stats" exists, do NOT suggest "Statistics".',
    "  ALWAYS use the existing folder name even if the new name seems more descriptive."
  );
  return parts.join("\n");
}
function buildUserMessage(filename, extension, fileContent) {
  const lines = ["Classify this file.", "", `Filename: ${filename}`];
  if (extension) lines.push(`Type: ${extension}`);
  if (fileContent) {
    const allWords = fileContent.split(/\s+/).filter((w) => w.length > 0);
    const wc = allWords.length;
    const limited = wc > MAX_OLLAMA_CONTENT_WORDS ? allWords.slice(0, MAX_OLLAMA_CONTENT_WORDS).join(" ") + ` [first ${MAX_OLLAMA_CONTENT_WORDS} of ${wc} words shown]` : fileContent;
    lines.push("", `FILE CONTENT (${Math.min(wc, MAX_OLLAMA_CONTENT_WORDS)} words):`, limited);
  } else {
    lines.push(
      "",
      "No readable content available. Classify based on the filename, file type,",
      "and the folder fingerprints only."
    );
  }
  return lines.join("\n");
}
function buildClassificationPromptV2(activeFolders, fileContent, filename, targetDir, globalDomain) {
  const nonNoiseFolders = activeFolders.filter((f) => !(0, import_ContextService.isNoiseFolderName)(f));
  const folderLines = nonNoiseFolders.map((folder) => {
    let terms = [];
    try {
      terms = (0, import_universal_pool_manager.getTopDistinctiveTerms)(folder, targetDir, 5);
    } catch {
    }
    const termStr = terms.length > 0 ? `: ${terms.join(", ")}` : "";
    return `  - ${folder}${termStr}`;
  });
  const allWords = fileContent.split(/\s+/).filter((w) => w.length > 0);
  const limitedContent = allWords.length > MAX_OLLAMA_CONTENT_WORDS ? allWords.slice(0, MAX_OLLAMA_CONTENT_WORDS).join(" ") : fileContent;
  const domainHint = globalDomain && globalDomain.confidence >= DOMAIN_CONFIDENCE_THRESHOLD ? `
DOCUMENT DOMAIN (pre-classified): ${globalDomain.domain} / ${globalDomain.subdomain} (${globalDomain.confidence}% confidence)
` : "";
  return [
    "You are a precise file classifier. Your job is to read this document's content",
    "and determine which folder it belongs in.",
    "",
    "AVAILABLE FOLDERS:",
    ...folderLines,
    "",
    `FILENAME: ${filename}`,
    domainHint,
    "DOCUMENT CONTENT:",
    limitedContent || "(no readable content \u2014 classify by filename and folder list only)",
    "",
    "INSTRUCTIONS:",
    "Step 1 \u2014 List the 3 most subject-specific terms or phrases you found in the content",
    "         (not generic words like 'chapter', 'the', 'notes', 'document').",
    "Step 2 \u2014 Based on those terms, which folder from the list above matches best and why?",
    "Step 3 \u2014 How confident are you as a percentage (0-100)?",
    "",
    "If the content gives you genuinely no signal, say CONFIDENCE: 0.",
    "Do not guess. A wrong answer is worse than sending to review.",
    "You MUST pick a folder from the AVAILABLE FOLDERS list above.",
    "",
    "Reply in this EXACT format (nothing else):",
    "TERMS: [term1], [term2], [term3]",
    "FOLDER: [exact folder name from the list]",
    "CONFIDENCE: [number 0-100]",
    "REASON: [one sentence]"
  ].join("\n");
}
function parseClassificationResponseV2(raw, activeFolders) {
  const termsM = raw.match(/TERMS\s*:\s*(.+)/i);
  const folderM = raw.match(/FOLDER\s*:\s*(.+)/i);
  const confM = raw.match(/CONFIDENCE\s*:\s*(\d+)/i);
  const reasonM = raw.match(/REASON\s*:\s*(.+)/i);
  if (!folderM || !confM) return null;
  const folderRaw = folderM[1].trim().replace(/[\[\]]/g, "");
  const confidence = Math.min(100, Math.max(0, parseInt(confM[1], 10)));
  const terms = termsM ? termsM[1].replace(/[\[\]]/g, "").split(",").map((t) => t.trim()).filter((t) => t.length >= 2) : [];
  const reason = reasonM ? reasonM[1].trim() : "";
  const lower = folderRaw.toLowerCase();
  const resolved = activeFolders.find((f) => f.toLowerCase() === lower) || activeFolders.find((f) => f.toLowerCase().includes(lower) || lower.includes(f.toLowerCase())) || folderRaw;
  return { terms, folder: resolved, confidence, reason };
}
function applyMultiSignalConsensus(signals, baseResult, filename) {
  if (signals.length === 0) return baseResult;
  const breakdown = signals.map((s) => `${s.source}=${s.folder}(${s.confidence})`).join(", ");
  const folderVotes = {};
  for (const sig of signals) {
    const key = sig.folder.toLowerCase();
    if (!folderVotes[key]) folderVotes[key] = { totalConf: 0, count: 0 };
    folderVotes[key].totalConf += sig.confidence;
    folderVotes[key].count++;
  }
  const sorted = Object.entries(folderVotes).sort(([, a], [, b]) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.totalConf - a.totalConf;
  });
  const [topKey, topVotes] = sorted[0];
  const topFolder = signals.find((s) => s.folder.toLowerCase() === topKey)?.folder ?? topKey;
  const avgConf = Math.round(topVotes.totalConf / topVotes.count);
  const consensus = topVotes.count >= 2;
  if (consensus) {
    const finalConf = Math.min(100, avgConf + 5);
    console.log(
      `[Classification] Signals: ${breakdown} \u2192 CONSENSUS: ${topFolder}(${finalConf})`
    );
    return {
      ...baseResult,
      category: topFolder,
      confidence: finalConf,
      reasoning: baseResult.reasoning + ` [Consensus: ${topVotes.count} signals agree on "${topFolder}"]`,
      requires_review: finalConf < REVIEW_THRESHOLD
    };
  }
  const bestSignal = signals.reduce((a, b) => a.confidence >= b.confidence ? a : b);
  const penalisedConf = Math.max(0, bestSignal.confidence - 15);
  console.log(
    `[Classification] Signals: ${breakdown} \u2192 DISAGREEMENT: using ${bestSignal.source}=${bestSignal.folder}(${penalisedConf}) requires_review`
  );
  if (signals.length === 1 && bestSignal.source === "Ollama" && bestSignal.confidence < 75) {
    return {
      ...baseResult,
      category: "Needs Review",
      confidence: 0,
      reasoning: baseResult.reasoning + ` [Single weak Ollama signal (${bestSignal.confidence}%) \u2014 routed to Needs Review]`,
      requires_review: true,
      match_level: "fallback"
    };
  }
  return {
    ...baseResult,
    category: bestSignal.folder,
    confidence: penalisedConf,
    reasoning: baseResult.reasoning + ` [Signal disagreement: ${breakdown} \u2014 using highest-confidence signal, flagged for review]`,
    requires_review: true
  };
}
function parseResponse(raw, validFolders, globalDomain, fingerprints) {
  const gd = globalDomain?.domain || "";
  const gs = globalDomain?.subdomain || "";
  const domainActive = globalDomain !== null && globalDomain.confidence >= DOMAIN_CONFIDENCE_THRESHOLD;
  const sortedFolders = fingerprints ? sortBySpecificity(validFolders, fingerprints) : validFolders;
  function makeResult(base) {
    return {
      ...base,
      global_domain: gd,
      global_subdomain: gs,
      suggested_path: base.suggested_path ?? "",
      match_level: base.match_level ?? "specific"
    };
  }
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) cleaned = jsonMatch[0];
  try {
    const parsed = JSON.parse(cleaned);
    let confidence = Math.min(100, Math.max(0, Number(parsed.confidence) || 50));
    const reasoning = String(parsed.reasoning || "");
    const conceptAbstraction = String(parsed.concept_abstraction || "");
    const isNewFolder = Boolean(parsed.isNewFolder);
    let wasNoisePenalized = false;
    const aiSuggestedPath = String(parsed.suggested_path || "").trim();
    let detectedConcepts = [];
    if (Array.isArray(parsed.detected_concepts)) {
      detectedConcepts = parsed.detected_concepts.filter((c) => typeof c === "string").slice(0, 5).map((c) => c.trim());
    }
    const folderName = String(
      parsed.best_fit_folder || parsed.category || ""
    ).trim();
    if (folderName) {
      if (domainActive && gs) {
        const subWords = gs.toLowerCase().split(/\s+/);
        const folderWords = folderName.toLowerCase().split(/[\s_-]+/);
        const overlap = folderWords.filter(
          (w) => w.length >= 3 && subWords.some((sw) => sw.includes(w) || w.includes(sw))
        );
        if (overlap.length > 0) {
          const boost = Math.min(15, overlap.length * 5);
          confidence = Math.min(100, confidence + boost);
          console.log(
            `[Classification] Subject boost +${boost}% for "${folderName}" (subdomain overlap: ${overlap.join(", ")})`
          );
        }
      }
      if ((0, import_ContextService.isNoiseFolderName)(folderName) && domainActive) {
        const sugName = globalDomain.subdomain || folderName;
        const sugPath2 = aiSuggestedPath || buildSuggestedPath(globalDomain, sortedFolders, sugName);
        const leaf = sugPath2.includes("/") ? sanitizeFolderName(sugPath2.split("/").pop()) : sanitizeFolderName(sugName);
        console.log(
          `[Classification] DOMAIN OVERRIDE: "${folderName}" rejected \u2192 "${sugPath2}"`
        );
        return makeResult({
          category: leaf,
          confidence: Math.max(confidence - NOISE_FOLDER_PENALTY, 0),
          reasoning: reasoning + ` [Domain router overrode noise folder "${folderName}"]`,
          isNewFolder: true,
          detected_concepts: detectedConcepts,
          concept_abstraction: conceptAbstraction,
          requires_review: true,
          was_noise_penalized: true,
          suggested_path: sugPath2
        });
      }
      if ((0, import_ContextService.isNoiseFolderName)(folderName) && !domainActive) {
        console.log(
          `[Classification] NOISE PENALTY: "${folderName}" -${NOISE_FOLDER_PENALTY}%`
        );
        confidence = Math.max(0, confidence - NOISE_FOLDER_PENALTY);
        wasNoisePenalized = true;
      }
      const requiresReview = confidence < REVIEW_THRESHOLD;
      const sugPath = aiSuggestedPath || (domainActive ? buildSuggestedPath(globalDomain, sortedFolders, folderName) : "");
      if (isNewFolder) {
        const fullPathMatch = sugPath.includes("/") ? findExistingEquivalent(sugPath, sortedFolders) : null;
        if (fullPathMatch) {
          console.log(
            `[Classification] DEDUP: path "${sugPath}" \u2192 merged into existing "${fullPathMatch}"`
          );
          return makeResult({
            category: fullPathMatch,
            confidence: Math.min(100, confidence + 5),
            reasoning: reasoning + ` [Dedup: "${sugPath}" merged into existing "${fullPathMatch}"]`,
            isNewFolder: false,
            detected_concepts: detectedConcepts,
            concept_abstraction: conceptAbstraction,
            requires_review: requiresReview,
            was_noise_penalized: wasNoisePenalized,
            suggested_path: fullPathMatch
          });
        }
        const existingMatch = findExistingEquivalent(folderName, sortedFolders);
        if (existingMatch) {
          console.log(
            `[Classification] DEDUP: AI suggested new folder "${folderName}" \u2192 merged into existing "${existingMatch}"`
          );
          return makeResult({
            category: existingMatch,
            confidence: Math.min(100, confidence + 5),
            reasoning: reasoning + ` [Dedup: "${folderName}" merged into existing "${existingMatch}"]`,
            isNewFolder: false,
            detected_concepts: detectedConcepts,
            concept_abstraction: conceptAbstraction,
            requires_review: requiresReview,
            was_noise_penalized: wasNoisePenalized,
            suggested_path: existingMatch
          });
        }
        const leaf = sugPath.includes("/") ? sanitizeFolderName(sugPath.split("/").pop()) : sanitizeFolderName(folderName);
        const leafMatch = findExistingEquivalent(leaf, sortedFolders);
        if (leafMatch) {
          console.log(
            `[Classification] DEDUP: leaf "${leaf}" \u2192 merged into existing "${leafMatch}"`
          );
          return makeResult({
            category: leafMatch,
            confidence: Math.min(100, confidence + 5),
            reasoning: reasoning + ` [Dedup: "${leaf}" merged into existing "${leafMatch}"]`,
            isNewFolder: false,
            detected_concepts: detectedConcepts,
            concept_abstraction: conceptAbstraction,
            requires_review: requiresReview,
            was_noise_penalized: wasNoisePenalized,
            suggested_path: leafMatch
          });
        }
        const hierarchicalCategory = sugPath || leaf || "Miscellaneous";
        return makeResult({
          category: hierarchicalCategory,
          confidence,
          reasoning,
          isNewFolder: true,
          detected_concepts: detectedConcepts,
          concept_abstraction: conceptAbstraction,
          requires_review: requiresReview,
          was_noise_penalized: wasNoisePenalized,
          suggested_path: sugPath
        });
      }
      if (sortedFolders.includes(folderName)) {
        let resolvedCategory = folderName;
        if (sugPath && sugPath.includes("/") && sortedFolders.includes(sugPath)) {
          resolvedCategory = sugPath;
        } else {
          const hierarchicalMatch = sortedFolders.find(
            (f) => f.includes("/") && f.split("/").pop().toLowerCase() === folderName.toLowerCase()
          );
          if (hierarchicalMatch) resolvedCategory = hierarchicalMatch;
        }
        return makeResult({
          category: resolvedCategory,
          confidence,
          reasoning,
          isNewFolder: false,
          detected_concepts: detectedConcepts,
          concept_abstraction: conceptAbstraction,
          requires_review: requiresReview,
          was_noise_penalized: wasNoisePenalized,
          suggested_path: resolvedCategory.includes("/") ? resolvedCategory : sugPath
        });
      }
      const lower = folderName.toLowerCase();
      const ciMatch = sortedFolders.find((f) => f.toLowerCase() === lower);
      if (ciMatch) {
        if ((0, import_ContextService.isNoiseFolderName)(ciMatch) && domainActive) {
          const sugName = globalDomain.subdomain || folderName;
          const ciSugPath = buildSuggestedPath(globalDomain, sortedFolders, sugName);
          return makeResult({
            category: ciSugPath || sanitizeFolderName(sugName),
            confidence: Math.max(0, confidence - NOISE_FOLDER_PENALTY),
            reasoning: reasoning + ` [Domain router overrode "${ciMatch}"]`,
            isNewFolder: true,
            detected_concepts: detectedConcepts,
            concept_abstraction: conceptAbstraction,
            requires_review: true,
            was_noise_penalized: true,
            suggested_path: ciSugPath
          });
        }
        if ((0, import_ContextService.isNoiseFolderName)(ciMatch) && !wasNoisePenalized) {
          confidence = Math.max(0, confidence - NOISE_FOLDER_PENALTY);
          wasNoisePenalized = true;
        }
        let resolvedCI = ciMatch;
        const ciHierarchical = sortedFolders.find(
          (f) => f.includes("/") && f.split("/").pop().toLowerCase() === ciMatch.toLowerCase()
        );
        if (ciHierarchical) resolvedCI = ciHierarchical;
        return makeResult({
          category: resolvedCI,
          confidence,
          reasoning,
          isNewFolder: false,
          detected_concepts: detectedConcepts,
          concept_abstraction: conceptAbstraction,
          requires_review: confidence < REVIEW_THRESHOLD,
          was_noise_penalized: wasNoisePenalized,
          suggested_path: resolvedCI.includes("/") ? resolvedCI : sugPath
        });
      }
      const partial = sortedFolders.find(
        (f) => f.toLowerCase().includes(lower) || lower.includes(f.toLowerCase())
      );
      if (partial) {
        if ((0, import_ContextService.isNoiseFolderName)(partial) && domainActive) {
          const sugName = globalDomain.subdomain || folderName;
          const partialSugPath = buildSuggestedPath(globalDomain, sortedFolders, sugName);
          return makeResult({
            category: partialSugPath || sanitizeFolderName(sugName),
            confidence: Math.max(0, confidence - NOISE_FOLDER_PENALTY),
            reasoning: reasoning + ` [Domain router overrode "${partial}"]`,
            isNewFolder: true,
            detected_concepts: detectedConcepts,
            concept_abstraction: conceptAbstraction,
            requires_review: true,
            was_noise_penalized: true,
            suggested_path: partialSugPath
          });
        }
        let partialConf = Math.max(confidence - 10, 0);
        if ((0, import_ContextService.isNoiseFolderName)(partial)) {
          partialConf = Math.max(0, partialConf - NOISE_FOLDER_PENALTY);
          wasNoisePenalized = true;
        }
        let resolvedPartial = partial;
        const partialHierarchical = sortedFolders.find(
          (f) => f.includes("/") && f.split("/").pop().toLowerCase() === partial.toLowerCase()
        );
        if (partialHierarchical) resolvedPartial = partialHierarchical;
        return makeResult({
          category: resolvedPartial,
          confidence: partialConf,
          reasoning,
          isNewFolder: false,
          detected_concepts: detectedConcepts,
          concept_abstraction: conceptAbstraction,
          requires_review: partialConf < REVIEW_THRESHOLD,
          was_noise_penalized: wasNoisePenalized,
          suggested_path: resolvedPartial.includes("/") ? resolvedPartial : sugPath
        });
      }
      const fallbackPath = sugPath || (domainActive ? buildSuggestedPath(globalDomain, sortedFolders, folderName) : "");
      return makeResult({
        category: fallbackPath || sanitizeFolderName(folderName) || "Documents",
        confidence: Math.max(confidence - 20, 0),
        reasoning,
        isNewFolder: true,
        detected_concepts: detectedConcepts,
        concept_abstraction: conceptAbstraction,
        requires_review: true,
        was_noise_penalized: wasNoisePenalized,
        suggested_path: fallbackPath
      });
    }
  } catch {
  }
  for (const folder of sortedFolders) {
    if (raw.toLowerCase().includes(folder.toLowerCase())) {
      if ((0, import_ContextService.isNoiseFolderName)(folder) && domainActive) {
        const sugName = globalDomain.subdomain || "Misc";
        const sugPath = buildSuggestedPath(globalDomain, sortedFolders, sugName);
        return makeResult({
          category: sanitizeFolderName(sugName),
          confidence: 10,
          reasoning: `Domain router rejected noise folder "${folder}" from unparseable response`,
          isNewFolder: true,
          detected_concepts: [],
          concept_abstraction: "",
          requires_review: true,
          was_noise_penalized: true,
          suggested_path: sugPath
        });
      }
      let conf = 25;
      let penalized = false;
      if ((0, import_ContextService.isNoiseFolderName)(folder)) {
        conf = Math.max(0, conf - NOISE_FOLDER_PENALTY);
        penalized = true;
      }
      return makeResult({
        category: folder,
        confidence: conf,
        reasoning: "Extracted folder name from unparseable AI response",
        isNewFolder: false,
        detected_concepts: [],
        concept_abstraction: "",
        requires_review: true,
        was_noise_penalized: penalized
      });
    }
  }
  if (domainActive) {
    const sugName = globalDomain.subdomain || globalDomain.domain;
    const sugPath = buildSuggestedPath(globalDomain, sortedFolders, sugName);
    return makeResult({
      category: sanitizeFolderName(sugName),
      confidence: 20,
      reasoning: `Fallback \u2014 could not parse AI response. Domain: ${gd} / ${gs}.`,
      isNewFolder: true,
      detected_concepts: [],
      concept_abstraction: "",
      requires_review: true,
      was_noise_penalized: false,
      suggested_path: sugPath,
      match_level: "fallback"
    });
  }
  return makeResult({
    category: "Documents",
    confidence: 5,
    reasoning: "Fallback \u2014 could not parse AI response",
    isNewFolder: validFolders.length === 0,
    detected_concepts: [],
    concept_abstraction: "",
    requires_review: true,
    was_noise_penalized: false,
    match_level: "fallback"
  });
}
async function classifyFile(filePath, targetDir) {
  const [userFolders, rawFingerprints, folderContext, fileContent, fileMetadata] = await Promise.all([
    scanUserFolders(targetDir),
    (0, import_ContextService.getFolderContext)(targetDir),
    (0, import_ContextService.getFolderContextForPrompt)(targetDir),
    sampleFileContent(filePath),
    (0, import_TextExtractionService.extractMetadata)(filePath)
    // FIX 1: PDF/DOCX metadata signals
  ]);
  const filename = import_path.default.basename(filePath);
  const extension = import_path.default.extname(filePath).toLowerCase();
  {
    const filenamePlain = filename.toLowerCase().replace(/\.[^.]+$/, "").replace(/[-_\s+.]/g, "");
    for (const folder of userFolders) {
      if ((0, import_ContextService.isNoiseFolderName)(folder)) continue;
      const folderPlain = folder.toLowerCase().replace(/[-_\s+.]/g, "");
      if (folderPlain.length >= 4 && filenamePlain.includes(folderPlain)) {
        const preCheckResult = {
          category: folder,
          confidence: 100,
          reasoning: `FILENAME MATCH: folder name "${folder}" found verbatim in filename "${filename}"`,
          isNewFolder: false,
          detected_concepts: [folder],
          concept_abstraction: `Folder name found in filename`,
          requires_review: false,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: "bullseye"
        };
        logResult(filename, fileContent, preCheckResult);
        return preCheckResult;
      }
    }
  }
  {
    const historyBoost = (0, import_ConsistencyService.getHistoryBoost)(filename, userFolders);
    if (historyBoost) {
      const consistencyResult = {
        category: historyBoost.folder,
        confidence: historyBoost.confidence,
        reasoning: `HISTORY MATCH: class key "${historyBoost.matchedKey}" was previously classified to "${historyBoost.folder}" ${historyBoost.hitCount} time(s)`,
        isNewFolder: false,
        detected_concepts: [historyBoost.matchedKey],
        concept_abstraction: `History pattern match`,
        requires_review: false,
        was_noise_penalized: false,
        global_domain: "",
        global_subdomain: "",
        suggested_path: "",
        match_level: "bullseye"
      };
      logResult(filename, fileContent, consistencyResult);
      return consistencyResult;
    }
  }
  {
    const disambig = (0, import_accuracy_monitor.applyDisambiguationRules)(filename, fileContent);
    if (disambig && userFolders.some((f) => f.toLowerCase() === disambig.folder.toLowerCase())) {
      const actualFolder = userFolders.find((f) => f.toLowerCase() === disambig.folder.toLowerCase()) ?? disambig.folder;
      const disambigResult = {
        category: actualFolder,
        confidence: disambig.confidence,
        reasoning: `DISAMBIGUATION RULE: "${actualFolder}" matched ${disambig.rule.a_indicators.length + disambig.rule.b_indicators.length} exclusive indicators (auto-generated from confusion history)`,
        isNewFolder: false,
        detected_concepts: disambig.rule.a_indicators.slice(0, 5),
        concept_abstraction: `Disambiguation rule match`,
        requires_review: false,
        was_noise_penalized: false,
        global_domain: "",
        global_subdomain: "",
        suggested_path: "",
        match_level: "specific"
      };
      logResult(filename, fileContent, disambigResult);
      return disambigResult;
    }
  }
  let activeFolders = userFolders;
  const fileRecent = isFileRecent(filePath);
  if (fileRecent) {
    activeFolders = userFolders.filter((f) => !(0, import_ContextService.isNoiseFolderName)(f));
    const banned = userFolders.length - activeFolders.length;
    if (banned > 0) {
      console.log(
        `[Classification] ARCHIVES BAN: file <3 months old \u2014 ${banned} noise folder(s) disqualified`
      );
    }
  }
  if (fileMetadata) {
    const metaBullseye = tryMetadataBullseye(fileMetadata, activeFolders, rawFingerprints, filename);
    if (metaBullseye) {
      logResult(filename, fileContent, metaBullseye);
      return metaBullseye;
    }
  }
  const bullseye = tryBullseyeMatch(
    filename,
    fileContent,
    rawFingerprints,
    activeFolders
  );
  if (bullseye) {
    logResult(filename, fileContent, bullseye);
    return bullseye;
  }
  const keywordHit = tryKeywordMatch(filename, fileContent, activeFolders);
  if (keywordHit) {
    logResult(filename, fileContent, keywordHit);
    return keywordHit;
  }
  const smartHit = trySmartGroupMatch(filename, fileContent, activeFolders);
  if (smartHit) {
    logResult(filename, fileContent, smartHit);
    return smartHit;
  }
  const poolHit = tryPoolMatch(filename, fileContent, activeFolders, targetDir);
  if (poolHit) {
    const conflict = detectPoolConflicts(filename, fileContent, activeFolders, targetDir);
    if (conflict) {
      logResult(filename, fileContent, conflict);
      return conflict;
    }
    logResult(filename, fileContent, poolHit);
    return poolHit;
  }
  try {
    const internetHit = await tryInternetRetry(filename, fileContent, activeFolders, targetDir);
    if (internetHit) {
      logResult(filename, fileContent, internetHit);
      return internetHit;
    }
  } catch (err) {
    console.warn(`[Classification] Internet retry failed: ${err}`);
  }
  try {
    const deepLinkHit = await tryDeepLinkMatch(filename, fileContent, activeFolders, targetDir);
    if (deepLinkHit) {
      logResult(filename, fileContent, deepLinkHit);
      return deepLinkHit;
    }
  } catch (err) {
    console.warn(`[Classification] Deep Link Match failed: ${err}`);
  }
  try {
    const entityHit = await tryEntityRecognition(filename, fileContent, activeFolders, targetDir);
    if (entityHit) {
      logResult(filename, fileContent, entityHit);
      return entityHit;
    }
  } catch (err) {
    console.warn(`[Classification] Entity Recognition failed: ${err}`);
  }
  let siblingSignal = null;
  try {
    siblingSignal = await trySiblingSignal(filename, filePath, activeFolders);
  } catch (err) {
    console.warn(`[Classification] Sibling signal failed: ${err}`);
  }
  let globalDomain = null;
  try {
    globalDomain = await classifyGlobalDomain(filename, extension, fileContent);
  } catch {
  }
  const poolScores = scoreAllPoolCategories(filename, fileContent, activeFolders, targetDir);
  const poolSignal = poolScores.length > 0 ? { source: "Pool", folder: poolScores[0].folder, confidence: poolScores[0].confidence } : null;
  const v2Prompt = buildClassificationPromptV2(activeFolders, fileContent, filename, targetDir, globalDomain);
  try {
    const raw = await callOllama("", v2Prompt, { numCtx: 4096 });
    const v2parsed = parseClassificationResponseV2(raw, activeFolders);
    if (v2parsed && v2parsed.confidence === 0) {
      const noSignal = {
        category: "Needs Review",
        confidence: 0,
        reasoning: `Ollama v2: no signal detected \u2014 ${v2parsed.reason}`,
        isNewFolder: false,
        detected_concepts: v2parsed.terms,
        concept_abstraction: "",
        requires_review: true,
        was_noise_penalized: false,
        global_domain: globalDomain?.domain || "",
        global_subdomain: globalDomain?.subdomain || "",
        suggested_path: "",
        match_level: "fallback"
      };
      logResult(filename, fileContent, noSignal);
      return noSignal;
    }
    let result;
    if (v2parsed && v2parsed.folder) {
      if (v2parsed.terms.length > 0 && v2parsed.folder && !(0, import_ContextService.isNoiseFolderName)(v2parsed.folder)) {
        try {
          (0, import_universal_pool_manager.addTermsToPool)(v2parsed.terms, v2parsed.folder, targetDir);
        } catch {
        }
      }
      const resolvedFolder = activeFolders.find((f) => f.toLowerCase() === v2parsed.folder.toLowerCase()) || activeFolders.find((f) => f.toLowerCase().includes(v2parsed.folder.toLowerCase()) || v2parsed.folder.toLowerCase().includes(f.toLowerCase())) || null;
      const sugPath = resolvedFolder && globalDomain ? buildSuggestedPath(globalDomain, activeFolders, resolvedFolder) : "";
      result = {
        category: resolvedFolder || v2parsed.folder,
        confidence: v2parsed.confidence,
        reasoning: `AI v2 CoT: ${v2parsed.reason} [Terms: ${v2parsed.terms.join(", ")}]`,
        isNewFolder: !resolvedFolder,
        detected_concepts: v2parsed.terms,
        concept_abstraction: v2parsed.reason,
        requires_review: v2parsed.confidence < REVIEW_THRESHOLD,
        was_noise_penalized: false,
        global_domain: globalDomain?.domain || "",
        global_subdomain: globalDomain?.subdomain || "",
        suggested_path: sugPath,
        match_level: "specific"
      };
    } else {
      const systemPrompt = buildSystemPrompt(folderContext, globalDomain, activeFolders, filename, extension);
      const userMessage = buildUserMessage(filename, extension, fileContent);
      const raw2 = await callOllama(systemPrompt, userMessage);
      result = parseResponse(raw2, activeFolders, globalDomain, rawFingerprints);
    }
    if (siblingSignal) {
      if (result.category.toLowerCase() === siblingSignal.folder.toLowerCase()) {
        result.confidence = Math.min(100, result.confidence + siblingSignal.boost);
        result.reasoning += ` [Sibling boost +${siblingSignal.boost}: ${siblingSignal.count} similar files already in "${siblingSignal.folder}"]`;
      }
    }
    const signals = [
      { source: "Ollama", folder: result.category, confidence: result.confidence }
    ];
    if (poolSignal && poolSignal.confidence >= 60) signals.push(poolSignal);
    if (siblingSignal) signals.push({ source: "Sibling", folder: siblingSignal.folder, confidence: 75 });
    const consensusResult = applyMultiSignalConsensus(signals, result, filename);
    consensusResult.match_level = "specific";
    {
      const runnerUp = poolScores.find(
        (s) => s.folder.toLowerCase() !== consensusResult.category.toLowerCase()
      );
      if (runnerUp) {
        consensusResult.second_category = runnerUp.folder;
        consensusResult.second_confidence = runnerUp.confidence;
      } else if (poolScores.length > 0 && poolScores[0].folder.toLowerCase() !== consensusResult.category.toLowerCase()) {
        consensusResult.second_category = poolScores[0].folder;
        consensusResult.second_confidence = poolScores[0].confidence;
      }
    }
    if (consensusResult.confidence >= REVIEW_THRESHOLD) {
      logResult(filename, fileContent, consensusResult);
      return consensusResult;
    }
    if (globalDomain && globalDomain.confidence >= DOMAIN_CONFIDENCE_THRESHOLD) {
      const sugPath = buildSuggestedPath(globalDomain, activeFolders, globalDomain.subdomain);
      const leaf = sugPath.includes("/") ? sanitizeFolderName(sugPath.split("/").pop()) : sanitizeFolderName(globalDomain.subdomain || globalDomain.domain);
      const broad = {
        ...consensusResult,
        category: leaf || consensusResult.category,
        confidence: Math.max(consensusResult.confidence, 50),
        reasoning: consensusResult.reasoning + ` [Broad fallback via domain ${globalDomain.domain}/${globalDomain.subdomain}]`,
        isNewFolder: true,
        suggested_path: sugPath,
        match_level: "broad"
      };
      logResult(filename, fileContent, broad);
      return broad;
    }
    const needsReview = {
      category: "Needs Review",
      confidence: 0,
      reasoning: consensusResult.reasoning + " [Routed to Needs Review \u2014 no confident match found]",
      isNewFolder: false,
      detected_concepts: consensusResult.detected_concepts,
      concept_abstraction: consensusResult.concept_abstraction,
      requires_review: true,
      was_noise_penalized: consensusResult.was_noise_penalized,
      global_domain: globalDomain?.domain || "",
      global_subdomain: globalDomain?.subdomain || "",
      suggested_path: "",
      match_level: "fallback"
    };
    logResult(filename, fileContent, needsReview);
    return needsReview;
  } catch (err) {
    console.error(`[ClassificationService] AI call failed: ${err}`);
    const extFallbackMap = {
      ".pdf": "Documents",
      ".doc": "Documents",
      ".docx": "Documents",
      ".txt": "Documents",
      ".jpg": "Images",
      ".jpeg": "Images",
      ".png": "Images",
      ".heic": "Images",
      ".gif": "Images",
      ".mp4": "Videos",
      ".mov": "Videos",
      ".avi": "Videos",
      ".mp3": "Audio",
      ".wav": "Audio",
      ".flac": "Audio",
      ".xls": "Spreadsheets",
      ".xlsx": "Spreadsheets",
      ".csv": "Spreadsheets",
      ".zip": "Archives",
      ".rar": "Archives",
      ".7z": "Archives"
    };
    const extGuess = extFallbackMap[extension];
    const extFolder = extGuess && activeFolders.find((f) => f.toLowerCase() === extGuess.toLowerCase());
    if (extFolder) {
      return {
        category: extFolder,
        confidence: 45,
        reasoning: `AI unavailable: ${err} [Extension fallback \u2192 "${extFolder}"]`,
        isNewFolder: false,
        detected_concepts: [],
        concept_abstraction: "",
        requires_review: true,
        was_noise_penalized: false,
        global_domain: globalDomain?.domain || "",
        global_subdomain: globalDomain?.subdomain || "",
        suggested_path: "",
        match_level: "fallback"
      };
    }
    return {
      category: "Needs Review",
      confidence: 0,
      reasoning: `AI unavailable: ${err}`,
      isNewFolder: false,
      detected_concepts: [],
      concept_abstraction: "",
      requires_review: true,
      was_noise_penalized: false,
      global_domain: globalDomain?.domain || "",
      global_subdomain: globalDomain?.subdomain || "",
      suggested_path: "",
      match_level: "fallback"
    };
  }
}
async function classifyBatch(filePaths, targetDir) {
  const [userFolders, rawFingerprints, folderContext] = await Promise.all([
    scanUserFolders(targetDir),
    (0, import_ContextService.getFolderContext)(targetDir),
    (0, import_ContextService.getFolderContextForPrompt)(targetDir)
  ]);
  const results = [];
  for (const filePath of filePaths) {
    const filename = import_path.default.basename(filePath);
    const extension = import_path.default.extname(filePath).toLowerCase();
    const [fileContent, fileMetadata] = await Promise.all([
      sampleFileContent(filePath),
      (0, import_TextExtractionService.extractMetadata)(filePath)
    ]);
    {
      const filenamePlain = filename.toLowerCase().replace(/\.[^.]+$/, "").replace(/[-_\s+.]/g, "");
      let preCheckHit = null;
      for (const folder of userFolders) {
        if ((0, import_ContextService.isNoiseFolderName)(folder)) continue;
        const folderPlain = folder.toLowerCase().replace(/[-_\s+.]/g, "");
        if (folderPlain.length >= 4 && filenamePlain.includes(folderPlain)) {
          preCheckHit = {
            category: folder,
            confidence: 100,
            reasoning: `FILENAME MATCH: folder name "${folder}" found verbatim in filename "${filename}"`,
            isNewFolder: false,
            detected_concepts: [folder],
            concept_abstraction: `Folder name found in filename`,
            requires_review: false,
            was_noise_penalized: false,
            global_domain: "",
            global_subdomain: "",
            suggested_path: "",
            match_level: "bullseye"
          };
          break;
        }
      }
      if (preCheckHit) {
        results.push(preCheckHit);
        logResult(filename, fileContent, preCheckHit);
        continue;
      }
    }
    {
      const historyBoost = (0, import_ConsistencyService.getHistoryBoost)(filename, userFolders);
      if (historyBoost) {
        const consistencyResult = {
          category: historyBoost.folder,
          confidence: historyBoost.confidence,
          reasoning: `HISTORY MATCH: class key "${historyBoost.matchedKey}" was previously classified to "${historyBoost.folder}" ${historyBoost.hitCount} time(s)`,
          isNewFolder: false,
          detected_concepts: [historyBoost.matchedKey],
          concept_abstraction: `History pattern match`,
          requires_review: false,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: "specific"
        };
        results.push(consistencyResult);
        logResult(filename, fileContent, consistencyResult);
        continue;
      }
    }
    {
      const disambig = (0, import_accuracy_monitor.applyDisambiguationRules)(filename, fileContent);
      if (disambig && userFolders.some((f) => f.toLowerCase() === disambig.folder.toLowerCase())) {
        const actualFolder = userFolders.find((f) => f.toLowerCase() === disambig.folder.toLowerCase()) ?? disambig.folder;
        const disambigResult = {
          category: actualFolder,
          confidence: disambig.confidence,
          reasoning: `DISAMBIGUATION RULE: "${actualFolder}" matched ${disambig.rule.a_indicators.length + disambig.rule.b_indicators.length} exclusive indicators (auto-generated from confusion history)`,
          isNewFolder: false,
          detected_concepts: disambig.rule.a_indicators.slice(0, 5),
          concept_abstraction: `Disambiguation rule match`,
          requires_review: false,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: "specific"
        };
        results.push(disambigResult);
        logResult(filename, fileContent, disambigResult);
        continue;
      }
    }
    let activeFolders = userFolders;
    if (isFileRecent(filePath)) {
      activeFolders = userFolders.filter((f) => !(0, import_ContextService.isNoiseFolderName)(f));
    }
    if (fileMetadata) {
      const metaBullseye = tryMetadataBullseye(fileMetadata, activeFolders, rawFingerprints, filename);
      if (metaBullseye) {
        results.push(metaBullseye);
        logResult(filename, fileContent, metaBullseye);
        continue;
      }
    }
    const bullseye = tryBullseyeMatch(
      filename,
      fileContent,
      rawFingerprints,
      activeFolders
    );
    if (bullseye) {
      results.push(bullseye);
      logResult(filename, fileContent, bullseye);
      continue;
    }
    const keywordHit = tryKeywordMatch(filename, fileContent, activeFolders);
    if (keywordHit) {
      results.push(keywordHit);
      logResult(filename, fileContent, keywordHit);
      continue;
    }
    const smartHit = trySmartGroupMatch(filename, fileContent, activeFolders);
    if (smartHit) {
      results.push(smartHit);
      logResult(filename, fileContent, smartHit);
      continue;
    }
    const poolHit = tryPoolMatch(filename, fileContent, activeFolders, targetDir);
    if (poolHit) {
      const conflict = detectPoolConflicts(filename, fileContent, activeFolders, targetDir);
      if (conflict) {
        results.push(conflict);
        logResult(filename, fileContent, conflict);
        continue;
      }
      results.push(poolHit);
      logResult(filename, fileContent, poolHit);
      continue;
    }
    try {
      const internetHit = await tryInternetRetry(filename, fileContent, activeFolders, targetDir);
      if (internetHit) {
        results.push(internetHit);
        logResult(filename, fileContent, internetHit);
        continue;
      }
    } catch {
    }
    try {
      const deepLinkHit = await tryDeepLinkMatch(filename, fileContent, activeFolders, targetDir);
      if (deepLinkHit) {
        results.push(deepLinkHit);
        logResult(filename, fileContent, deepLinkHit);
        continue;
      }
    } catch {
    }
    try {
      const entityHit = await tryEntityRecognition(filename, fileContent, activeFolders, targetDir);
      if (entityHit) {
        results.push(entityHit);
        logResult(filename, fileContent, entityHit);
        continue;
      }
    } catch {
    }
    let batchSiblingSignal = null;
    try {
      batchSiblingSignal = await trySiblingSignal(filename, filePath, activeFolders);
    } catch {
    }
    let globalDomain = null;
    try {
      globalDomain = await classifyGlobalDomain(filename, extension, fileContent);
    } catch {
    }
    const batchPoolScores = scoreAllPoolCategories(filename, fileContent, activeFolders, targetDir);
    const batchPoolSignal = batchPoolScores.length > 0 ? { source: "Pool", folder: batchPoolScores[0].folder, confidence: batchPoolScores[0].confidence } : null;
    const v2Prompt = buildClassificationPromptV2(activeFolders, fileContent, filename, targetDir, globalDomain);
    try {
      const raw = await callOllama("", v2Prompt, { numCtx: 4096 });
      const v2parsed = parseClassificationResponseV2(raw, activeFolders);
      if (v2parsed && v2parsed.confidence === 0) {
        const noSig = {
          category: "Needs Review",
          confidence: 0,
          reasoning: `Ollama v2: no signal \u2014 ${v2parsed.reason}`,
          isNewFolder: false,
          detected_concepts: v2parsed.terms,
          concept_abstraction: "",
          requires_review: true,
          was_noise_penalized: false,
          global_domain: globalDomain?.domain || "",
          global_subdomain: globalDomain?.subdomain || "",
          suggested_path: "",
          match_level: "fallback"
        };
        results.push(noSig);
        logResult(filename, fileContent, noSig);
        continue;
      }
      let result;
      if (v2parsed && v2parsed.folder) {
        if (v2parsed.terms.length > 0 && !(0, import_ContextService.isNoiseFolderName)(v2parsed.folder)) {
          try {
            (0, import_universal_pool_manager.addTermsToPool)(v2parsed.terms, v2parsed.folder, targetDir);
          } catch {
          }
        }
        const resolvedFolder = activeFolders.find((f) => f.toLowerCase() === v2parsed.folder.toLowerCase()) || activeFolders.find((f) => f.toLowerCase().includes(v2parsed.folder.toLowerCase()) || v2parsed.folder.toLowerCase().includes(f.toLowerCase())) || null;
        result = {
          category: resolvedFolder || v2parsed.folder,
          confidence: v2parsed.confidence,
          reasoning: `AI v2 CoT: ${v2parsed.reason} [Terms: ${v2parsed.terms.join(", ")}]`,
          isNewFolder: !resolvedFolder,
          detected_concepts: v2parsed.terms,
          concept_abstraction: v2parsed.reason,
          requires_review: v2parsed.confidence < REVIEW_THRESHOLD,
          was_noise_penalized: false,
          global_domain: globalDomain?.domain || "",
          global_subdomain: globalDomain?.subdomain || "",
          suggested_path: "",
          match_level: "specific"
        };
      } else {
        const sp = buildSystemPrompt(folderContext, globalDomain, activeFolders, filename, extension);
        const um = buildUserMessage(filename, extension, fileContent);
        const raw2 = await callOllama(sp, um);
        result = parseResponse(raw2, activeFolders, globalDomain, rawFingerprints);
      }
      if (batchSiblingSignal && result.category.toLowerCase() === batchSiblingSignal.folder.toLowerCase()) {
        result.confidence = Math.min(100, result.confidence + batchSiblingSignal.boost);
        result.reasoning += ` [Sibling +${batchSiblingSignal.boost}: ${batchSiblingSignal.count} files in "${batchSiblingSignal.folder}"]`;
      }
      const batchSignals = [
        { source: "Ollama", folder: result.category, confidence: result.confidence }
      ];
      if (batchPoolSignal && batchPoolSignal.confidence >= 60) batchSignals.push(batchPoolSignal);
      if (batchSiblingSignal) batchSignals.push({ source: "Sibling", folder: batchSiblingSignal.folder, confidence: 75 });
      const batchConsensus = applyMultiSignalConsensus(batchSignals, result, filename);
      batchConsensus.match_level = "specific";
      if (batchConsensus.confidence >= REVIEW_THRESHOLD) {
        results.push(batchConsensus);
        logResult(filename, fileContent, batchConsensus);
        continue;
      }
      if (globalDomain && globalDomain.confidence >= DOMAIN_CONFIDENCE_THRESHOLD) {
        const sugPath = buildSuggestedPath(globalDomain, activeFolders, globalDomain.subdomain);
        const leaf = sugPath.includes("/") ? sanitizeFolderName(sugPath.split("/").pop()) : sanitizeFolderName(globalDomain.subdomain || globalDomain.domain);
        const broad = {
          ...batchConsensus,
          category: leaf || batchConsensus.category,
          confidence: Math.max(batchConsensus.confidence, 50),
          reasoning: batchConsensus.reasoning + ` [Broad fallback via domain ${globalDomain.domain}/${globalDomain.subdomain}]`,
          isNewFolder: true,
          suggested_path: sugPath,
          match_level: "broad"
        };
        results.push(broad);
        logResult(filename, fileContent, broad);
        continue;
      }
      const needsReview = {
        category: "Needs Review",
        confidence: 0,
        reasoning: batchConsensus.reasoning + " [Routed to Needs Review]",
        isNewFolder: false,
        detected_concepts: batchConsensus.detected_concepts,
        concept_abstraction: batchConsensus.concept_abstraction,
        requires_review: true,
        was_noise_penalized: batchConsensus.was_noise_penalized,
        global_domain: globalDomain?.domain || "",
        global_subdomain: globalDomain?.subdomain || "",
        suggested_path: "",
        match_level: "fallback"
      };
      results.push(needsReview);
      logResult(filename, fileContent, needsReview);
    } catch (err) {
      console.error(`[ClassificationService] Failed for ${filename}: ${err}`);
      const extFallbackMap = {
        ".pdf": "Documents",
        ".doc": "Documents",
        ".docx": "Documents",
        ".txt": "Documents",
        ".jpg": "Images",
        ".jpeg": "Images",
        ".png": "Images",
        ".heic": "Images",
        ".gif": "Images",
        ".mp4": "Videos",
        ".mov": "Videos",
        ".avi": "Videos",
        ".mp3": "Audio",
        ".wav": "Audio",
        ".flac": "Audio",
        ".xls": "Spreadsheets",
        ".xlsx": "Spreadsheets",
        ".csv": "Spreadsheets",
        ".zip": "Archives",
        ".rar": "Archives",
        ".7z": "Archives"
      };
      const extGuess = extFallbackMap[extension];
      const extFolder = extGuess && activeFolders.find((f) => f.toLowerCase() === extGuess.toLowerCase());
      if (extFolder) {
        results.push({
          category: extFolder,
          confidence: 45,
          reasoning: `AI unavailable: ${err} [Extension fallback \u2192 "${extFolder}"]`,
          isNewFolder: false,
          detected_concepts: [],
          concept_abstraction: "",
          requires_review: true,
          was_noise_penalized: false,
          global_domain: globalDomain?.domain || "",
          global_subdomain: globalDomain?.subdomain || "",
          suggested_path: "",
          match_level: "fallback"
        });
      } else {
        results.push({
          category: "Needs Review",
          confidence: 0,
          reasoning: `AI unavailable: ${err}`,
          isNewFolder: false,
          detected_concepts: [],
          concept_abstraction: "",
          requires_review: true,
          was_noise_penalized: false,
          global_domain: globalDomain?.domain || "",
          global_subdomain: globalDomain?.subdomain || "",
          suggested_path: "",
          match_level: "fallback"
        });
      }
    }
  }
  return results;
}
function logResult(filename, fileContent, r) {
  const wc = fileContent ? fileContent.split(/\s+/).length : 0;
  console.log(
    `[Classification] "${filename}" (${wc}w) \u2192 ${r.category} (${r.confidence}% ${r.match_level}${r.isNewFolder ? " NEW" : ""}${r.requires_review ? " REVIEW" : ""}${r.was_noise_penalized ? " PENALIZED" : ""}${r.global_domain ? ` domain=${r.global_domain}/${r.global_subdomain}` : ""}${r.suggested_path ? ` path="${r.suggested_path}"` : ""})`
  );
}
function getPoolHealthReport(targetDir) {
  return (0, import_universal_pool_manager.computePoolHealth)((0, import_universal_pool_manager.readMergedPool)(targetDir));
}
function getFolderDistinctiveTerms(folder, targetDir, topN = 20) {
  return (0, import_universal_pool_manager.getTopDistinctiveTerms)(folder, (0, import_universal_pool_manager.readMergedPool)(targetDir), topN);
}
function submitCorrection(filename, extension, aiGuess, aiConfidence, userChoice, targetDir, contentHint) {
  const wasCorrect = aiGuess.toLowerCase() === userChoice.toLowerCase();
  (0, import_LearningService.recordCorrection)({
    filename,
    extension,
    ai_guess: aiGuess,
    ai_confidence: aiConfidence,
    user_correction: userChoice,
    timestamp: Date.now(),
    content_hint: contentHint
  });
  (0, import_accuracy_monitor.recordClassification)(aiGuess, aiConfidence, userChoice, wasCorrect);
  if (targetDir) {
    (0, import_PoolEnrichmentService.enrichPoolFromCorrection)(filename, userChoice, aiConfidence, targetDir);
  }
}
function getResultConfidenceTier(confidence, folder) {
  return (0, import_accuracy_monitor.getConfidenceTier)(confidence, folder);
}
function checkDisambiguationRules(filename, fileContent) {
  return (0, import_accuracy_monitor.applyDisambiguationRules)(filename, fileContent);
}
async function disambiguateCategories(catA, catB, filename, fileContent) {
  const snippet = (fileContent || "").slice(0, 800);
  const prompt = `You are a file organizer. A file named "${filename}" could belong to either the "${catA}" folder or the "${catB}" folder.

File content snippet:
---
${snippet}
---

Differentiate between the two folders:
- List keywords in this file that point specifically toward "${catA}"
- List keywords in this file that point specifically toward "${catB}"

Reply in EXACTLY this format (no extra text, no headers):
CAT_A_KEYWORDS: keyword1, keyword2, keyword3
CAT_B_KEYWORDS: keyword1, keyword2, keyword3
REASONING: one sentence explaining the key difference between the two folders for this file`;
  try {
    const raw = await callOllama("", prompt, { numCtx: 2048, timeout: 3e4 });
    const catAMatch = raw.match(/CAT_A_KEYWORDS:\s*(.+)/i);
    const catBMatch = raw.match(/CAT_B_KEYWORDS:\s*(.+)/i);
    const reasonMatch = raw.match(/REASONING:\s*(.+)/i);
    const catAKeywords = catAMatch ? catAMatch[1].split(",").map((k) => k.trim()).filter(Boolean) : [];
    const catBKeywords = catBMatch ? catBMatch[1].split(",").map((k) => k.trim()).filter(Boolean) : [];
    const reasoning = reasonMatch ? reasonMatch[1].trim() : "No clear differentiator found.";
    return { catAKeywords, catBKeywords, reasoning };
  } catch (err) {
    console.error(`[ClassificationService] disambiguateCategories failed: ${err}`);
    return { catAKeywords: [], catBKeywords: [], reasoning: "Disambiguation unavailable." };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  checkDisambiguationRules,
  classifyBatch,
  classifyFile,
  disambiguateCategories,
  findExistingEquivalent,
  getFolderDistinctiveTerms,
  getPoolHealthReport,
  getResultConfidenceTier,
  submitCorrection
});
