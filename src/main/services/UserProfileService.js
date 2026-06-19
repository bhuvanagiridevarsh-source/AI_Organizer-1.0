'use strict';
/**
 * UserProfileService — the identity layer ("who is this person").
 *
 * The rest of the app already models FOLDERS (ContextService, KnowledgeGraph),
 * COMPANIES (NamespaceService) and durable RULES (PolicyService). What was
 * missing is a compact model of the *user themselves*: their role, the projects
 * they're actively working on, the people they work with, the topics they know,
 * and how they write. That context is exactly what every downstream LLM is
 * missing when the user pastes a bare prompt into ChatGPT/Claude — so we infer
 * it once, locally, and inject it at enhancement time.
 *
 * DESIGN PRINCIPLES
 *   • On-device only. Inference uses the local LlamaService. The profile never
 *     leaves the machine.
 *   • Invisible by default, inspectable on demand. The profile silently powers
 *     prompt enhancement; getProfile()/clearProfile() back a "what the app knows
 *     / clear it" surface so the user is never surprised (the anti-"Spotify
 *     Wrapped-creep" guarantee) and we stay on the right side of data-access law.
 *   • Encrypted at rest. The aggregated profile is a concentrated, high-value
 *     artifact that didn't exist before we built it, so it is the one thing most
 *     worth protecting. We use Electron safeStorage (OS keychain) when available.
 *   • Degrades gracefully. If the model isn't ready or there are no files, every
 *     function returns an empty/neutral result instead of throwing.
 *
 * Storage: userData/user_profile.enc  (or user_profile.json if encryption is
 * unavailable — a warning is logged so the gap is never silent).
 */

const fs = require('fs');
const path = require('path');

// ── Lazy electron access (so the module is unit-testable outside Electron) ─────

function getApp() {
  try { return require('electron').app; } catch { return null; }
}

function getSafeStorage() {
  try {
    const { safeStorage } = require('electron');
    if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
      return safeStorage;
    }
  } catch { /* not in electron / not available */ }
  return null;
}

function userDataDir() {
  const app = getApp();
  if (app) return app.getPath('userData');
  // Test/fallback location
  return process.env.USER_PROFILE_DIR || path.join(__dirname, '.userprofile_test');
}

const ENC_FILE = 'user_profile.enc';
const PLAIN_FILE = 'user_profile.json';

function encPath() { return path.join(userDataDir(), ENC_FILE); }
function plainPath() { return path.join(userDataDir(), PLAIN_FILE); }

// ── Schema ────────────────────────────────────────────────────────────────────

const PROFILE_VERSION = 1;

/** A neutral, empty profile. getProfileForPrompt() on this returns "". */
function emptyProfile() {
  return {
    version: PROFILE_VERSION,
    builtAt: 0,
    identity: { employer: null, role: null, industry: null },
    projects: [],     // [{ name, namespaceId? }]
    expertise: [],    // ["topic", ...]
    keyPeople: [],    // [{ name, relation }]
    writingStyle: { tone: null, formality: null, notes: null },
    signals: { fileCount: 0, namespaceCount: 0, source: 'none' },
  };
}

// ── Persistence (encrypted at rest when possible) ──────────────────────────────

function persist(profile) {
  const dir = userDataDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }

  const json = JSON.stringify(profile, null, 2);
  const ss = getSafeStorage();
  if (ss) {
    try {
      const buf = ss.encryptString(json);
      fs.writeFileSync(encPath(), buf);
      // Remove any stale plaintext copy from a previous run.
      try { if (fs.existsSync(plainPath())) fs.unlinkSync(plainPath()); } catch { /* ignore */ }
      return;
    } catch (e) {
      console.warn('[UserProfileService] Encryption failed, falling back to plaintext:', e?.message);
    }
  } else {
    console.warn('[UserProfileService] OS encryption unavailable — profile stored as plaintext. ' +
      'On a packaged build this should use safeStorage.');
  }
  fs.writeFileSync(plainPath(), json, 'utf-8');
}

function readRaw() {
  const ss = getSafeStorage();
  // Prefer encrypted file
  try {
    if (fs.existsSync(encPath()) && ss) {
      const buf = fs.readFileSync(encPath());
      return ss.decryptString(buf);
    }
  } catch (e) {
    console.warn('[UserProfileService] Could not decrypt profile:', e?.message);
  }
  // Fall back to plaintext
  try {
    if (fs.existsSync(plainPath())) return fs.readFileSync(plainPath(), 'utf-8');
  } catch { /* none */ }
  return null;
}

/** The stored profile, or an empty profile if none exists / it's unreadable. */
function getProfile() {
  const raw = readRaw();
  if (!raw) return emptyProfile();
  try {
    const parsed = JSON.parse(raw);
    return { ...emptyProfile(), ...parsed };
  } catch {
    return emptyProfile();
  }
}

/** True if there is no usable profile yet. */
function isEmpty(profile) {
  const p = profile || getProfile();
  return !p.builtAt ||
    (!p.identity.role && !p.identity.employer && p.projects.length === 0 &&
     p.expertise.length === 0 && p.keyPeople.length === 0 && !p.writingStyle.tone);
}

/** True if the profile is older than maxAgeMs (default 14 days). */
function isStale(maxAgeMs = 14 * 24 * 60 * 60 * 1000) {
  const p = getProfile();
  if (!p.builtAt) return true;
  return Date.now() - p.builtAt > maxAgeMs;
}

/** Wipe the profile entirely (both encrypted and plaintext copies). */
function clearProfile() {
  let removed = false;
  for (const p of [encPath(), plainPath()]) {
    try { if (fs.existsSync(p)) { fs.unlinkSync(p); removed = true; } } catch { /* ignore */ }
  }
  return removed;
}

/** Lightweight status for a transparency / settings surface. */
function getStatus() {
  const p = getProfile();
  return {
    built: !isEmpty(p),
    builtAt: p.builtAt || 0,
    stale: isStale(),
    encryptedAtRest: !!getSafeStorage(),
    counts: {
      projects: p.projects.length,
      expertise: p.expertise.length,
      keyPeople: p.keyPeople.length,
    },
    hasRole: !!p.identity.role,
    hasEmployer: !!p.identity.employer,
  };
}

// ── Prompt-ready context block ─────────────────────────────────────────────────

/**
 * getProfileForPrompt — a compact "About the user" block for the enhancer.
 *
 * This is intentionally person-level only (role, style, projects, expertise) —
 * facts about the user themselves, which are safe to carry across any namespace.
 * It deliberately does NOT dump company-confidential policy text; that stays
 * namespace-scoped in PolicyService so Company A's rules never leak into a
 * Company B prompt. Returns "" when there's nothing useful, so the enhancer can
 * skip the block cleanly.
 */
function getProfileForPrompt(opts = {}) {
  const p = getProfile();
  if (isEmpty(p)) return '';

  const lines = [];
  const id = p.identity || {};
  if (id.role && id.employer) {
    lines.push(`- Role: ${id.role} at ${id.employer.label || id.employer}`);
  } else if (id.role) {
    lines.push(`- Role: ${id.role}`);
  } else if (id.employer) {
    lines.push(`- Works at: ${id.employer.label || id.employer}`);
  }
  if (id.industry) lines.push(`- Industry: ${id.industry}`);

  if (p.projects.length > 0) {
    lines.push(`- Active projects: ${p.projects.map(pr => pr.name).filter(Boolean).slice(0, 5).join(', ')}`);
  }
  if (p.expertise.length > 0) {
    lines.push(`- Areas of expertise: ${p.expertise.slice(0, 8).join(', ')}`);
  }
  // Key people are the most sensitive field — include only if explicitly allowed.
  if (opts.includePeople && p.keyPeople.length > 0) {
    lines.push(`- Frequently works with: ${p.keyPeople.map(k => k.name).filter(Boolean).slice(0, 5).join(', ')}`);
  }
  const ws = p.writingStyle || {};
  if (ws.tone || ws.formality) {
    const bits = [ws.formality, ws.tone].filter(Boolean).join(', ');
    if (bits) lines.push(`- Preferred writing style: ${bits}`);
  }

  if (lines.length === 0) return '';
  return `About the user (use to tailor the rewrite; do not state these facts unless relevant):\n${lines.join('\n')}\n`;
}

// ── Inference ──────────────────────────────────────────────────────────────────

const MAX_FILES = 16;
const MAX_CHARS_PER_FILE = 1200;

function getLlama() {
  try {
    const L = require('./LlamaService');
    if (L && typeof L.isReady === 'function' && L.isReady()) return L;
  } catch { /* not available */ }
  return null;
}

function safeParseJSON(raw) {
  if (!raw) return null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function dedupeStrings(arr, limit) {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    const s = String(x || '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (limit && out.length >= limit) break;
  }
  return out;
}

/**
 * buildProfile — infer the user identity profile from local signals.
 *
 * inputs (all optional; pass what's available from index.js):
 *   entries     : indexed files [{ filename, folder, fullText?, snippet? }]
 *   kg          : knowledge graph { folders: { name: { terms[] } } }
 *   employer    : NamespaceService.getEmployerNamespace() result or null
 *   namespaces  : NamespaceService.listNamespaces() result or []
 *   llama       : (test injection) override the LlamaService module
 *
 * Returns the persisted profile. Falls back to a deterministic, model-free
 * profile (KG terms + namespaces) when the LLM is unavailable, so the feature
 * still produces useful context on day one.
 */
async function buildProfile(inputs = {}) {
  const entries = Array.isArray(inputs.entries) ? inputs.entries : [];
  const kg = inputs.kg || null;
  const employer = inputs.employer || null;
  const namespaces = Array.isArray(inputs.namespaces) ? inputs.namespaces : [];

  const profile = emptyProfile();
  profile.builtAt = Date.now();
  profile.signals = {
    fileCount: entries.length,
    namespaceCount: namespaces.length,
    source: 'deterministic',
  };

  // ── Deterministic layer (always runs, no model needed) ──────────────────────
  if (employer) {
    profile.identity.employer = { id: employer.id, label: employer.label || employer.id };
  }

  // Active projects = non-personal namespaces (companies/projects the user works in)
  profile.projects = dedupeStrings(
    namespaces.filter(n => n && n.id !== 'personal').map(n => n.label),
    6
  ).map(name => {
    const ns = namespaces.find(n => n.label === name);
    return { name, namespaceId: ns ? ns.id : null };
  });

  // Expertise = the highest-signal domain terms across the knowledge graph
  if (kg && kg.folders) {
    const termFreq = {};
    for (const g of Object.values(kg.folders)) {
      for (const t of (g.terms || [])) {
        const k = String(t).toLowerCase().trim();
        if (k.length < 4) continue;
        termFreq[k] = (termFreq[k] || 0) + 1;
      }
    }
    // Prefer multi-word, domain-specific terms; rank by frequency.
    profile.expertise = Object.entries(termFreq)
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t)
      .slice(0, 10);
  }

  // ── LLM layer (role, industry, key people, writing style) ───────────────────
  const llama = inputs.llama || getLlama();
  if (llama && entries.length > 0) {
    // Build a compact, source-labeled corpus. Prefer employer-namespace files
    // for role/industry, but include a spread so writing style is representative.
    const picked = entries.slice(0, MAX_FILES);
    const corpus = picked.map((e, i) => {
      const body = (e.fullText || e.snippet || '').replace(/\s+/g, ' ').slice(0, MAX_CHARS_PER_FILE);
      return `[FILE ${i + 1}: ${e.filename} | folder: ${e.folder}]\n${body}`;
    }).join('\n\n');

    const employerHint = employer ? `The user's employer is "${employer.label || employer.id}". ` : '';
    const prompt =
      `You are building a concise profile of the OWNER of these files — the person, not the companies they ` +
      `interact with. ${employerHint}From the documents below infer ONLY what is well-supported. Leave a field ` +
      `null if you are not confident. Do NOT invent facts.\n\n` +
      `Infer:\n` +
      `- role: the user's likely job title or role (e.g. "Marketing Manager", "Graduate Student", "Freelance Designer")\n` +
      `- industry: the industry/domain they operate in\n` +
      `- keyPeople: up to 5 people who recur as the user's colleagues/clients/collaborators, each { "name", "relation" }\n` +
      `- writingStyle: { "tone": e.g. "warm"|"neutral"|"direct", "formality": "formal"|"casual"|"semi-formal", "notes": one short phrase } based on how the user themselves writes\n\n` +
      `Documents:\n${corpus}\n\n` +
      `Reply with ONLY valid JSON, no markdown:\n` +
      `{"role":null,"industry":null,"keyPeople":[{"name":"","relation":""}],"writingStyle":{"tone":null,"formality":null,"notes":null}}`;

    try {
      const raw = await llama.generate(prompt, { maxTokens: 600, temperature: 0.1, timeoutMs: 35000 });
      const parsed = safeParseJSON(raw);
      if (parsed) {
        if (typeof parsed.role === 'string' && parsed.role.trim()) {
          profile.identity.role = parsed.role.trim();
        }
        if (typeof parsed.industry === 'string' && parsed.industry.trim()) {
          profile.identity.industry = parsed.industry.trim();
        }
        if (Array.isArray(parsed.keyPeople)) {
          const people = parsed.keyPeople
            .filter(k => k && typeof k.name === 'string' && k.name.trim())
            .map(k => ({ name: k.name.trim(), relation: String(k.relation || '').trim() || 'colleague' }));
          // dedupe by name
          const seen = new Set();
          profile.keyPeople = people.filter(p => {
            const key = p.name.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key); return true;
          }).slice(0, 5);
        }
        if (parsed.writingStyle && typeof parsed.writingStyle === 'object') {
          const w = parsed.writingStyle;
          profile.writingStyle = {
            tone: (typeof w.tone === 'string' && w.tone.trim()) ? w.tone.trim() : null,
            formality: (typeof w.formality === 'string' && w.formality.trim()) ? w.formality.trim() : null,
            notes: (typeof w.notes === 'string' && w.notes.trim()) ? w.notes.trim() : null,
          };
        }
        profile.signals.source = 'deterministic+llm';
      }
    } catch (e) {
      console.warn('[UserProfileService] LLM inference failed; keeping deterministic profile:', e?.message);
    }
  }

  persist(profile);
  const built = Object.keys(profile.identity).some(k => profile.identity[k]) ||
    profile.projects.length || profile.expertise.length || profile.keyPeople.length;
  console.log(`[UserProfileService] Built profile from ${entries.length} files ` +
    `(${profile.signals.source}) — role: ${profile.identity.role || 'unknown'}, ` +
    `projects: ${profile.projects.length}, expertise: ${profile.expertise.length}, people: ${profile.keyPeople.length}`);
  return profile;
}

module.exports = {
  PROFILE_VERSION,
  emptyProfile,
  getProfile,
  getProfileForPrompt,
  getStatus,
  isEmpty,
  isStale,
  clearProfile,
  buildProfile,
};
