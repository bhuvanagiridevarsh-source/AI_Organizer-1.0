/**
 * ConceptPoolService.js — Global concepts pool I/O + filtering.
 *
 * Extracted from src/main/index.js (was ~225 lines of inline logic).
 *
 * Responsibilities:
 *   • readGlobalPool / writeGlobalPool — disk I/O for global_concepts.json
 *   • filterPoolConcepts — anti-pollution filter (stopwords + cross-category dedup)
 *   • filterConceptsWithAI — Llama-backed relevance validation
 *
 * No Electron dependencies — pure Node + LlamaService.  Unit-testable.
 */

const fs = require("fs");
const path = require("path");

function readGlobalPool(baseDir) {
  const poolPath = path.join(baseDir, "global_concepts.json");
  try {
    if (fs.existsSync(poolPath)) {
      return JSON.parse(fs.readFileSync(poolPath, "utf-8"));
    }
  } catch {}
  return {};
}

/**
 * Write the global concepts pool to global_concepts.json.
 */
function writeGlobalPool(baseDir, pool) {
  const poolPath = path.join(baseDir, "global_concepts.json");
  fs.writeFileSync(poolPath, JSON.stringify(pool, null, 2), "utf-8");
}

// ── Concept Pool Filtering (Anti-Pollution) ───────────────────
// Catches garbage concepts from Datamuse word-association drift.

/**
 * Generic terms that should NEVER appear in a subject-specific pool.
 * These are words Datamuse returns as "related" but carry zero signal.
 */
const POOL_STOP_WORDS = new Set([
  // Generic / structural
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "is", "are", "was", "were", "be", "been", "being",
  "it", "its", "this", "that", "these", "those", "not", "no", "yes",
  "part", "parts", "item", "items", "point", "points", "section", "sections",
  "page", "pages", "chapter", "chapters", "heading", "subheading", "title",
  "index", "category", "component", "figure", "topic", "aspect", "phase",
  "stage", "frame", "subdivision", "division", "dichotomy",
  // Books / publishing (word-association noise)
  "book", "booklet", "binder", "cahier", "scrapbook", "magazine", "notebook",
  "sketchbook", "pamphlet", "bookshop", "bookstore", "manuscript", "brochure",
  "cookbook", "journal", "diary", "guidebook", "edition", "publishing",
  "calligraphy", "written", "editing", "published", "publish", "writing",
  "daybook", "record", "script", "playscript", "ledger", "account book",
  "volume", "reserve", "hold", "leger", "book of account",
  // Sewing / textile (word-association noise from "stitch")
  "sew together", "sewing", "buttonhole", "mesh", "skin", "suture",
  "juncture", "overcasting", "darn", "mend", "baste", "weave", "loop",
  "fasten", "run up", "seam", "tack", "embroider", "knit", "crochet",
  "chainstitch", "overcast", "whipstitch", "lockstitch", "patch", "textile",
  // Body parts (word-association noise from "arm")
  "branch", "sleeve", "gird", "weapon", "fortify", "build up",
  "weapon system", "armpit", "forearm", "forelimb", "limb", "elbow",
  "hand", "tooth", "muscle", "bind",
  // Relationships (word-association noise from "chemistry")
  "interpersonal chemistry", "relationship", "interactions", "relationships",
  "interaction", "friendship", "camaraderie", "personality", "friendships",
  "charisma", "communication", "interrelationship", "charismatic",
  "congeniality", "communicative", "sociability", "sociality",
  "interpersonally", "intercommunication", "interpersonal skills",
  "human relationship", "physical attraction", "social intercourse",
  "personal magnetism", "magnetic attraction", "friendly relationship",
  "communicativeness", "companionability",
  // Screen / image (word-association noise)
  "pickup", "image", "picture", "display", "screen", "capture", "catch",
  "capturing", "screengrab", "snapshot", "screen motion capture",
  "loading screen", "screensaver", "screen-scraper", "workscreen",
  "touch screen", "lock screen", "split screen", "savefile", "desktop picture",
  // Music (word-association noise)
  "composition", "piece", "musical composition", "piece of music",
  "opposite", "opposition", "creation", "oeuvre", "masterpiece",
  "production", "rhapsody", "fantasia", "cantata",
  // Photography (word-association noise)
  "photo", "profile", "portrait", "footage", "photograph", "pictures",
  "form", "photos", "global image", "gram", "graphic", "gifset",
  "'gram", "gravatar", "gimp", "visual", "anigif", "geotag",
  "graymap", "gpmg",
  // Deep / abstract (word-association noise from biology "deep")
  "profound", "large", "distant", "recondite", "heavy", "intense",
  "abstruse", "cryptic", "sound", "cryptical", "low-pitched",
  "mystifying", "inscrutable", "late", "mysterious", "artful",
  "thick", "esoteric", "rich", "bottomless", "incomprehensible",
  "inexplicable", "unfathomed", "unsounded", "wakeless", "unplumbed",
  "colorful",
  // Release / discharge (word-association noise)
  "loose", "liberate", "liberation", "unloose", "expel", "discharge",
  "dismissal", "eject", "unblock", "departure", "exit", "relinquish",
  "give up", "expiration", "waiver", "secrete", "loss", "let go",
  "acquittance", "turn", "bring out", "passing", "issue", "going",
  "outlet", "spillage", "spill", "free", "handout",
  // Offers / proposals (word-association noise)
  "proffer", "offer up", "propose", "provide", "volunteer", "pass",
  "extend", "put up", "tender", "propose marriage", "pop the question",
  "fling", "whirl", "crack", "offeror", "proposition", "proposal",
  "bidding", "afford", "invitation",
  // Space / void (word-association noise)
  "blank", "place", "distance", "topological space", "outer space",
  "quad", "blank space", "outer", "term", "clearance", "empty",
  "upright", "vacuum", "void", "discretion", "placeholder", "espace",
  "opportunity", "seating", "flexibility", "seat", "scope",
  // Elections / candidates (word-association noise)
  "nominee", "campaigner", "prospect", "candidacy", "candidature",
  "election", "membership", "appointment", "appointee", "trainee",
  "nomination", "appellant", "proponent", "nominated", "applicant",
  "eligible", "accession", "bidder", "participant", "received",
  "interviewee", "applying", "investigator", "application",
  // Tests / trials (word-association noise)
  "try out", "examine", "trial", "experimental", "prove", "assay",
  "quiz", "tryout", "empirical", "model", "pilot", "check",
  "mental test", "mental testing", "psychometric test", "inspect", "detect",
  // Page-related (word-association noise)
  "pageboy", "varlet", "acton", "aspects", "beeps", "bellboys",
  "corporate", "headlines", "homepage", "impressions", "leafs", "leaves",
  "length", "listings", "parties", "pubs", "quarters", "screens",
  "seiten", "sheets", "shores", "sides", "site", "sites", "slides",
  // Conversion / change (word-association noise)
  "change over", "change", "exchange", "win over", "convince",
  "commute", "alter", "transform", "transformer", "conversion",
  "transforming", "changeover", "transpose", "convertible", "process",
  // Generic academic
  "academic", "academics", "acad", "acad.", "honor student", "preppy",
  "highschool", "high school", "upper school", "prep school",
  // Common noise words
  "management", "the", "general", "related", "department", "continued",
  "depending", "considered", "engaged", "activities", "applies",
]);

/**
 * Filter concepts: remove stop words, too-short terms, and cross-category duplicates.
 * @param {string} category - The category name
 * @param {string[]} concepts - Raw concepts to filter
 * @param {Object} fullPool - The entire pool (for cross-category dedup)
 * @returns {string[]} Filtered concepts
 */
function filterPoolConcepts(category, concepts, fullPool) {
  const catLower = category.toLowerCase();

  // Build cross-category frequency map
  const crossFreq = {};
  for (const [cat, catConcepts] of Object.entries(fullPool)) {
    if (cat.toLowerCase() === catLower) continue;
    for (const c of catConcepts) {
      const k = c.toLowerCase();
      crossFreq[k] = (crossFreq[k] || 0) + 1;
    }
  }

  return concepts.filter((concept) => {
    const lower = concept.toLowerCase().trim();

    // Remove empty or too-short
    if (lower.length < 3) return false;

    // Remove stop words
    if (POOL_STOP_WORDS.has(lower)) return false;

    // Remove single generic words that appear in 3+ OTHER categories
    if ((crossFreq[lower] || 0) >= 3 && !lower.includes(" ")) return false;

    // Remove concepts that are just numbers
    if (/^\d+$/.test(lower)) return false;

    return true;
  });
}

/**
 * Use Ollama to validate concepts for a category.
 * Sends concepts in a batch and asks the LLM which ones are actually relevant.
 * Falls back to basic filtering if Ollama is unavailable.
 */
async function filterConceptsWithAI(category, concepts) {
  // Only filter if we have a reasonable number of concepts
  if (concepts.length === 0) return concepts;

  // Batch into chunks of 80 to avoid prompt size issues
  const BATCH_SIZE = 80;
  const validated = [];

  for (let i = 0; i < concepts.length; i += BATCH_SIZE) {
    const batch = concepts.slice(i, i + BATCH_SIZE);
    const numbered = batch.map((c, idx) => `${idx + 1}. ${c}`).join("\n");

    const prompt = `You are a strict academic concept validator. Given the subject "${category}", determine which of these terms are DIRECTLY relevant to studying or working with "${category}".

TERMS:
${numbered}

RULES:
- KEEP terms that are specific to "${category}" (subtopics, key concepts, techniques, vocabulary)
- REMOVE terms that are generic (e.g., "management", "study", "school", "book")
- REMOVE terms that belong to unrelated fields
- REMOVE terms that are nonsensical or word-association noise
- REMOVE terms in foreign languages unless they are standard terminology for "${category}"
- REMOVE terms related to body parts, sewing, photography, music, relationships unless directly relevant

Respond with ONLY a JSON array of the KEPT term numbers. Example: [1, 3, 5, 8]
If none are relevant, respond: []`;

    try {
      const LlamaService = require("./services/LlamaService");
      const result = LlamaService.isReady()
        ? await LlamaService.generate(prompt, { maxTokens: 500, temperature: 0.1, timeoutMs: 30_000 })
        : "";

      // Parse the response — extract the JSON array of indices
      const match = String(result).match(/\[[\d,\s]*\]/);
      if (match) {
        const indices = JSON.parse(match[0]);
        for (const idx of indices) {
          if (typeof idx === "number" && idx >= 1 && idx <= batch.length) {
            validated.push(batch[idx - 1]);
          }
        }
      } else {
        // AI response wasn't parseable — keep the batch (filtered by basic rules)
        validated.push(...batch);
      }
    } catch {
      // Model unavailable — keep the batch
      validated.push(...batch);
    }
  }

  console.log(`[main] AI Filter: "${category}" — ${concepts.length} → ${validated.length} concepts (${concepts.length - validated.length} removed)`);
  return validated;
}

module.exports = {
  readGlobalPool,
  writeGlobalPool,
  filterPoolConcepts,
  filterConceptsWithAI,
  POOL_STOP_WORDS,
};
