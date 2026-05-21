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
var KnowledgeGraphService_exports = {};
__export(KnowledgeGraphService_exports, {
  applyGraphToPool: () => applyGraphToPool,
  bootstrapNewFolder: () => bootstrapNewFolder,
  buildFolderGraph: () => buildFolderGraph,
  getKGFlagPath: () => getKGFlagPath,
  getKGPath: () => getKGPath,
  isQualityTerm: () => isQualityTerm,
  loadKG: () => loadKG,
  rebuildAllFolders: () => rebuildAllFolders,
  validateAndApplyKGOnStartup: () => validateAndApplyKGOnStartup
});
module.exports = __toCommonJS(KnowledgeGraphService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var LlamaService = __toESM(require("./LlamaService"));
const KG_FILE = "knowledge_graph.json";
const KG_REBUILT_FLAG = "knowledge_graph_rebuilt.json";
const GLOBAL_CONCEPTS = "global_concepts.json";
const GENERATE_TIMEOUT = 6e4;
const MAX_SAMPLE_FILES = 12;
const CROSS_POOL_LIMIT = 0.4;
const GENERIC_BLOCKLIST = /* @__PURE__ */ new Set([
  "notes",
  "note",
  "file",
  "files",
  "document",
  "documents",
  "folder",
  "folders",
  "study",
  "studies",
  "studying",
  "guide",
  "summary",
  "summaries",
  "overview",
  "introduction",
  "chapter",
  "chapters",
  "lecture",
  "lectures",
  "homework",
  "assignment",
  "assignments",
  "worksheet",
  "worksheets",
  "test",
  "tests",
  "exam",
  "exams",
  "quiz",
  "quizzes",
  "review",
  "reviews",
  "practice",
  "help",
  "information",
  "data",
  "project",
  "projects",
  "report",
  "reports",
  "essay",
  "essays",
  "paper",
  "papers",
  "book",
  "books",
  "page",
  "pages",
  "unit",
  "units",
  "lesson",
  "lessons",
  "class",
  "classes",
  "course",
  "courses",
  "school",
  "college",
  "university",
  "student",
  "students",
  "teacher",
  "teachers",
  "professor",
  "professors",
  "work",
  "example",
  "examples",
  "exercise",
  "exercises",
  "content",
  "material",
  "materials",
  "resource",
  "resources",
  "topic",
  "topics",
  "subject",
  "subjects",
  "area",
  "areas",
  "section",
  "sections",
  "part",
  "parts",
  "type",
  "types",
  "list",
  "lists",
  "set",
  "sets",
  "group",
  "groups",
  "general",
  "basic",
  "advanced",
  "complete",
  "final",
  "main",
  "key",
  "important",
  "using",
  "used",
  "use",
  "uses",
  "make",
  "making",
  "made",
  "new",
  "old",
  "good",
  "great",
  "best",
  "first",
  "last",
  "next",
  "other",
  "various"
]);
function getKGPath(rootDir) {
  return import_path.default.join(rootDir, KG_FILE);
}
function getKGFlagPath(rootDir) {
  return import_path.default.join(rootDir, KG_REBUILT_FLAG);
}
function loadKG(rootDir) {
  try {
    const raw = import_fs.default.readFileSync(getKGPath(rootDir), "utf-8");
    const data = JSON.parse(raw);
    if (data?.folders) return data;
  } catch {
  }
  return { version: 1, generated: Date.now(), folders: {} };
}
function saveKG(rootDir, kg) {
  try {
    import_fs.default.writeFileSync(getKGPath(rootDir), JSON.stringify(kg, null, 2), "utf-8");
    import_fs.default.writeFileSync(getKGFlagPath(rootDir), JSON.stringify({ ts: Date.now() }), "utf-8");
  } catch (err) {
    console.error(`[KnowledgeGraph] Failed to save: ${err}`);
  }
}
function isQualityTerm(term, allPools) {
  const t = term.trim().toLowerCase();
  if (t.length <= 3) return false;
  if (/^[\d\s\W]+$/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length === 1 && GENERIC_BLOCKLIST.has(t)) return false;
  if (words.length > 1 && words.every((w) => GENERIC_BLOCKLIST.has(w))) return false;
  if (allPools) {
    const totalFolders = Object.keys(allPools).length;
    if (totalFolders > 0) {
      const foldersWithTerm = Object.values(allPools).filter(
        (terms) => terms.some((existing) => existing.toLowerCase() === t)
      ).length;
      if (foldersWithTerm / totalFolders > CROSS_POOL_LIMIT) return false;
    }
  }
  return true;
}
function folderSimilarity(a, b) {
  const tokA = new Set(a.toLowerCase().split(/[\s_\-]+/).filter((t) => t.length > 1));
  const tokB = new Set(b.toLowerCase().split(/[\s_\-]+/).filter((t) => t.length > 1));
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokA) if (tokB.has(t)) overlap++;
  return overlap / Math.max(tokA.size, tokB.size);
}
function findDuplicateFolder(folderName, graph) {
  for (const existing of Object.keys(graph.folders)) {
    if (folderSimilarity(existing, folderName) >= 0.8) return existing;
  }
  return null;
}
async function ollamaGenerate(prompt, timeoutMs = GENERATE_TIMEOUT) {
  return LlamaService.generate(prompt, { maxTokens: 512, temperature: 0.2, timeoutMs });
}
async function generateWithBestModel(prompt) {
  return LlamaService.generate(prompt, { maxTokens: 512, temperature: 0.2, timeoutMs: GENERATE_TIMEOUT });
}
async function buildFolderGraph(folderName, filenames, allPools) {
  const sampleFiles = filenames.slice(0, MAX_SAMPLE_FILES).join("\n");
  const phase1Prompt = `A folder named "${folderName}" contains these files:
${sampleFiles}

In exactly ONE sentence, describe what academic subject or topic this folder is about. Do NOT use the words "folder", "files", or "documents". Just describe the domain (e.g. "Advanced Placement United States History course covering colonial period through modern era.").`;
  let description;
  try {
    const raw = await generateWithBestModel(phase1Prompt);
    description = raw.trim().split("\n")[0].trim();
    if (!description || description.length < 10) {
      description = `Files related to ${folderName}`;
    }
  } catch (err) {
    console.warn(`[KnowledgeGraph] Phase 1 failed for "${folderName}": ${err}`);
    return null;
  }
  const phase2Prompt = `You are building a search index for content about: ${description}

Generate exactly 40 specific search terms that appear in this type of content.
Requirements:
- 2-5 words each (multi-word phrases strongly preferred)
- Domain-specific only \u2014 NO generic words like "notes", "study", "homework", "guide"
- Include: key concepts, technical vocabulary, proper nouns, theories, methods, events
- Each term on its own line, no numbering, no bullets, no explanations

Output ONLY the terms, one per line:`;
  let rawTerms;
  try {
    rawTerms = await generateWithBestModel(phase2Prompt);
  } catch (err) {
    console.warn(`[KnowledgeGraph] Phase 2 failed for "${folderName}": ${err}`);
    return null;
  }
  const terms = rawTerms.split("\n").map((line) => line.replace(/^[\d\.\-\*•]+\s*/, "").trim().toLowerCase()).filter((t) => t.length > 3 && isQualityTerm(t, allPools));
  if (terms.length === 0) {
    console.warn(`[KnowledgeGraph] No quality terms generated for "${folderName}"`);
    return null;
  }
  console.log(`[KnowledgeGraph] "${folderName}": ${terms.length} terms | ${description.slice(0, 60)}`);
  return {
    description,
    terms: [...new Set(terms)],
    // deduplicate
    generated: Date.now()
  };
}
async function rebuildAllFolders(rootDir, onProgress) {
  const kg = loadKG(rootDir);
  const before = JSON.parse(JSON.stringify(kg.folders));
  const poolPath = import_path.default.join(rootDir, GLOBAL_CONCEPTS);
  let allPools = {};
  try {
    allPools = JSON.parse(import_fs.default.readFileSync(poolPath, "utf-8"));
  } catch {
  }
  let subfolders;
  try {
    subfolders = import_fs.default.readdirSync(rootDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).filter((n) => !n.startsWith(".") && n !== "Needs Review");
  } catch (err) {
    console.error(`[KnowledgeGraph] Cannot read rootDir: ${err}`);
    return kg;
  }
  for (const folderName of subfolders) {
    onProgress?.({ folder: folderName, status: "generating" });
    const duplicate = findDuplicateFolder(folderName, kg);
    if (duplicate && duplicate !== folderName && kg.folders[duplicate]) {
      kg.folders[folderName] = { ...kg.folders[duplicate], generated: Date.now() };
      onProgress?.({
        folder: folderName,
        status: "done",
        termCount: kg.folders[folderName].terms.length,
        message: `merged from "${duplicate}"`
      });
      continue;
    }
    const folderPath = import_path.default.join(rootDir, folderName);
    let filenames;
    try {
      filenames = import_fs.default.readdirSync(folderPath).filter((f) => !f.startsWith(".")).slice(0, MAX_SAMPLE_FILES);
    } catch {
      onProgress?.({ folder: folderName, status: "skipped", message: "unreadable" });
      continue;
    }
    if (filenames.length === 0) {
      onProgress?.({ folder: folderName, status: "skipped", message: "empty folder" });
      continue;
    }
    try {
      const graph = await buildFolderGraph(folderName, filenames, allPools);
      if (graph) {
        kg.folders[folderName] = graph;
        onProgress?.({ folder: folderName, status: "done", termCount: graph.terms.length });
      } else {
        onProgress?.({ folder: folderName, status: "error", message: "no terms generated" });
      }
    } catch (err) {
      console.error(`[KnowledgeGraph] Error on "${folderName}": ${err}`);
      onProgress?.({ folder: folderName, status: "error", message: String(err) });
    }
  }
  kg.generated = Date.now();
  saveKG(rootDir, kg);
  const newFolders = Object.keys(kg.folders).filter((f) => !before[f]);
  const improved = Object.keys(kg.folders).filter(
    (f) => before[f] && kg.folders[f].terms.length > (before[f]?.terms.length ?? 0)
  );
  console.log(
    `[KnowledgeGraph] Rebuild complete. New: ${newFolders.length}, Improved: ${improved.length}, Total folders: ${Object.keys(kg.folders).length}`
  );
  applyGraphToPool(rootDir, kg);
  return kg;
}
function applyGraphToPool(rootDir, kg) {
  const poolPath = import_path.default.join(rootDir, GLOBAL_CONCEPTS);
  const usedKg = kg ?? loadKG(rootDir);
  let pools = {};
  try {
    pools = JSON.parse(import_fs.default.readFileSync(poolPath, "utf-8"));
  } catch {
  }
  let added = 0;
  for (const [folder, graph] of Object.entries(usedKg.folders)) {
    const existing = new Set((pools[folder] ?? []).map((t) => t.toLowerCase()));
    const newTerms = [];
    for (const term of graph.terms) {
      if (!existing.has(term) && isQualityTerm(term, pools)) {
        newTerms.push(term);
        existing.add(term);
      }
    }
    if (newTerms.length > 0) {
      pools[folder] = [...pools[folder] ?? [], ...newTerms];
      added += newTerms.length;
    }
  }
  if (added > 0) {
    try {
      import_fs.default.writeFileSync(poolPath, JSON.stringify(pools, null, 2), "utf-8");
      console.log(`[KnowledgeGraph] Applied ${added} terms to global_concepts.json`);
    } catch (err) {
      console.error(`[KnowledgeGraph] Failed to write pool: ${err}`);
    }
  }
}
async function bootstrapNewFolder(folderName, rootDir) {
  const kg = loadKG(rootDir);
  if (kg.folders[folderName]) return;
  if (findDuplicateFolder(folderName, kg)) return;
  const folderPath = import_path.default.join(rootDir, folderName);
  if (!import_fs.default.existsSync(folderPath)) return;
  let filenames;
  try {
    filenames = import_fs.default.readdirSync(folderPath).filter((f) => !f.startsWith(".")).slice(0, MAX_SAMPLE_FILES);
  } catch {
    return;
  }
  if (filenames.length === 0) return;
  let allPools = {};
  try {
    allPools = JSON.parse(import_fs.default.readFileSync(import_path.default.join(rootDir, GLOBAL_CONCEPTS), "utf-8"));
  } catch {
  }
  try {
    const graph = await buildFolderGraph(folderName, filenames, allPools);
    if (graph) {
      kg.folders[folderName] = graph;
      saveKG(rootDir, kg);
      applyGraphToPool(rootDir, kg);
      console.log(`[KnowledgeGraph] Bootstrapped new folder: "${folderName}" (${graph.terms.length} terms)`);
    }
  } catch (err) {
    console.warn(`[KnowledgeGraph] Bootstrap failed for "${folderName}": ${err}`);
  }
}
function validateAndApplyKGOnStartup(rootDir) {
  const flagPath = getKGFlagPath(rootDir);
  if (!import_fs.default.existsSync(flagPath)) return false;
  const kg = loadKG(rootDir);
  if (Object.keys(kg.folders).length === 0) return false;
  applyGraphToPool(rootDir, kg);
  console.log(
    `[KnowledgeGraph] Startup: applied knowledge graph (${Object.keys(kg.folders).length} folders)`
  );
  return true;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  applyGraphToPool,
  bootstrapNewFolder,
  buildFolderGraph,
  getKGFlagPath,
  getKGPath,
  isQualityTerm,
  loadKG,
  rebuildAllFolders,
  validateAndApplyKGOnStartup
});
