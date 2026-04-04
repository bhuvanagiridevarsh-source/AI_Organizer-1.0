/**
 * ClusteringService.ts — Recursive Hierarchical Clustering Engine.
 *
 * SOLVES THE "MESSY PILE" PROBLEM:
 * When a user has 100+ unsorted files and zero folder structure,
 * this service automatically discovers the natural groupings.
 *
 * WORKFLOW:
 *
 *   1. BATCH VECTORIZATION
 *      Read first 1000 words of each file, generate 1-sentence "Topic Vector".
 *      Example: "mortgage_2024.pdf" → "Mortgage agreement for property purchase"
 *
 *   2. PHASE 1 — BROAD SWEEP (Parent Categories)
 *      Send all summaries to Ollama: "Group into 3-5 high-level domains"
 *      Result: { "Finance": [files], "School": [files], "Personal": [files] }
 *
 *   3. PHASE 2 — DEEP DIVE (Sub-Categories)
 *      For each broad group, cluster again to find specific topics.
 *      Result: { "School": { "AP Seminar": [files], "Calculus": [files] } }
 *
 *   4. RECURSIVE REFINEMENT
 *      If any group has >10 files, split it again until specific.
 *
 * OUTPUT:
 *   Nested JSON structure ready for folder creation:
 *   {
 *     "School": {
 *       "AP Seminar": ["file1.pdf", "file2.docx"],
 *       "Math": ["calculus_hw.pdf"]
 *     },
 *     "Finance": {
 *       "Taxes": ["w2_2024.pdf"],
 *       "Mortgage": ["loan_docs.pdf"]
 *     }
 *   }
 */

import path from "path";
import http from "http";
import { extractText } from "./TextExtractionService";

// ── Configuration ──────────────────────────────────────────

const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const MODEL_NAME = "llama3.2:1b";
const REQUEST_TIMEOUT_MS = 120000; // 2 minutes for batch operations

const WORDS_FOR_SUMMARY = 1000;
const MAX_GROUP_SIZE = 10;        // Recursively split if group exceeds this
const MIN_GROUP_SIZE = 2;         // Don't split groups smaller than this
const MAX_RECURSION_DEPTH = 3;    // Prevent infinite recursion
const MAX_BROAD_CATEGORIES = 5;
const MIN_BROAD_CATEGORIES = 3;

// ── Types ──────────────────────────────────────────────────

export interface FileVector {
  filePath: string;
  filename: string;
  extension: string;
  topicSummary: string;       // 1-sentence description
  wordCount: number;
}

export interface ClusterNode {
  name: string;
  files: string[];            // File paths in this cluster
  children?: ClusterNode[];   // Sub-clusters (if recursively split)
}

export interface ClusterResult {
  tree: Record<string, Record<string, string[]>>;  // Nested structure
  flatGroups: Record<string, string[]>;            // Flat for quick lookup
  orphans: string[];                               // Files that couldn't be clustered
  stats: {
    totalFiles: number;
    totalGroups: number;
    maxDepth: number;
    processingTimeMs: number;
  };
}

// ── Ollama API ─────────────────────────────────────────────

function callOllama(prompt: string, systemPrompt?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const messages: Array<{ role: string; content: string }> = [];

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
        num_ctx: 8192, // Large context for batch operations
      },
    });

    const req = http.request(
      {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: "/api/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            resolve(data.message?.content || "");
          } catch {
            reject(new Error("Failed to parse Ollama response"));
          }
        });
        res.on("error", (err: Error) => reject(err));
      }
    );

    req.on("error", (err: Error) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Ollama request timed out"));
    });

    req.write(payload);
    req.end();
  });
}

// ── Topic Vectorization ────────────────────────────────────

/**
 * Generate a 1-sentence topic summary for a single file.
 */
async function generateTopicVector(
  filePath: string,
  content: string
): Promise<string> {
  const filename = path.basename(filePath);

  if (!content || content.trim().length < 20) {
    // No content — use filename analysis
    return `File named "${filename}" with unreadable content`;
  }

  const prompt = `Describe this document in ONE sentence (max 15 words).
Focus on: What is this document ABOUT? What subject/topic/domain?

Filename: ${filename}
Content preview:
${content.slice(0, 2000)}

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

/**
 * Batch vectorize multiple files.
 * Returns array of FileVectors with topic summaries.
 */
export async function vectorizeFiles(
  filePaths: string[],
  onProgress?: (current: number, total: number, filename: string) => void
): Promise<FileVector[]> {
  const vectors: FileVector[] = [];

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];
    const filename = path.basename(filePath);
    const extension = path.extname(filePath).toLowerCase();

    onProgress?.(i + 1, filePaths.length, filename);

    try {
      // Extract text (limited to first chunk for speed)
      const content = await extractText(filePath);
      const words = content.split(/\s+/).slice(0, WORDS_FOR_SUMMARY).join(" ");

      // Generate topic summary
      const topicSummary = await generateTopicVector(filePath, words);

      vectors.push({
        filePath,
        filename,
        extension,
        topicSummary,
        wordCount: content.split(/\s+/).length,
      });

      console.log(`[Clustering] Vectorized "${filename}": "${topicSummary}"`);
    } catch (err) {
      console.warn(`[Clustering] Failed to vectorize "${filename}": ${err}`);
      vectors.push({
        filePath,
        filename,
        extension,
        topicSummary: `File named "${filename}"`,
        wordCount: 0,
      });
    }
  }

  return vectors;
}

// ── Clustering Logic ───────────────────────────────────────

/**
 * Phase 1: Broad Sweep — Group files into 3-5 high-level domains.
 */
async function broadSweepCluster(
  vectors: FileVector[]
): Promise<Record<string, FileVector[]>> {
  if (vectors.length === 0) return {};
  if (vectors.length <= 3) {
    // Too few files — put them all in one group
    return { "Documents": vectors };
  }

  // Build summary list for Ollama
  const summaryList = vectors
    .map((v, i) => `${i + 1}. "${v.filename}": ${v.topicSummary}`)
    .join("\n");

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

    // Parse JSON response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }

    const grouping: Record<string, number[]> = JSON.parse(jsonMatch[0]);
    const result: Record<string, FileVector[]> = {};

    // Convert indices to FileVectors
    for (const [category, indices] of Object.entries(grouping)) {
      if (!Array.isArray(indices)) continue;

      result[category] = indices
        .filter((idx) => typeof idx === "number" && idx >= 1 && idx <= vectors.length)
        .map((idx) => vectors[idx - 1])
        .filter(Boolean);
    }

    // Find orphaned files (not assigned to any group)
    const assignedIndices = new Set(
      Object.values(grouping).flat().filter((idx) => typeof idx === "number")
    );
    const orphans = vectors.filter((_, i) => !assignedIndices.has(i + 1));
    if (orphans.length > 0) {
      result["Other"] = [...(result["Other"] || []), ...orphans];
    }

    console.log(
      `[Clustering] Broad sweep: ${Object.keys(result).length} categories created`
    );

    return result;
  } catch (err) {
    console.error(`[Clustering] Broad sweep failed: ${err}`);
    // Fallback: everything in one category
    return { "Documents": vectors };
  }
}

/**
 * Phase 2: Deep Dive — Split a group into specific sub-categories.
 */
async function deepDiveCluster(
  categoryName: string,
  vectors: FileVector[],
  depth: number = 0
): Promise<Record<string, string[]>> {
  // Base cases
  if (vectors.length <= MIN_GROUP_SIZE || depth >= MAX_RECURSION_DEPTH) {
    return { [categoryName]: vectors.map((v) => v.filePath) };
  }

  if (vectors.length <= MAX_GROUP_SIZE) {
    // Small enough — no need to split further
    return { [categoryName]: vectors.map((v) => v.filePath) };
  }

  // Build summary list
  const summaryList = vectors
    .map((v, i) => `${i + 1}. "${v.filename}": ${v.topicSummary}`)
    .join("\n");

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

    const subGrouping: Record<string, number[]> = JSON.parse(jsonMatch[0]);
    const result: Record<string, string[]> = {};

    // Process each sub-group
    for (const [subCategory, indices] of Object.entries(subGrouping)) {
      if (!Array.isArray(indices)) continue;

      const subVectors = indices
        .filter((idx) => typeof idx === "number" && idx >= 1 && idx <= vectors.length)
        .map((idx) => vectors[idx - 1])
        .filter(Boolean);

      if (subVectors.length === 0) continue;

      // Recursively split if still too large
      if (subVectors.length > MAX_GROUP_SIZE && depth < MAX_RECURSION_DEPTH - 1) {
        const nestedResult = await deepDiveCluster(subCategory, subVectors, depth + 1);
        Object.assign(result, nestedResult);
      } else {
        result[subCategory] = subVectors.map((v) => v.filePath);
      }
    }

    // Handle orphans
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

// ── Public API ─────────────────────────────────────────────

/**
 * Cluster a batch of files into a hierarchical folder structure.
 *
 * This is the main entry point for unsupervised organization.
 *
 * @param filePaths - Array of file paths to cluster (20-100 recommended)
 * @param onProgress - Optional progress callback
 * @returns Nested cluster structure ready for folder creation
 */
export async function clusterFiles(
  filePaths: string[],
  onProgress?: (phase: string, current: number, total: number, detail?: string) => void
): Promise<ClusterResult> {
  const startTime = Date.now();

  console.log(`[Clustering] Starting cluster analysis of ${filePaths.length} files`);

  // ── Step 1: Vectorize all files ──
  onProgress?.("vectorizing", 0, filePaths.length);
  const vectors = await vectorizeFiles(filePaths, (current, total, filename) => {
    onProgress?.("vectorizing", current, total, filename);
  });

  // ── Step 2: Broad Sweep (Parent Categories) ──
  onProgress?.("broad_sweep", 0, 1, "Identifying broad categories...");
  const broadGroups = await broadSweepCluster(vectors);

  // ── Step 3: Deep Dive (Sub-Categories) ──
  const tree: Record<string, Record<string, string[]>> = {};
  const flatGroups: Record<string, string[]> = {};
  const orphans: string[] = [];

  const broadCategories = Object.keys(broadGroups);
  let maxDepth = 1;

  for (let i = 0; i < broadCategories.length; i++) {
    const category = broadCategories[i];
    const categoryVectors = broadGroups[category];

    onProgress?.("deep_dive", i + 1, broadCategories.length, category);

    const subGroups = await deepDiveCluster(category, categoryVectors, 0);

    // Build tree structure
    tree[category] = {};
    for (const [subCategory, files] of Object.entries(subGroups)) {
      tree[category][subCategory] = files;
      flatGroups[`${category}/${subCategory}`] = files;

      // Track depth
      const depth = subCategory.split("/").length + 1;
      if (depth > maxDepth) maxDepth = depth;
    }
  }

  // ── Step 4: Compile Results ──
  const processingTimeMs = Date.now() - startTime;

  const result: ClusterResult = {
    tree,
    flatGroups,
    orphans,
    stats: {
      totalFiles: filePaths.length,
      totalGroups: Object.keys(flatGroups).length,
      maxDepth,
      processingTimeMs,
    },
  };

  console.log(
    `[Clustering] Complete: ${result.stats.totalGroups} groups, ` +
    `${result.stats.maxDepth} depth, ${processingTimeMs}ms`
  );

  return result;
}

/**
 * Suggest a folder path for a single file based on its content.
 *
 * Uses the same vectorization logic but returns a single suggested path.
 */
export async function suggestFolderPath(filePath: string): Promise<{
  suggestedPath: string;
  confidence: number;
  reasoning: string;
}> {
  try {
    const content = await extractText(filePath);
    const words = content.split(/\s+/).slice(0, WORDS_FOR_SUMMARY).join(" ");
    const filename = path.basename(filePath);

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
        reasoning: String(result.reasoning || "Based on content analysis"),
      };
    }
  } catch (err) {
    console.error(`[Clustering] suggestFolderPath failed: ${err}`);
  }

  return {
    suggestedPath: "Documents/Unsorted",
    confidence: 20,
    reasoning: "Could not analyze file content",
  };
}

/**
 * Quick cluster check — determine if files are diverse enough to need clustering.
 *
 * Returns true if the files span multiple domains and would benefit from
 * hierarchical organization.
 */
export async function needsClustering(filePaths: string[]): Promise<boolean> {
  if (filePaths.length < 5) return false;
  if (filePaths.length > 100) return true;

  // Sample a few files to check diversity
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
