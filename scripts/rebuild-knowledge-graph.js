#!/usr/bin/env node
/**
 * rebuild-knowledge-graph.js
 *
 * Standalone script that rebuilds the AI knowledge graph for all folders in
 * the organized-files directory.  Run this whenever you want the AI to learn
 * richer domain vocabulary for your folders.
 *
 * Usage:
 *   node scripts/rebuild-knowledge-graph.js [rootDir]
 *
 * If rootDir is not passed, defaults to ~/Desktop/AI_SORTED_FILES (same as app).
 *
 * Requires:
 *   - Ollama running locally (http://127.0.0.1:11434)
 *   - llama3.2 (any variant) pulled in Ollama
 *
 * Output:
 *   - <rootDir>/knowledge_graph.json  — the full domain vocabulary
 *   - <rootDir>/knowledge_graph_rebuilt.json  — flag read at app startup
 *   - Applies new terms to <rootDir>/global_concepts.json automatically
 */

const os   = require("os");
const path = require("path");
const fs   = require("fs");
const http = require("http");

// ── Configuration ───────────────────────────────────────────────────────────

const ROOT_DIR        = process.argv[2] ?? path.join(os.homedir(), "Desktop", "AI_SORTED_FILES");
const KG_FILE         = path.join(ROOT_DIR, "knowledge_graph.json");
const KG_FLAG         = path.join(ROOT_DIR, "knowledge_graph_rebuilt.json");
const POOL_FILE       = path.join(ROOT_DIR, "global_concepts.json");
const MAX_SAMPLE      = 12;
const CROSS_LIMIT     = 0.40;
const GENERATE_TIMEOUT = 60_000;

const GENERIC_BLOCKLIST = new Set([
  "notes","note","file","files","document","documents","folder","folders",
  "study","studies","guide","summary","overview","introduction","chapter",
  "lecture","homework","assignment","worksheet","test","exam","quiz",
  "review","practice","help","information","data","project","report",
  "essay","paper","book","page","unit","lesson","class","course","school",
  "college","university","student","teacher","professor","work","example",
  "exercise","content","material","resource","topic","subject","area",
  "section","part","type","list","set","group","general","basic","advanced",
  "complete","final","main","key","important","using","used","use","uses",
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

function isQualityTerm(term, allPools) {
  const t = term.trim().toLowerCase();
  if (t.length <= 3) return false;
  if (/^[\d\s\W]+$/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length === 1 && GENERIC_BLOCKLIST.has(t)) return false;
  if (words.length > 1 && words.every((w) => GENERIC_BLOCKLIST.has(w))) return false;
  if (allPools) {
    const total = Object.keys(allPools).length;
    if (total > 0) {
      const count = Object.values(allPools).filter((terms) =>
        terms.some((e) => e.toLowerCase() === t)
      ).length;
      if (count / total > CROSS_LIMIT) return false;
    }
  }
  return true;
}

function loadFile(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); }
  catch { return fallback; }
}

// Discover the best available Ollama model
async function getBestModel() {
  const PREFERRED = ["llama3.2:3b","llama3.2:1b","llama3.2","llama3:latest"];
  try {
    const data = await httpGet("http://127.0.0.1:11434/api/tags");
    const models = (JSON.parse(data).models || []).map((m) => m.name);
    for (const p of PREFERRED) {
      const m = models.find((a) => a === p || a.startsWith(p.split(":")[0] + ":"));
      if (m) return m;
    }
  } catch { /* fall through */ }
  return "llama3.2:1b";
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 5000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(d));
    }).on("error", reject);
  });
}

function ollamaGenerate(model, prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.2, num_ctx: 2048 },
    });
    const options = {
      hostname: "127.0.0.1", port: 11434, path: "/api/generate",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    };
    const req = http.request(options, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d).response ?? ""); } catch { resolve(""); }
      });
    });
    req.setTimeout(GENERATE_TIMEOUT, () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function buildFolderGraph(folderName, filenames, allPools, model) {
  const sampleFiles = filenames.slice(0, MAX_SAMPLE).join("\n");

  // Phase 1: Describe
  const p1 =
    `A folder named "${folderName}" contains these files:\n${sampleFiles}\n\n` +
    `In exactly ONE sentence, describe what academic subject or topic this folder is about. ` +
    `Do NOT use the words "folder", "files", or "documents". Just describe the domain.`;

  let description;
  try {
    const raw = await ollamaGenerate(model, p1);
    description = raw.trim().split("\n")[0].trim();
    if (!description || description.length < 10) description = `Files related to ${folderName}`;
  } catch { return null; }

  // Phase 2: Generate terms
  const p2 =
    `You are building a search index for content about: ${description}\n\n` +
    `Generate exactly 40 specific search terms that appear in this type of content.\n` +
    `Requirements:\n` +
    `- 2-5 words each (multi-word phrases strongly preferred)\n` +
    `- Domain-specific only — NO generic words like "notes", "study", "homework", "guide"\n` +
    `- Include: key concepts, technical vocabulary, proper nouns, theories, methods, events\n` +
    `- Each term on its own line, no numbering, no bullets\n\n` +
    `Output ONLY the terms, one per line:`;

  let rawTerms;
  try { rawTerms = await ollamaGenerate(model, p2); }
  catch { return null; }

  const terms = rawTerms
    .split("\n")
    .map((l) => l.replace(/^[\d\.\-\*•]+\s*/, "").trim().toLowerCase())
    .filter((t) => t.length > 3 && isQualityTerm(t, allPools));

  if (terms.length === 0) return null;
  return { description, terms: [...new Set(terms)], generated: Date.now() };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Rebuild Knowledge Graph`);
  console.log(`   Root: ${ROOT_DIR}\n`);

  if (!fs.existsSync(ROOT_DIR)) {
    console.error(`✗ Directory not found: ${ROOT_DIR}`);
    console.error(`  Pass the path as: node scripts/rebuild-knowledge-graph.js /path/to/folder`);
    process.exit(1);
  }

  // Check Ollama
  let model;
  try {
    model = await getBestModel();
    console.log(`✓ Ollama connected — using model: ${model}\n`);
  } catch {
    console.error("✗ Ollama is not running. Start it with: ollama serve");
    process.exit(1);
  }

  // Load before state
  const before = loadFile(KG_FILE, { folders: {} }).folders;
  const kg = loadFile(KG_FILE, { version: 1, generated: Date.now(), folders: {} });
  const allPools = loadFile(POOL_FILE, {});

  // Enumerate subfolders
  const subfolders = fs.readdirSync(ROOT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "Needs Review")
    .map((d) => d.name);

  if (subfolders.length === 0) {
    console.log("No subfolders found. Organize some files first.");
    process.exit(0);
  }

  console.log(`Found ${subfolders.length} folders to process:\n`);

  let generated = 0, skipped = 0, errors = 0;

  for (const folderName of subfolders) {
    process.stdout.write(`  ⟳ ${folderName.padEnd(30)}`);

    const folderPath = path.join(ROOT_DIR, folderName);
    let filenames;
    try {
      filenames = fs.readdirSync(folderPath).filter((f) => !f.startsWith(".")).slice(0, MAX_SAMPLE);
    } catch {
      console.log("  [skipped — unreadable]");
      skipped++;
      continue;
    }

    if (filenames.length === 0) {
      console.log("  [skipped — empty]");
      skipped++;
      continue;
    }

    try {
      const graph = await buildFolderGraph(folderName, filenames, allPools, model);
      if (graph) {
        kg.folders[folderName] = graph;
        // Update pools for next folder's cross-pool check
        allPools[folderName] = [...new Set([...(allPools[folderName] ?? []), ...graph.terms])];
        console.log(`  ${graph.terms.length} terms`);
        generated++;
      } else {
        console.log("  [no terms]");
        errors++;
      }
    } catch (err) {
      console.log(`  [error: ${err.message}]`);
      errors++;
    }
  }

  // Save KG + flag
  kg.generated = Date.now();
  fs.writeFileSync(KG_FILE, JSON.stringify(kg, null, 2), "utf-8");
  fs.writeFileSync(KG_FLAG, JSON.stringify({ ts: Date.now() }), "utf-8");

  // Apply to global_concepts.json
  let poolsOnDisk = loadFile(POOL_FILE, {});
  let newTermsAdded = 0;
  for (const [folder, graph] of Object.entries(kg.folders)) {
    const existing = new Set((poolsOnDisk[folder] ?? []).map((t) => t.toLowerCase()));
    const newTerms = graph.terms.filter((t) => !existing.has(t) && isQualityTerm(t, poolsOnDisk));
    if (newTerms.length > 0) {
      poolsOnDisk[folder] = [...(poolsOnDisk[folder] ?? []), ...newTerms];
      newTermsAdded += newTerms.length;
    }
  }
  if (newTermsAdded > 0) {
    fs.writeFileSync(POOL_FILE, JSON.stringify(poolsOnDisk, null, 2), "utf-8");
  }

  // ── Results summary ──────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  console.log(`REBUILD COMPLETE`);
  console.log(`  Generated: ${generated} | Skipped: ${skipped} | Errors: ${errors}`);
  console.log(`  New terms added to global_concepts.json: ${newTermsAdded}`);
  console.log(`${"─".repeat(50)}\n`);

  // ── Before/After comparison ───────────────────────────────────────────────
  const SHOWCASE = ["APUSH", "PreCalc", "Biology", "Pre-Calculus", "US History", "Science"];
  const shown = new Set();

  for (const target of SHOWCASE) {
    const matched = Object.keys(kg.folders).find(
      (f) => f.toLowerCase().replace(/[\s\-_]/g, "") === target.toLowerCase().replace(/[\s\-_]/g, "")
    );
    if (!matched || shown.has(matched)) continue;
    shown.add(matched);

    const beforeTerms = before[matched]?.terms ?? [];
    const afterTerms  = kg.folders[matched].terms;
    const newCount    = afterTerms.filter((t) => !beforeTerms.includes(t)).length;

    console.log(`📚 ${matched}`);
    console.log(`   Description: ${kg.folders[matched].description}`);
    console.log(`   Terms (${afterTerms.length} total, +${newCount} new):`);
    afterTerms.slice(0, 8).forEach((t) => console.log(`     • ${t}`));
    if (afterTerms.length > 8) console.log(`     … and ${afterTerms.length - 8} more`);
    console.log();
  }

  // Show any folder not in showcase list (first 3)
  const other = Object.keys(kg.folders)
    .filter((f) => !shown.has(f))
    .slice(0, 3);
  for (const f of other) {
    console.log(`📁 ${f} — ${kg.folders[f].terms.length} terms: ${kg.folders[f].terms.slice(0, 5).join(", ")}`);
  }

  console.log(`\n✓ knowledge_graph.json saved to ${ROOT_DIR}`);
  console.log(`✓ Startup flag written — app will apply terms on next launch`);
}

main().catch((err) => {
  console.error("\n✗ Fatal error:", err.message);
  process.exit(1);
});
