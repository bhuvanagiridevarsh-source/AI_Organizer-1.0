/**
 * DateExtractService.js — find THE document date in extracted text/filenames.
 *
 * Pure regex + heuristics, no LLM: deterministic, instant, testable.
 * Powers chronological filing (Category/2026/ or Category/2026-03/) and
 * feeds Renewal Radar's date parsing.
 *
 * Strategy (first hit wins):
 *   1. Filename dates — "2026-03-15_invoice.pdf", "IMG_20260315", "03-15-2026"
 *   2. Labeled dates in text — "Date: March 5, 2026", "Issued on 2026-03-05"
 *   3. Any prominent date in the first 800 chars
 *   4. null → caller falls back to file mtime
 *
 * Sanity window: 1990..(now + 20y). Anything outside is noise (phone numbers,
 * invoice IDs, version strings).
 */

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

const MIN_YEAR = 1990;
function maxYear() { return new Date().getFullYear() + 20; }

function _valid(y, m, d) {
  if (y < MIN_YEAR || y > maxYear()) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Reject rollovers like Feb 31 → Mar 3
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { year: y, month: m, day: d, ms: dt.getTime() };
}

/** Try every supported pattern against a string; return first valid date. */
function _scan(s) {
  if (!s) return null;

  // NOTE: \b fails around underscores ("2026-03-15_invoice", "IMG_20260315")
  // because _ is a word character. Use digit lookarounds instead — the real
  // constraint is "not embedded in a longer digit run".

  // ISO / dashed-dotted: 2026-03-15, 2026/03/15, 2026.03.15
  let m = s.match(/(?<!\d)(19\d{2}|20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/);
  if (m) {
    const d = _valid(+m[1], +m[2], +m[3]);
    if (d) return d;
  }

  // Compact: 20260315 (common in camera/scanner names) — require 19|20 prefix
  m = s.match(/(?<!\d)(19\d{2}|20\d{2})(\d{2})(\d{2})(?!\d)/);
  if (m) {
    const d = _valid(+m[1], +m[2], +m[3]);
    if (d) return d;
  }

  // Written: "March 5, 2026" / "5 March 2026" / "Mar 5 2026"
  const monthNames = Object.keys(MONTHS).join("|");
  m = s.match(new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(19\\d{2}|20\\d{2})\\b`, "i"));
  if (m) {
    const d = _valid(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
    if (d) return d;
  }
  m = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})\\.?,?\\s+(19\\d{2}|20\\d{2})\\b`, "i"));
  if (m) {
    const d = _valid(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
    if (d) return d;
  }

  // US numeric: 03/15/2026 or 3-15-2026 (month-first; ambiguous 04/05 handled
  // as US format since that's the dominant convention in our user base)
  m = s.match(/(?<!\d)(\d{1,2})[-/](\d{1,2})[-/](19\d{2}|20\d{2})(?!\d)/);
  if (m) {
    const first = +m[1], second = +m[2];
    // If "month" position is impossible (>12), it's day-first — swap.
    const d = first > 12 ? _valid(+m[3], second, first) : _valid(+m[3], first, second);
    if (d) return d;
  }

  // Month + year only: "March 2026" → day 1
  m = s.match(new RegExp(`\\b(${monthNames})\\.?\\s+(19\\d{2}|20\\d{2})\\b`, "i"));
  if (m) {
    const d = _valid(+m[2], MONTHS[m[1].toLowerCase()], 1);
    if (d) return d;
  }

  return null;
}

/**
 * Labeled dates outrank incidental ones: "Date:", "Issued", "Invoice date",
 * "Due", "Statement period", etc.
 */
function _scanLabeled(text) {
  const re = /(?:date[d]?|issued|invoice date|statement date|created|effective|period ending|as of)\s*[:\-–—]?\s*([^\n]{0,40})/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const d = _scan(m[1]);
    if (d) return d;
  }
  return null;
}

/**
 * Extract the best "document date".
 * @param {string} filename
 * @param {string} [text] — extracted text content (may be empty)
 * @returns {{year:number, month:number, day:number, ms:number, source:"filename"|"label"|"text"}|null}
 */
function extractDocumentDate(filename, text) {
  const fromName = _scan(filename || "");
  if (fromName) return { ...fromName, source: "filename" };

  const head = (text || "").slice(0, 4000);
  const labeled = _scanLabeled(head);
  if (labeled) return { ...labeled, source: "label" };

  const fromText = _scan(head.slice(0, 800));
  if (fromText) return { ...fromText, source: "text" };

  return null;
}

/**
 * Sub-path for chronological filing.
 * @param {{year:number, month:number}} d
 * @param {"year"|"year-month"} granularity
 */
function chronoSubfolder(d, granularity = "year") {
  if (!d) return "";
  if (granularity === "year-month") {
    return `${d.year}-${String(d.month).padStart(2, "0")}`;
  }
  return String(d.year);
}

module.exports = { extractDocumentDate, chronoSubfolder, _scan };
