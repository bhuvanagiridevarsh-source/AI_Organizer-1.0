'use strict';
/**
 * NamespaceService — isolates knowledge contexts so that Company A's data
 * never leaks into Company B's prompt context.
 *
 * The core idea: every folder that gets organized is tagged to a namespace
 * (a company, project, or "personal"). The prompt enhancer only loads context
 * from the namespace that matches the current prompt. Nothing crosses over.
 *
 * Namespaces are stored in userData/namespaces.json so they persist across sessions.
 * The KG (knowledge graph) is NOT duplicated — we just filter it at retrieval time
 * using the folder→namespace assignment map.
 */

const fs   = require('fs');
const path = require('path');
const { app } = require('electron');

// ── Storage ──────────────────────────────────────────────────────────────────

function manifestPath() {
  return path.join(app.getPath('userData'), 'namespaces.json');
}

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), 'utf-8'));
  } catch {
    return { namespaces: {}, folderAssignments: {} };
  }
}

function saveManifest(manifest) {
  fs.writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2), 'utf-8');
}

// ── Color palette for auto-assigned namespaces ────────────────────────────────

const PALETTE = [
  '#5B4FE8', '#0D9488', '#DC2626', '#D97706',
  '#2563EB', '#7C3AED', '#059669', '#DB2777',
];

function colorForId(id) {
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// ── Public API ────────────────────────────────────────────────────────────────

/** List all known namespaces as an array. */
function listNamespaces() {
  const manifest = loadManifest();
  return Object.values(manifest.namespaces);
}

/** Create or update a namespace manually. */
function upsertNamespace(id, label, color, entityNames = []) {
  const manifest = loadManifest();
  const existing = manifest.namespaces[id] || {};
  manifest.namespaces[id] = {
    ...existing,
    id,
    label,
    color: color || colorForId(id),
    entityNames: entityNames || [],
    updatedAt: new Date().toISOString(),
    createdAt: existing.createdAt || new Date().toISOString(),
  };
  saveManifest(manifest);
  return manifest.namespaces[id];
}

/** Assign a folder name to a namespace (case-insensitive). */
function assignFolderToNamespace(folderName, namespaceId) {
  const manifest = loadManifest();
  manifest.folderAssignments = manifest.folderAssignments || {};
  manifest.folderAssignments[folderName.toLowerCase()] = namespaceId;
  saveManifest(manifest);
}

/** Get which namespace a folder belongs to. */
function getNamespaceForFolder(folderName) {
  const manifest = loadManifest();
  return (manifest.folderAssignments || {})[folderName.toLowerCase()] || null;
}

/**
 * syncNamespacesFromKG — runs after file organization completes.
 * Looks at the knowledge graph folders, uses the local LLM to detect
 * which ones clearly belong to a specific entity (company/client/project),
 * and auto-creates namespaces + assigns folders.
 *
 * Folders that are already assigned are skipped.
 * Ambiguous folders stay unassigned until the user manually assigns them.
 */
async function syncNamespacesFromKG(kg) {
  if (!kg || !kg.folders) return { created: [], assigned: [] };

  const manifest = loadManifest();
  manifest.namespaces     = manifest.namespaces     || {};
  manifest.folderAssignments = manifest.folderAssignments || {};

  // Only process unassigned folders
  const unassigned = Object.keys(kg.folders).filter(
    f => !manifest.folderAssignments[f.toLowerCase()]
  );
  if (unassigned.length === 0) return { created: [], assigned: [] };

  // Build a compact summary for each unassigned folder
  const summaries = unassigned.slice(0, 25).map(f => {
    const terms = (kg.folders[f]?.terms || []).slice(0, 6).join(', ');
    return `"${f}": ${terms || '(no keywords yet)'}`;
  }).join('\n');

  let detections = [];

  try {
    const LlamaService = require('./LlamaService');
    if (LlamaService.isReady()) {
      const detectPrompt =
        `You are classifying file folders to determine if they belong to a specific external entity (company, client, or organization).\n\n` +
        `For each folder below, decide:\n` +
        `- If the folder name or keywords clearly indicate a specific company/client/org → provide that entity name\n` +
        `- If it is clearly personal (documents, downloads, photos, etc.) → type: "personal"\n` +
        `- If you are not sure → type: "unknown"\n\n` +
        `Folders:\n${summaries}\n\n` +
        `Reply ONLY with valid JSON, no markdown:\n` +
        `{"detections":[{"folder":"FolderName","entity":"EntityName or null","type":"company|project|personal|unknown"}]}`;

      const raw = await LlamaService.generate(detectPrompt, {
        maxTokens: 600,
        temperature: 0.1,
        timeoutMs: 25000,
      });

      const match = raw?.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        detections = parsed.detections || [];
      }
    }
  } catch (e) {
    console.warn('[NamespaceService] Entity detection LLM call failed:', e?.message);
    // Fall through — we'll just leave folders unassigned for now
  }

  const created  = [];
  const assigned = [];

  // Ensure personal namespace always exists
  if (!manifest.namespaces['personal']) {
    manifest.namespaces['personal'] = {
      id: 'personal', label: 'Personal',
      color: '#5B4FE8', entityNames: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  for (const det of detections) {
    if (!det.folder) continue;
    const folderKey = det.folder.toLowerCase();

    if (det.entity && (det.type === 'company' || det.type === 'project')) {
      // Create namespace for this entity if needed
      const nsId = slugify(det.entity);
      if (!manifest.namespaces[nsId]) {
        manifest.namespaces[nsId] = {
          id: nsId,
          label: det.entity,
          color: colorForId(nsId),
          entityNames: [det.entity],
          autoDetected: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        created.push(nsId);
      }
      manifest.folderAssignments[folderKey] = nsId;
      assigned.push({ folder: det.folder, namespace: nsId });

    } else if (det.type === 'personal') {
      manifest.folderAssignments[folderKey] = 'personal';
      assigned.push({ folder: det.folder, namespace: 'personal' });
    }
    // "unknown" → leave unassigned, user can assign manually later
  }

  saveManifest(manifest);
  return { created, assigned };
}

/**
 * getContextForNamespace — builds the context string the prompt enhancer
 * will inject. Only includes folders assigned to this namespace.
 */
function getContextForNamespace(namespaceId, kg) {
  if (!kg || !kg.folders) return '';

  const manifest = loadManifest();
  const assignments = manifest.folderAssignments || {};
  const ns = manifest.namespaces[namespaceId];

  // Folders that belong to this namespace
  const namespaceFolderKeys = Object.entries(assignments)
    .filter(([, nsId]) => nsId === namespaceId)
    .map(([f]) => f); // lowercase keys

  if (namespaceFolderKeys.length === 0) return '';

  const lines = [];
  if (ns) lines.push(`Context scope: ${ns.label} (isolated — no other context included)`);

  for (const [folder, data] of Object.entries(kg.folders)) {
    if (namespaceFolderKeys.includes(folder.toLowerCase())) {
      const terms = (data?.terms || []).slice(0, 8).join(', ');
      if (terms) lines.push(`  ${folder}: ${terms}`);
    }
  }

  return lines.join('\n');
}

/**
 * detectPromptNamespace — given a prompt string, figure out which namespace
 * it most likely belongs to. Returns the namespace ID or null if ambiguous.
 *
 * Strategy (in order):
 * 1. Keyword match on entity names stored in each namespace
 * 2. Keyword match on folder names assigned to each namespace
 * 3. If exactly one non-personal namespace exists + prompt has work keywords → use it
 * 4. Return null (ambiguous — caller should ask user or use all context)
 */
function detectPromptNamespace(prompt) {
  const manifest = loadManifest();
  const namespaces = manifest.namespaces || {};
  const assignments = manifest.folderAssignments || {};
  const pl = prompt.toLowerCase();

  // 1. Direct entity name match
  for (const [nsId, ns] of Object.entries(namespaces)) {
    if (nsId === 'personal') continue;
    for (const name of (ns.entityNames || [])) {
      if (pl.includes(name.toLowerCase())) return nsId;
    }
    if (pl.includes(ns.label.toLowerCase())) return nsId;
  }

  // 2. Folder name match
  for (const [folder, nsId] of Object.entries(assignments)) {
    if (nsId === 'personal') continue;
    if (pl.includes(folder)) return nsId;
  }

  // 3. Single work namespace + work-sounding prompt
  const workNs = Object.keys(namespaces).filter(id => id !== 'personal');
  if (workNs.length === 1) {
    const workWords = [
      'work', 'office', 'team', 'meeting', 'client', 'project',
      'company', 'business', 'colleague', 'boss', 'manager',
      'report', 'presentation', 'invoice', 'contract', 'budget',
    ];
    if (workWords.some(w => pl.includes(w))) return workNs[0];
  }

  // 4. Employer fallback for AMBIENT work/office prompts.
  // This is the key to the "cookies for the office" case: the prompt names no
  // company, but it's clearly about the workplace, so it resolves to the ONE
  // company the user works at — never a client's or competitor's files.
  const employerId = manifest.primaryEmployerId;
  if (employerId && namespaces[employerId]) {
    const ambientWork = [
      'office', 'work', 'team', 'colleague', 'coworker', 'co-worker', 'desk',
      'meeting', 'standup', 'stand-up', 'party', 'lunch', 'potluck', 'onboarding',
      'manager', 'boss', 'hr', 'company', 'workplace', 'staff', 'department',
      'all-hands', 'offsite', 'off-site', 'colleagues',
    ];
    if (ambientWork.some(w => pl.includes(w))) return employerId;
  }

  // 5. Personal keywords → personal namespace
  const personalWords = ['personal', 'home', 'family', 'hobby', 'my ', 'i '];
  if (personalWords.some(w => pl.includes(w)) && namespaces['personal']) {
    return 'personal';
  }

  return null;
}

/** Return all folder→namespace assignments (for display in UI). */
function getFolderAssignments() {
  return loadManifest().folderAssignments || {};
}

// ── Employer identity ─────────────────────────────────────────────────────────
// The "employer" is the ONE namespace that represents the company the user
// actually works at. It is what ambient work prompts ("cookies for the office")
// resolve to — as opposed to client/competitor files that also live in the
// library. This is the gate that decides which company's policies are allowed
// to influence a generic prompt.

const VALID_ROLES = new Set(['employer', 'client', 'reference', 'personal', 'unknown']);

// Keywords in a namespace's folder terms that signal it's an EMPLOYER
// (not a client or a reference dump) — HR/payroll/onboarding artifacts.
const EMPLOYER_SIGNAL_TERMS = [
  'handbook', 'payroll', 'payslip', 'paystub', 'onboarding', 'employee',
  'benefits', 'offer letter', 'w2', 'w-2', 'timesheet', 'pto', 'hr',
  'performance review', 'org chart', '401k', 'open enrollment', 'expense policy',
  'code of conduct', 'workplace', 'staff', 'team',
];

/** Set the role of a namespace (employer/client/reference/personal/unknown). */
function setNamespaceRole(namespaceId, role) {
  if (!VALID_ROLES.has(role)) return null;
  const manifest = loadManifest();
  const ns = manifest.namespaces[namespaceId];
  if (!ns) return null;
  ns.role = role;
  ns.updatedAt = new Date().toISOString();
  saveManifest(manifest);
  return ns;
}

/** Designate a namespace as THE employer. Demotes any previous employer to "client". */
function setEmployerNamespace(namespaceId) {
  const manifest = loadManifest();
  if (!manifest.namespaces[namespaceId]) return null;
  // Demote a previous employer so there is always exactly one.
  if (manifest.primaryEmployerId && manifest.namespaces[manifest.primaryEmployerId]
      && manifest.primaryEmployerId !== namespaceId) {
    manifest.namespaces[manifest.primaryEmployerId].role = 'client';
  }
  manifest.primaryEmployerId = namespaceId;
  manifest.namespaces[namespaceId].role = 'employer';
  manifest.namespaces[namespaceId].updatedAt = new Date().toISOString();
  saveManifest(manifest);
  return manifest.namespaces[namespaceId];
}

/** Get the confirmed employer namespace, or null if the user hasn't set one. */
function getEmployerNamespace() {
  const manifest = loadManifest();
  const id = manifest.primaryEmployerId;
  if (id && manifest.namespaces[id]) return manifest.namespaces[id];
  return null;
}

/**
 * detectEmployerCandidate — score every non-personal namespace on how likely it
 * is to be the user's employer, so the UI can pre-suggest one for confirmation.
 *
 * Signal = file volume (your employer usually dominates your work files) +
 * presence of HR/payroll/onboarding artifacts (only an employer has those).
 *
 * fileCountByNs: optional { [nsId]: number } of indexed files per namespace.
 * Returns { suggestedId, candidates: [{ id, label, color, role, fileCount, score, signals }] }.
 */
function detectEmployerCandidate(kg, fileCountByNs = {}) {
  const manifest = loadManifest();
  const namespaces = manifest.namespaces || {};
  const assignments = manifest.folderAssignments || {};

  // Map each namespace → its folder names
  const foldersByNs = {};
  for (const [folder, nsId] of Object.entries(assignments)) {
    (foldersByNs[nsId] = foldersByNs[nsId] || []).push(folder);
  }

  const candidates = [];
  for (const [nsId, ns] of Object.entries(namespaces)) {
    if (nsId === 'personal') continue;

    const folders = foldersByNs[nsId] || [];
    const fileCount = fileCountByNs[nsId] != null ? fileCountByNs[nsId] : folders.length;

    // Gather this namespace's terms from the KG to look for employer signals
    const signals = [];
    if (kg && kg.folders) {
      const terms = [];
      for (const f of folders) {
        const match = Object.keys(kg.folders).find(k => k.toLowerCase() === f.toLowerCase());
        if (match) terms.push(...((kg.folders[match]?.terms) || []));
      }
      const termBlob = terms.join(' ').toLowerCase() + ' ' + folders.join(' ').toLowerCase();
      for (const sig of EMPLOYER_SIGNAL_TERMS) {
        if (termBlob.includes(sig)) signals.push(sig);
      }
    }

    // Score: volume is the base, each HR-style signal is a strong multiplier.
    const score = fileCount + signals.length * 8 + (ns.role === 'employer' ? 100 : 0);
    candidates.push({
      id: nsId, label: ns.label, color: ns.color,
      role: ns.role || 'unknown', fileCount, score, signals,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const suggestedId = manifest.primaryEmployerId
    || (candidates[0] ? candidates[0].id : null);
  return { suggestedId, candidates };
}

module.exports = {
  listNamespaces,
  upsertNamespace,
  assignFolderToNamespace,
  getNamespaceForFolder,
  syncNamespacesFromKG,
  getContextForNamespace,
  detectPromptNamespace,
  getFolderAssignments,
  setNamespaceRole,
  setEmployerNamespace,
  getEmployerNamespace,
  detectEmployerCandidate,
};
