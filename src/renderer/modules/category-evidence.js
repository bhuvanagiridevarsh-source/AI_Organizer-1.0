/**
 * category-evidence.js — Category → evidence keyword dictionaries.
 *
 * Extracted from renderer.js so the dictionaries can grow without
 * inflating the 5,700-line UI monolith.  These keyword lists power the
 * "Why was this filed here?" explanation chips in the file review pane.
 *
 * Loaded before renderer.js via a <script> tag in index.html.  Exports
 * on window.SJ.evidence.
 *
 * Adding a new category:
 *   1. Add a key + keyword array to CATEGORY_EVIDENCE
 *   2. The renderer's extractEvidenceKeywords picks it up automatically
 *      via substring match against the user's folder name.
 */

(function (root) {
  "use strict";

  /**
   * Hardcoded fallback dictionaries.  Used when a file's folder name
   * substring-matches a key here.  When no key matches, the renderer
   * falls back to noun-frequency extraction from the file content
   * (see renderer.js → extractEvidenceKeywords).
   */
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

  /** Shared stopword list used by the noun-frequency fallback. */
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

  root.SJ = root.SJ || {};
  root.SJ.evidence = { CATEGORY_EVIDENCE, STOP_WORDS };
})(typeof window !== "undefined" ? window : globalThis);
