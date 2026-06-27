/**
 * pii.js — PII (personally identifiable information) detection.
 *
 * Extracted from renderer.js so the detectors live somewhere reviewable.
 * Today this is just an SSN regex; the audit flagged the single-rule
 * coverage and this file is now the natural home for adding more rules
 * (credit cards, phone numbers, account numbers, etc.) without touching
 * the 5,700-line renderer.
 *
 * Loaded before renderer.js via a <script> tag in index.html; functions
 * are exposed on window.SJ.pii for the renderer to consume.
 *
 * Adding a new detector:
 *   1. Add the regex to DETECTORS with a human label
 *   2. Add a unit test under test/pii.test.js (when the renderer
 *      gets a test harness)
 */

(function (root) {
  "use strict";

  // ── Detector registry ────────────────────────────────────────────────
  // Each detector: { name, regex }.  hasPII returns true on first match.
  // detectAll returns the set of detector names that matched, useful for
  // the audit log and UI banners.
  const DETECTORS = [
    {
      name: "SSN",
      // US Social Security Number: 3-2-4 digits with optional dashes/spaces.
      regex: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/,
    },
    // Future detectors land here.  Examples (not yet enabled):
    //   { name: "CreditCard", regex: /\b(?:\d[ -]*?){13,16}\b/ },
    //   { name: "Email",      regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  ];

  /** Backward-compat alias kept for renderer code that still imports it. */
  const SSN_REGEX = DETECTORS[0].regex;

  function hasPII(text) {
    const t = text || "";
    for (const d of DETECTORS) {
      if (d.regex.test(t)) return true;
    }
    return false;
  }

  /** Return the names of all detectors that matched.  Useful for logging. */
  function detectAll(text) {
    const t = text || "";
    const hits = [];
    for (const d of DETECTORS) {
      if (d.regex.test(t)) hits.push(d.name);
    }
    return hits;
  }

  root.SJ = root.SJ || {};
  root.SJ.pii = { hasPII, detectAll, SSN_REGEX, DETECTORS };
})(typeof window !== "undefined" ? window : globalThis);
