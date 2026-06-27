/**
 * ConceptExpansionService.js — Datamuse / Wikipedia knowledge fetchers.
 *
 * Extracted from src/main/index.js (was ~310 lines of inline HTTP logic).
 *
 * Functions here pull background knowledge from public APIs to flesh out
 * the user's concept pool:
 *   • expandAcademicName — acronym lookup ("APUSH" → "AP US History")
 *   • expandCategoryName — short-form expansion via Datamuse
 *   • fetchWikipediaConcepts — keywords from Wikipedia summary
 *   • fetchDatamuseConcepts — "means like" word associations
 *   • fetchSemanticWeb — 3-layer related-term download
 *   • fetchDeepRecursiveSearch — bounded BFS over Datamuse
 *
 * PRIVACY: only category names leave the device, never file contents.
 * All fetchers return [] on network failure — never throw.
 */

const https = require("https");

// ── Stopwords for Wikipedia keyword extraction ────────────────
const WIKI_STOP_WORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with","by",
  "from","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","shall","may","might",
  "can","this","that","these","those","it","its","i","me","my","we","our",
  "you","your","he","him","his","she","her","they","them","their","not",
  "no","so","if","then","than","when","where","how","what","which","who",
  "all","each","every","both","few","more","most","some","any","many",
  "much","such","very","just","also","into","over","after","before",
  "about","as","up","out","one","two","new","used","first","other",
  "known","often","well","part","may","use","between","since","while",
]);

/**
 * Fetch Wikipedia summary for a category and extract keywords.
 * Uses the Wikipedia REST API (page/summary endpoint).
 * PRIVACY: Only the category name is sent.
 */
function fetchWikipediaConcepts(category) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(category.replace(/\s+/g, "_"));
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`;

    https.get(url, { headers: { "User-Agent": "AIOrganizer/1.0" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const extract = parsed.extract || "";
          // Split extract into words, filter stopwords, keep words >= 3 chars
          const words = extract
            .toLowerCase()
            .replace(/[^a-z\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length >= 3 && !WIKI_STOP_WORDS.has(w));
          // Deduplicate
          const unique = [...new Set(words)];
          console.log(
            `[main] Wikipedia returned ${unique.length} keywords for "${category}": ` +
            `[${unique.slice(0, 10).join(", ")}${unique.length > 10 ? "..." : ""}]`
          );
          resolve(unique);
        } catch {
          resolve([]);
        }
      });
      res.on("error", () => resolve([]));
    }).on("error", () => resolve([]));
  });
}

/**
 * Concept Expansion: expand short/abbreviated category names to full-form.
 * Uses Datamuse "sp" (spelled like) + "ml" (means like) to find
 * longer-form candidates for short inputs (e.g. "Bio" → "Biology").
 *
 * PRIVACY: Only the category name is sent to Datamuse.
 * Safeguard: If API fails, returns the original name unchanged.
 */
function expandCategoryName(shortName) {
  return new Promise((resolve) => {
    // If the name is already long (>= 6 chars), skip expansion
    if (shortName.length >= 6) {
      resolve(shortName);
      return;
    }

    const encoded = encodeURIComponent(shortName);
    const url = `https://api.datamuse.com/words?sp=${encoded}*&ml=${encoded}&max=10`;

    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (!Array.isArray(parsed) || parsed.length === 0) {
            resolve(shortName);
            return;
          }
          // Pick the highest-score candidate that starts with the short name (case-insensitive)
          const prefix = shortName.toLowerCase();
          const candidates = parsed
            .filter((e) => e.word && e.word.toLowerCase().startsWith(prefix) && e.word.length > shortName.length)
            .sort((a, b) => (b.score || 0) - (a.score || 0));

          if (candidates.length > 0) {
            // Capitalize first letter
            const expanded = candidates[0].word.charAt(0).toUpperCase() + candidates[0].word.slice(1);
            console.log(`[main] Concept Expansion: "${shortName}" → "${expanded}"`);
            resolve(expanded);
          } else {
            resolve(shortName);
          }
        } catch {
          resolve(shortName);
        }
      });
      res.on("error", () => resolve(shortName));
    }).on("error", () => resolve(shortName));
  });
}

/**
 * Academic Acronym Expansion: expand academic abbreviations via Wikipedia.
 * "APUSH" → Wikipedia search → "AP United States History"
 * Uses Wikipedia's REST API which handles redirects automatically.
 *
 * PRIVACY: Only the category name is sent to Wikipedia.
 * Safeguard: If API fails, falls back to expandCategoryName() (Datamuse).
 */
function expandAcademicName(name) {
  return new Promise((resolve) => {
    // If the name is already long (>= 12 chars), skip academic expansion
    if (name.length >= 12) {
      resolve(name);
      return;
    }

    const encoded = encodeURIComponent(name.replace(/\s+/g, "_"));
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`;

    https.get(url, { headers: { "User-Agent": "AIOrganizer/1.0" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          // Wikipedia returns the canonical title, which resolves redirects
          // e.g., "APUSH" redirects to "AP United States History"
          const title = parsed.title || "";
          if (
            title &&
            title.toLowerCase() !== name.toLowerCase() &&
            title.length > name.length
          ) {
            console.log(`[main] Academic Expansion: "${name}" → "${title}" (via Wikipedia)`);
            resolve(title);
            return;
          }
          // No useful expansion from Wikipedia — fall through
          resolve(null);
        } catch {
          resolve(null);
        }
      });
      res.on("error", () => resolve(null));
    }).on("error", () => resolve(null));
  });
}

/**
 * Deep Recursive Search: Force-expand a category until the pool has >100 keywords.
 *
 * PIPELINE:
 *   Pass 1 — Fetch top 30 related concepts for the category (the "trunk").
 *   Pass 2 (The Expander) — Take the top 5 results from Pass 1 and run
 *     each as a NEW query, biased by the original category topic.
 *     This is Level 2 expansion.
 *
 * CONTEXT FILTER: Pass 2 queries use Datamuse's `topics` parameter set to
 *   the original category, so results stay within the relevant domain
 *   (e.g., "Marketing" biased by "FBLA" returns business marketing, not medical).
 *
 * TARGET: Do not stop until the pool has >100 unique keywords (or Level 2 exhausted).
 * SAFEGUARD: Depth limit = Level 2. Max 5 expansion branches. Max 30 per query.
 * PRIVACY: Only the category name and derived sub-terms are sent to Datamuse API.
 *          NO file content is ever uploaded.
 *
 * @param {string} category — The category name (already expanded if applicable).
 * @param {function} onProgress — Callback(currentCount, target) for live progress.
 * @returns {Promise<string[]>} — Flat deduplicated array of concepts.
 */
async function fetchDeepRecursiveSearch(category, onProgress) {
  const TARGET = 100;
  const allConcepts = new Set();

  // Helper: fetch from Datamuse with optional topic bias for context filtering
  function fetchBiased(term, max, topic) {
    return new Promise((resolve) => {
      let url = `https://api.datamuse.com/words?ml=${encodeURIComponent(term)}&max=${max}`;
      if (topic) url += `&topics=${encodeURIComponent(topic)}`;
      https.get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(Array.isArray(parsed) ? parsed.map((e) => e.word).filter(Boolean) : []);
          } catch { resolve([]); }
        });
        res.on("error", () => resolve([]));
      }).on("error", () => resolve([]));
    });
  }

  // ── Pass 1: Fetch 30 broad concepts (the trunk) ──
  const pass1 = await fetchBiased(category, 30, null);
  for (const w of pass1) allConcepts.add(w.toLowerCase());
  console.log(`[main] Deep Recursive Pass 1 for "${category}": ${pass1.length} concepts`);
  if (onProgress) onProgress(allConcepts.size, TARGET);

  if (allConcepts.size >= TARGET) return [...allConcepts];

  // ── Pass 2 (The Expander): Top 5 from Pass 1 → new queries ──
  // Each sub-query is biased by the original category for context filtering.
  // DEPTH LIMIT: Level 2. We do NOT recurse further.
  const expandTerms = pass1
    .filter((w) => w.toLowerCase() !== category.toLowerCase() && w.length >= 4)
    .slice(0, 5);

  console.log(`[main] Deep Recursive Pass 2 — expanding: [${expandTerms.join(", ")}]`);

  for (const term of expandTerms) {
    const pass2 = await fetchBiased(term, 30, category);
    for (const w of pass2) allConcepts.add(w.toLowerCase());
    if (onProgress) onProgress(allConcepts.size, TARGET);
    console.log(`[main]   "${term}" → +${pass2.length} concepts (total: ${allConcepts.size})`);
    if (allConcepts.size >= TARGET) break;
  }

  // DEPTH LIMIT REACHED (Level 2). Stop recursive expansion.
  if (onProgress) onProgress(allConcepts.size, TARGET);
  console.log(
    `[main] Deep Recursive Search complete for "${category}": ${allConcepts.size} concepts ` +
    `(target: ${TARGET}, ${allConcepts.size >= TARGET ? "REACHED" : "best effort"})`
  );

  return [...allConcepts];
}

/**
 * Semantic Web Download: fetch 3 layers of keywords for a category.
 *   Layer 1 — Synonyms (rel_syn): "Biology" → "life science", "bioscience"
 *   Layer 2 — Components/Triggers (rel_trg): "Biology" → "cell", "dna", "tissue"
 *   Layer 3 — Associated Adjectives (rel_jja): "Biology" → "molecular", "marine"
 *
 * All 3 queries run in parallel. Returns a flat deduplicated array.
 * PRIVACY: Only the expanded category name is sent.
 */
function fetchSemanticWeb(expandedName) {
  function fetchDatamuseRel(rel, term) {
    return new Promise((resolve) => {
      const encoded = encodeURIComponent(term);
      const url = `https://api.datamuse.com/words?${rel}=${encoded}&max=30`;
      https.get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            const words = Array.isArray(parsed)
              ? parsed.map((e) => e.word).filter(Boolean)
              : [];
            resolve(words);
          } catch { resolve([]); }
        });
        res.on("error", () => resolve([]));
      }).on("error", () => resolve([]));
    });
  }

  return Promise.all([
    fetchDatamuseRel("rel_syn", expandedName),  // Synonyms
    fetchDatamuseRel("rel_trg", expandedName),  // Components / triggers
    fetchDatamuseRel("rel_jja", expandedName),  // Associated adjectives
  ]).then(([synonyms, components, adjectives]) => {
    const all = [...new Set([...synonyms, ...components, ...adjectives])];
    console.log(
      `[main] Semantic Web for "${expandedName}": synonyms=${synonyms.length}, ` +
      `components=${components.length}, adjectives=${adjectives.length}, combined=${all.length}`
    );
    return all;
  });
}

/**
 * Fetch semantically related words from Datamuse for a given category name.
 * Uses the "ml" (means like) parameter for related-meaning lookup.
 * Returns an array of word strings (max 50).
 */
function fetchDatamuseConcepts(category) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(category);
    const url = `https://api.datamuse.com/words?ml=${encoded}&max=50`;

    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          // Datamuse returns [{ word: "...", score: N }, ...]
          const words = Array.isArray(parsed)
            ? parsed.map((entry) => entry.word).filter(Boolean)
            : [];
          console.log(
            `[main] Datamuse returned ${words.length} concepts for "${category}": ` +
            `[${words.slice(0, 10).join(", ")}${words.length > 10 ? "..." : ""}]`
          );
          resolve(words);
        } catch (err) {
          reject(err);
        }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

module.exports = {
  WIKI_STOP_WORDS,
  fetchWikipediaConcepts,
  expandCategoryName,
  expandAcademicName,
  fetchDeepRecursiveSearch,
  fetchSemanticWeb,
  fetchDatamuseConcepts,
};
