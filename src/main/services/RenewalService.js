/**
 * RenewalService.js — Renewal Radar: find dates that MATTER in the user's
 * documents (expirations, renewals, due dates) so nothing lapses unnoticed.
 *
 * Input: the search index the app already maintains (filename + fullText per
 * organized file). Pure regex extraction — no LLM call, no network. Runs a
 * full pass in milliseconds and is fully testable.
 *
 * Output: renewals.json in userData —
 *   [{ filePath, fileName, folder, kind, dateMs, dateISO, context }]
 * sorted soonest-first. The UI shows upcoming ones; the scheduler notifies
 * when something is < 30 days out.
 */

const fs = require("fs");
const path = require("path");
const { _scan } = require("./DateExtractService");

// Phrases that mark a date as an OBLIGATION, and what kind it is.
// Order matters: first match wins.
const TRIGGERS = [
  { re: /(expires?|expiry|expiration)(\s+(date|on))?\s*[:\-–—]?\s*/i, kind: "expiry" },
  { re: /(valid (through|until|thru)|good (through|until))\s*[:\-–—]?\s*/i, kind: "expiry" },
  { re: /(renewal|renews?|renew by|next billing)(\s+(date|on))?\s*[:\-–—]?\s*/i, kind: "renewal" },
  { re: /(due (date|on|by)|payment due|due)\s*[:\-–—]?\s*/i, kind: "due" },
  { re: /(warranty (ends|expires|through|until))\s*[:\-–—]?\s*/i, kind: "warranty" },
  { re: /(coverage (ends|through|until)|policy (period|expires)( to)?)\s*[:\-–—]?\s*/i, kind: "insurance" },
  { re: /(contract (ends|term ends|expires)|termination date|end date)\s*[:\-–—]?\s*/i, kind: "contract" },
];

// How far ahead a date can be and still be plausible as an obligation (15 y —
// leases and IDs can be long) and how far past we still surface it (90 d,
// so a just-lapsed warranty still shows as "recently expired").
const MAX_FUTURE_MS = 15 * 365 * 24 * 3600 * 1000;
const KEEP_PAST_MS = 90 * 24 * 3600 * 1000;

const STORE_FILE = "renewals.json";

function _storePath(userDataDir) {
  return path.join(userDataDir, STORE_FILE);
}

/**
 * Scan one document's text for obligation dates.
 * @returns {Array<{kind: string, dateMs: number, context: string}>}
 */
function extractRenewals(text, nowMs = Date.now()) {
  if (!text) return [];
  const out = [];
  const seen = new Set(); // dedupe same kind+date within a doc

  for (const { re, kind } of TRIGGERS) {
    // Walk every occurrence of this trigger
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m;
    while ((m = g.exec(text)) !== null) {
      // The date should follow the trigger closely (within 40 chars)
      const window = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
      const d = _scan(window);
      if (!d) continue;
      if (d.ms > nowMs + MAX_FUTURE_MS) continue;
      if (d.ms < nowMs - KEEP_PAST_MS) continue;
      const key = `${kind}:${d.ms}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Human context: trigger phrase + a bit around it, tidied
      const ctxStart = Math.max(0, m.index - 30);
      const context = text
        .slice(ctxStart, m.index + m[0].length + 40)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 110);
      out.push({ kind, dateMs: d.ms, context });
      if (out.length >= 8) return out; // one doc can't flood the radar
    }
  }
  return out;
}

/**
 * Full pass over the search index entries.
 * @param {Array<{filename:string, folder:string, fullPath:string, fullText?:string, snippet?:string}>} entries
 * @returns sorted renewal items
 */
function buildRadar(entries, nowMs = Date.now()) {
  const items = [];
  for (const e of entries || []) {
    const text = e.fullText || e.snippet || "";
    if (!text) continue;
    for (const r of extractRenewals(text, nowMs)) {
      items.push({
        filePath: e.fullPath,
        fileName: e.filename,
        folder: e.folder,
        kind: r.kind,
        dateMs: r.dateMs,
        dateISO: new Date(r.dateMs).toISOString().slice(0, 10),
        context: r.context,
      });
    }
  }
  items.sort((a, b) => a.dateMs - b.dateMs);
  return items;
}

/** Persist + load the last radar so the UI opens instantly. */
function saveRadar(userDataDir, items) {
  try {
    fs.writeFileSync(_storePath(userDataDir), JSON.stringify({ builtAt: Date.now(), items }, null, 2));
  } catch (err) {
    console.warn(`[RenewalService] save failed: ${err.message}`);
  }
}

function loadRadar(userDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(_storePath(userDataDir), "utf8"));
    return raw && Array.isArray(raw.items) ? raw : { builtAt: 0, items: [] };
  } catch {
    return { builtAt: 0, items: [] };
  }
}

/** Items due within `days` — for the scheduler's notification. */
function upcoming(items, days = 30, nowMs = Date.now()) {
  const horizon = nowMs + days * 24 * 3600 * 1000;
  return (items || []).filter((i) => i.dateMs >= nowMs && i.dateMs <= horizon);
}

module.exports = { extractRenewals, buildRadar, saveRadar, loadRadar, upcoming };
