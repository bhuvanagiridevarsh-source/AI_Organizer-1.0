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
var ClusteringService_exports = {};
__export(ClusteringService_exports, {
  clusterFiles: () => clusterFiles,
  needsClustering: () => needsClustering,
  suggestFolderPath: () => suggestFolderPath,
  vectorizeFiles: () => vectorizeFiles
});
module.exports = __toCommonJS(ClusteringService_exports);
var import_path = __toESM(require("path"));
var import_http = __toESM(require("http"));
var import_TextExtractionService = require("./TextExtractionService");
const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const MODEL_NAME = "llama3.2:1b";
const REQUEST_TIMEOUT_MS = 12e4;
const WORDS_FOR_SUMMARY = 1e3;
const MAX_GROUP_SIZE = 10;
const MIN_GROUP_SIZE = 2;
const MAX_RECURSION_DEPTH = 3;
const MAX_BROAD_CATEGORIES = 5;
const MIN_BROAD_CATEGORIES = 3;
function callOllama(prompt, systemPrompt) {
  return new Promise((resolve, reject) => {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt });
    const payload = JSON.stringify({
      model: MODEL_NAME,
      messages,
      stream: false,
      options: {
        temperature: 0.2,
        num_ctx: 8192
        // Large context for batch operations
      }
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
        timeout: REQUEST_TIMEOUT_MS
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
  });
}
async function generateTopicVector(filePath, content) {
  const filename = import_path.default.basename(filePath);
  if (!content || content.trim().length < 20) {
    return `File named "${filename}" with unreadable content`;
  }
  const prompt = `Describe this document in ONE sentence (max 15 words).
Focus on: What is this document ABOUT? What subject/topic/domain?

Filename: ${filename}
Content preview:
${content.slice(0, 2e3)}

Respond with ONLY the description sentence, nothing else.
Example: "Mortgage agreement for residential property purchase"
Example: "Essay analyzing themes in Shakespeare's Hamlet"
Example: "Tax return form for 2024 fiscal year"`;
  try {
    const summary = await callOllama(prompt);
    return summary.trim().replace(/^["']|["']$/g, "").slice(0, 100);
  } catch {
    return `File named "${filename}"`;
  }
}
async function vectorizeFiles(filePaths, onProgress) {
  const vectors = [];
  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];
    const filename = import_path.default.basename(filePath);
    const extension = import_path.default.extname(filePath).toLowerCase();
    onProgress?.(i + 1, filePaths.length, filename);
    try {
      const content = await (0, import_TextExtractionService.extractText)(filePath);
      const words = content.split(/\s+/).slice(0, WORDS_FOR_SUMMARY).join(" ");
      const topicSummary = await generateTopicVector(filePath, words);
      vectors.push({
        filePath,
        filename,
        extension,
        topicSummary,
        wordCount: content.split(/\s+/).length
      });
      console.log(`[Clustering] Vectorized "${filename}": "${topicSummary}"`);
    } catch (err) {
      console.warn(`[Clustering] Failed to vectorize "${filename}": ${err}`);
      vectors.push({
        filePath,
        filename,
        extension,
        topicSummary: `File named "${filename}"`,
        wordCount: 0
      });
    }
  }
  return vectors;
}
async function broadSweepCluster(vectors) {
  if (vectors.length === 0) return {};
  if (vectors.length <= 3) {
    return { "Documents": vectors };
  }
  const summaryList = vectors.map((v, i) => `${i + 1}. "${v.filename}": ${v.topicSummary}`).join("\n");
  const prompt = `You are organizing files into folders. Group these ${vectors.length} files into ${MIN_BROAD_CATEGORIES}-${MAX_BROAD_CATEGORIES} HIGH-LEVEL categories.

FILES:
${summaryList}

RULES:
- Create ${MIN_BROAD_CATEGORIES}-${MAX_BROAD_CATEGORIES} broad categories (e.g., "School", "Finance", "Work", "Personal", "Medical")
- Each file must belong to exactly ONE category
- Category names should be 1-2 words, human-friendly
- Output ONLY valid JSON

OUTPUT FORMAT:
{
  "CategoryName": [1, 5, 7],
  "AnotherCategory": [2, 3, 4, 6]
}

Where the numbers are the file indices from the list above.`;
  try {
    const response = await callOllama(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }
    const grouping = JSON.parse(jsonMatch[0]);
    const result = {};
    for (const [category, indices] of Object.entries(grouping)) {
      if (!Array.isArray(indices)) continue;
      result[category] = indices.filter((idx) => typeof idx === "number" && idx >= 1 && idx <= vectors.length).map((idx) => vectors[idx - 1]).filter(Boolean);
    }
    const assignedIndices = new Set(
      Object.values(grouping).flat().filter((idx) => typeof idx === "number")
    );
    const orphans = vectors.filter((_, i) => !assignedIndices.has(i + 1));
    if (orphans.length > 0) {
      result["Other"] = [...result["Other"] || [], ...orphans];
    }
    console.log(
      `[Clustering] Broad sweep: ${Object.keys(result).length} categories created`
    );
    return result;
  } catch (err) {
    console.error(`[Clustering] Broad sweep failed: ${err}`);
    return { "Documents": vectors };
  }
}
async function deepDiveCluster(categoryName, vectors, depth = 0) {
  if (vectors.length <= MIN_GROUP_SIZE || depth >= MAX_RECURSION_DEPTH) {
    return { [categoryName]: vectors.map((v) => v.filePath) };
  }
  if (vectors.length <= MAX_GROUP_SIZE) {
    return { [categoryName]: vectors.map((v) => v.filePath) };
  }
  const summaryList = vectors.map((v, i) => `${i + 1}. "${v.filename}": ${v.topicSummary}`).join("\n");
  const prompt = `These ${vectors.length} files all belong to the "${categoryName}" category.
Split them into 2-4 MORE SPECIFIC sub-categories.

FILES:
${summaryList}

RULES:
- Create 2-4 specific sub-categories within "${categoryName}"
- Sub-category names should reflect the actual content (e.g., "AP Seminar", "Calculus", "Tax Returns")
- Each file must belong to exactly ONE sub-category
- Output ONLY valid JSON

OUTPUT FORMAT:
{
  "SpecificCategory1": [1, 3],
  "SpecificCategory2": [2, 4, 5]
}`;
  try {
    const response = await callOllama(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }
    const subGrouping = JSON.parse(jsonMatch[0]);
    const result = {};
    for (const [subCategory, indices] of Object.entries(subGrouping)) {
      if (!Array.isArray(indices)) continue;
      const subVectors = indices.filter((idx) => typeof idx === "number" && idx >= 1 && idx <= vectors.length).map((idx) => vectors[idx - 1]).filter(Boolean);
      if (subVectors.length === 0) continue;
      if (subVectors.length > MAX_GROUP_SIZE && depth < MAX_RECURSION_DEPTH - 1) {
        const nestedResult = await deepDiveCluster(subCategory, subVectors, depth + 1);
        Object.assign(result, nestedResult);
      } else {
        result[subCategory] = subVectors.map((v) => v.filePath);
      }
    }
    const assignedIndices = new Set(
      Object.values(subGrouping).flat().filter((idx) => typeof idx === "number")
    );
    const orphans = vectors.filter((_, i) => !assignedIndices.has(i + 1));
    if (orphans.length > 0) {
      result[`${categoryName} - Other`] = orphans.map((v) => v.filePath);
    }
    console.log(
      `[Clustering] Deep dive "${categoryName}": ${Object.keys(result).length} sub-categories`
    );
    return result;
  } catch (err) {
    console.error(`[Clustering] Deep dive failed for "${categoryName}": ${err}`);
    return { [categoryName]: vectors.map((v) => v.filePath) };
  }
}
async function clusterFiles(filePaths, onProgress) {
  const startTime = Date.now();
  console.log(`[Clustering] Starting cluster analysis of ${filePaths.length} files`);
  onProgress?.("vectorizing", 0, filePaths.length);
  const vectors = await vectorizeFiles(filePaths, (current, total, filename) => {
    onProgress?.("vectorizing", current, total, filename);
  });
  onProgress?.("broad_sweep", 0, 1, "Identifying broad categories...");
  const broadGroups = await broadSweepCluster(vectors);
  const tree = {};
  const flatGroups = {};
  const orphans = [];
  const broadCategories = Object.keys(broadGroups);
  let maxDepth = 1;
  for (let i = 0; i < broadCategories.length; i++) {
    const category = broadCategories[i];
    const categoryVectors = broadGroups[category];
    onProgress?.("deep_dive", i + 1, broadCategories.length, category);
    const subGroups = await deepDiveCluster(category, categoryVectors, 0);
    tree[category] = {};
    for (const [subCategory, files] of Object.entries(subGroups)) {
      tree[category][subCategory] = files;
      flatGroups[`${category}/${subCategory}`] = files;
      const depth = subCategory.split("/").length + 1;
      if (depth > maxDepth) maxDepth = depth;
    }
  }
  const processingTimeMs = Date.now() - startTime;
  const result = {
    tree,
    flatGroups,
    orphans,
    stats: {
      totalFiles: filePaths.length,
      totalGroups: Object.keys(flatGroups).length,
      maxDepth,
      processingTimeMs
    }
  };
  console.log(
    `[Clustering] Complete: ${result.stats.totalGroups} groups, ${result.stats.maxDepth} depth, ${processingTimeMs}ms`
  );
  return result;
}
async function suggestFolderPath(filePath) {
  try {
    const content = await (0, import_TextExtractionService.extractText)(filePath);
    const words = content.split(/\s+/).slice(0, WORDS_FOR_SUMMARY).join(" ");
    const filename = import_path.default.basename(filePath);
    const prompt = `Suggest a 2-level folder path for this file.

Filename: ${filename}
Content preview:
${words.slice(0, 1500)}

RULES:
- Format: "ParentCategory/SpecificCategory"
- Parent should be broad (School, Finance, Work, Personal, Medical, Legal)
- Specific should be precise (AP Seminar, Tax Returns, Project Alpha)
- Output ONLY valid JSON

OUTPUT:
{
  "path": "Parent/Specific",
  "confidence": 0-100,
  "reasoning": "One sentence explaining why"
}`;
    const response = await callOllama(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        suggestedPath: String(result.path || "Documents/Unsorted"),
        confidence: Number(result.confidence) || 50,
        reasoning: String(result.reasoning || "Based on content analysis")
      };
    }
  } catch (err) {
    console.error(`[Clustering] suggestFolderPath failed: ${err}`);
  }
  return {
    suggestedPath: "Documents/Unsorted",
    confidence: 20,
    reasoning: "Could not analyze file content"
  };
}
async function needsClustering(filePaths) {
  if (filePaths.length < 5) return false;
  if (filePaths.length > 100) return true;
  const sampleSize = Math.min(5, filePaths.length);
  const sample = filePaths.slice(0, sampleSize);
  const vectors = await vectorizeFiles(sample);
  const summaries = vectors.map((v) => v.topicSummary).join("\n");
  const prompt = `Do these files belong to ONE topic or MULTIPLE different topics?

${summaries}

Respond with ONLY "single" or "multiple".`;
  try {
    const response = await callOllama(prompt);
    return response.toLowerCase().includes("multiple");
  } catch {
    return filePaths.length > 10;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  clusterFiles,
  needsClustering,
  suggestFolderPath,
  vectorizeFiles
});
