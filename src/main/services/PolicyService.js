'use strict';
/**
 * PolicyService — the RAG agent's distilled, durable memory.
 *
 * Raw file retrieval is great for "what does this document say," but the magic
 * moment ("the office is gluten-free, so don't suggest regular cookies") needs
 * DURABLE FACTS, not passages. This service reads a namespace's indexed files
 * and uses the local model to distill them into small, reusable "policy cards":
 *
 *     { id, text, category, sourceFile, namespaceId, extractedAt, manual }
 *
 * Cards are stored per-namespace in userData/knowledge_cards.json. At enhancement
 * time we keyword-match the user's prompt against the cards and surface only the
 * relevant ones as opt-in toggles. Everything is local; cards never leave the
 * device. The whole service degrades gracefully: if the model isn't ready or no
 * files exist, callers just get an empty list.
 */

const fs   = require('fs');
const path = require('path');
const { app } = require('electron');

// ── Storage ──────────────────────────────────────────────────────────────────

function storePath() {
  return path.join(app.getPath('userData'), 'knowledge_cards.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf-8'));
  } catch {
    return { namespaces: {} };
  }
}

function save(data) {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[PolicyService] save failed:', e?.message);
  }
}

function makeId(nsId, text) {
  let hash = 0;
  const s = `${nsId}:${text}`;
  for (const c of s) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return 'pc_' + Math.abs(hash).toString(36);
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const STOP = new Set(['the','a','an','and','or','but','for','of','to','in','on','at',
  'is','are','be','with','by','from','this','that','our','your','my','we','will','must',
  'should','all','any','no','not','it','as','if','per','use','only','do','does']);

function tokenize(text) {
  return normalize(text).split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOP.has(t));
}

// ── Read / write cards ────────────────────────────────────────────────────────

/** All policy cards for a namespace. */
function getPolicies(namespaceId) {
  if (!namespaceId) return [];
  const data = load();
  return (data.namespaces[namespaceId] && data.namespaces[namespaceId].policies) || [];
}

/** Most recent extraction time for a namespace (ms) or 0. */
function lastBuilt(namespaceId) {
  const data = load();
  return (data.namespaces[namespaceId] && data.namespaces[namespaceId].lastBuilt) || 0;
}

/**
 * searchPolicies — return the cards most relevant to a prompt, scored by token
 * overlap. This keeps us from dumping every policy into every enhancement.
 */
function searchPolicies(namespaceId, promptText, limit = 5) {
  const policies = getPolicies(namespaceId);
  if (policies.length === 0) return [];
  const qTokens = new Set(tokenize(promptText));

  const scored = policies.map(p => {
    const pTokens = tokenize(`${p.text} ${p.category || ''}`);
    let overlap = 0;
    for (const t of pTokens) if (qTokens.has(t)) overlap++;
    // Category-level affinity: food/diet words pull in dietary policies, etc.
    return { policy: p, score: overlap };
  });

  // If nothing overlaps at all, still surface a couple of broadly-applicable
  // cards (budget, tone, compliance) so ambient prompts aren't left bare.
  const hits = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  if (hits.length > 0) return hits.slice(0, limit).map(s => s.policy);

  const broadCats = new Set(['budget', 'tone', 'compliance', 'general']);
  return policies.filter(p => broadCats.has((p.category || '').toLowerCase())).slice(0, 2);
}

/** Add a user-authored policy card. */
function addManualPolicy(namespaceId, text, category = 'general') {
  if (!namespaceId || !text) return null;
  const data = load();
  const bucket = data.namespaces[namespaceId] = data.namespaces[namespaceId] || { policies: [], lastBuilt: 0 };
  const card = {
    id: makeId(namespaceId, text),
    text: String(text).trim(),
    category, sourceFile: null, namespaceId,
    manual: true, extractedAt: Date.now(),
  };
  if (!bucket.policies.some(p => normalize(p.text) === normalize(card.text))) {
    bucket.policies.push(card);
    save(data);
  }
  return card;
}

/** Remove a policy card by id. */
function removePolicy(namespaceId, policyId) {
  const data = load();
  const bucket = data.namespaces[namespaceId];
  if (!bucket) return false;
  const before = bucket.policies.length;
  bucket.policies = bucket.policies.filter(p => p.id !== policyId);
  save(data);
  return bucket.policies.length < before;
}

// ── Extraction ────────────────────────────────────────────────────────────────

const MAX_FILES_PER_BUILD = 12;
const MAX_CHARS_PER_FILE  = 1500;

/**
 * extractPoliciesForNamespace — the RAG agent's "learn" step.
 *
 * entries: array of indexed files already filtered to this namespace, each
 *          { filename, folder, fullText?, snippet? }.
 * Returns { added, total, skipped }.
 */
async function extractPoliciesForNamespace(namespaceId, entries) {
  if (!namespaceId || !Array.isArray(entries) || entries.length === 0) {
    return { added: 0, total: getPolicies(namespaceId).length, skipped: true };
  }

  let LlamaService;
  try { LlamaService = require('./LlamaService'); } catch { LlamaService = null; }
  if (!LlamaService || !LlamaService.isReady || !LlamaService.isReady()) {
    return { added: 0, total: getPolicies(namespaceId).length, skipped: true };
  }

  // Build a compact, source-labeled corpus from the namespace's files.
  const picked = entries.slice(0, MAX_FILES_PER_BUILD);
  const corpus = picked.map((e, i) => {
    const body = (e.fullText || e.snippet || '').replace(/\s+/g, ' ').slice(0, MAX_CHARS_PER_FILE);
    return `[FILE ${i + 1}: ${e.filename}]\n${body}`;
  }).join('\n\n');

  const prompt =
    `You are building a durable "policy memory" for a workplace. From the documents below, extract ` +
    `ONLY durable rules, constraints, facts, or preferences that would matter when writing messages, ` +
    `planning events, or making requests for this workplace. Good examples: dietary policies ` +
    `("office is gluten-free"), budget caps ("team events max $150"), brand/tone rules, key contacts, ` +
    `recurring deadlines, dress code, compliance requirements. Ignore one-off details, dates of past ` +
    `events, and anything not reusable.\n\n` +
    `Documents:\n${corpus}\n\n` +
    `Reply with ONLY valid JSON, no markdown:\n` +
    `{"policies":[{"text":"short imperative fact","category":"diet|budget|tone|contact|deadline|compliance|dresscode|general","sourceFile":"FILE n filename"}]}`;

  let parsed = [];
  try {
    const raw = await LlamaService.generate(prompt, { maxTokens: 700, temperature: 0.1, timeoutMs: 30000 });
    const m = raw && raw.match(/\{[\s\S]*\}/);
    if (m) parsed = (JSON.parse(m[0]).policies) || [];
  } catch (e) {
    console.warn('[PolicyService] extraction failed:', e?.message);
    return { added: 0, total: getPolicies(namespaceId).length, skipped: true };
  }

  const data = load();
  const bucket = data.namespaces[namespaceId] = data.namespaces[namespaceId] || { policies: [], lastBuilt: 0 };
  const existing = new Set(bucket.policies.map(p => normalize(p.text)));

  let added = 0;
  for (const p of parsed) {
    if (!p || !p.text) continue;
    const text = String(p.text).trim();
    if (text.length < 4 || existing.has(normalize(text))) continue;
    // Resolve "FILE n filename" back to a real filename when possible
    let sourceFile = p.sourceFile || null;
    if (sourceFile) {
      const hit = picked.find(e => sourceFile.includes(e.filename));
      if (hit) sourceFile = hit.filename;
    }
    bucket.policies.push({
      id: makeId(namespaceId, text),
      text,
      category: (p.category || 'general').toLowerCase(),
      sourceFile,
      namespaceId,
      manual: false,
      extractedAt: Date.now(),
    });
    existing.add(normalize(text));
    added++;
  }
  bucket.lastBuilt = Date.now();
  save(data);
  return { added, total: bucket.policies.length, skipped: false };
}

module.exports = {
  getPolicies,
  lastBuilt,
  searchPolicies,
  addManualPolicy,
  removePolicy,
  extractPoliciesForNamespace,
};
