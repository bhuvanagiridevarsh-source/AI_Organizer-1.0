'use strict';
/**
 * PromptWorkflowService — the end-to-end "context engine" pipeline.
 *
 * This stitches the previously-separate pieces into ONE coherent workflow:
 *
 *   files ──▶ [UserProfileService]  infer who the person is (role, projects, …)
 *               │
 *   prompt ─────┤
 *               ▼
 *        [NamespaceService]  which company/context is this prompt about?
 *               ▼
 *     ┌─ RAG AGENT ──────────────────────────────────────────────┐
 *     │  • PolicyService  → durable rules relevant to the prompt   │
 *     │  • hybrid search  → specific passages from the user's files│
 *     │  (both scoped to the detected namespace — no cross-leak)    │
 *     └────────────────────────────────────────────────────────────┘
 *               ▼
 *        assemble prompt = identity + retrieved specifics + rules
 *               ▼
 *        [LlamaService]  rewrite → enhanced, context-aware prompt
 *
 * Design notes:
 *   • All collaborators are injected (the `ctx` arg) so the whole pipeline is
 *     unit-testable with mocks and the IPC handler stays a thin wiring layer.
 *   • assembleEnhancementPrompt() is a pure function — easy to snapshot-test.
 *   • Namespace isolation is preserved: passages and policies are filtered to
 *     the detected namespace so Company A's data never enters a Company B prompt.
 *   • Everything degrades gracefully: missing profile, no files, model loading.
 */

const MAX_PASSAGES = 3;
const MAX_POLICIES = 5;
const PASSAGE_CHARS = 220;

// ── Pure: assemble the final enhancement prompt ────────────────────────────────

/**
 * @param {object} a
 * @param {string} a.userPrompt
 * @param {string} [a.profileBlock]   "About the user" block (person-level)
 * @param {string} [a.kgContextBlock] folder/topic context for the namespace
 * @param {Array}  [a.passages]       [{ filename, folder, snippet }]
 * @param {Array}  [a.policyCards]    [{ text }]
 * @param {string} [a.namespaceName]
 * @returns {string}
 */
function assembleEnhancementPrompt(a) {
  const userPrompt = String(a.userPrompt || '').trim();
  const parts = [];

  parts.push(
    `You are a personal prompt enhancer. Rewrite the user's prompt to be more specific, ` +
    `detailed, and context-aware using ONLY the context below. Do not invent facts. If a ` +
    `piece of context is irrelevant to the prompt, ignore it. If nothing is relevant, just ` +
    `make the prompt clearer.`
  );

  if (a.profileBlock && a.profileBlock.trim()) {
    parts.push('\n' + a.profileBlock.trim());
  }

  if (a.kgContextBlock && a.kgContextBlock.trim()) {
    const scope = a.namespaceName ? ` (scoped to "${a.namespaceName}" only)` : '';
    parts.push(`\nRelevant file context${scope}:\n${a.kgContextBlock.trim()}`);
  }

  const passages = Array.isArray(a.passages) ? a.passages.slice(0, MAX_PASSAGES) : [];
  if (passages.length > 0) {
    const lines = passages.map(p => {
      const src = p.filename ? ` [${p.filename}]` : '';
      const snip = String(p.snippet || '').replace(/\s+/g, ' ').slice(0, PASSAGE_CHARS).trim();
      return `- ${snip}${src}`;
    });
    parts.push(
      `\nSpecific details retrieved from the user's own files (weave in only what's relevant; ` +
      `do not fabricate beyond these):\n${lines.join('\n')}`
    );
  }

  const policies = Array.isArray(a.policyCards) ? a.policyCards.slice(0, MAX_POLICIES) : [];
  if (policies.length > 0) {
    const lines = policies
      .map(p => String(p && p.text ? p.text : '').trim())
      .filter(Boolean)
      .map(t => `- ${t}`);
    if (lines.length > 0) {
      parts.push(
        `\nMUST-FOLLOW constraints from the user's workplace (honor every one naturally in the ` +
        `rewrite; do not list them separately, do not drop any):\n${lines.join('\n')}`
      );
    }
  }

  parts.push(
    `\nUser's original prompt:\n${userPrompt}\n\n` +
    `Improved prompt (output ONLY the rewritten prompt — no explanation, no preamble, no quotes):`
  );

  return parts.join('\n');
}

// ── Pure: turn a KG + namespace into a compact context block ───────────────────

function buildKgContextBlock(ctx, namespaceId) {
  const { namespaceService, kg } = ctx;
  if (!kg || !kg.folders || Object.keys(kg.folders).length === 0) return '';
  if (namespaceId && namespaceService && namespaceService.getContextForNamespace) {
    try {
      const scoped = namespaceService.getContextForNamespace(namespaceId, kg);
      if (scoped) return scoped;
    } catch { /* fall through */ }
  }
  // No namespace → a thin, broad hint (folder names only)
  return `File categories: ${Object.keys(kg.folders).slice(0, 15).join(', ')}`;
}

// ── Orchestration ──────────────────────────────────────────────────────────────

/**
 * runEnhancement — the full workflow.
 *
 * @param {string} userPrompt
 * @param {object} opts            { preferredNamespaceId? }
 * @param {object} ctx            injected collaborators:
 *   - llama:            { isReady(), generate(prompt, opts) }
 *   - namespaceService: NamespaceService-like
 *   - policyService:    PolicyService-like (searchPolicies)
 *   - userProfileService: UserProfileService-like (getProfileForPrompt)
 *   - retrieve:         async (query, namespaceId) => passages[]   (already ns-scoped)
 *   - kg:               loaded knowledge graph or null
 * @returns {Promise<{enhanced, namespaceId, namespaceName, used}>}
 */
async function runEnhancement(userPrompt, opts = {}, ctx = {}) {
  const prompt = String(userPrompt || '').trim();
  if (!prompt) return { enhanced: null, error: 'Empty prompt.' };

  const { llama, namespaceService, policyService, userProfileService, retrieve } = ctx;
  if (!llama || !llama.isReady || !llama.isReady()) {
    return { enhanced: null, error: 'AI engine is still loading. Please wait a moment and try again.' };
  }

  // 1. Identity block (person-level; safe across namespaces)
  let profileBlock = '';
  try {
    if (userProfileService && userProfileService.getProfileForPrompt) {
      profileBlock = userProfileService.getProfileForPrompt() || '';
    }
  } catch { /* no profile */ }

  // 2. Which context is this prompt about?
  let namespaceId = opts.preferredNamespaceId || null;
  let namespaceName = null;
  if (!namespaceId && namespaceService) {
    try {
      namespaceId = namespaceService.detectPromptNamespace(prompt) || null;
      if (!namespaceId && namespaceService.getEmployerNamespace) {
        const emp = namespaceService.getEmployerNamespace();
        if (emp) namespaceId = emp.id;
      }
    } catch { /* ambiguous */ }
  }
  if (namespaceId && namespaceService && namespaceService.listNamespaces) {
    try {
      const ns = namespaceService.listNamespaces().find(n => n.id === namespaceId);
      namespaceName = ns ? ns.label : namespaceId;
    } catch { namespaceName = namespaceId; }
  }

  // 3. RAG agent: durable rules + specific passages, scoped to the namespace
  let policyCards = [];
  if (policyService && policyService.searchPolicies && namespaceId) {
    try { policyCards = policyService.searchPolicies(namespaceId, prompt, MAX_POLICIES) || []; }
    catch { policyCards = []; }
  }

  let passages = [];
  if (typeof retrieve === 'function') {
    try { passages = (await retrieve(prompt, namespaceId)) || []; }
    catch { passages = []; }
  }

  // 4. Assemble + 5. generate
  const kgContextBlock = buildKgContextBlock(ctx, namespaceId);
  const fullPrompt = assembleEnhancementPrompt({
    userPrompt: prompt, profileBlock, kgContextBlock, passages, policyCards, namespaceName,
  });

  let enhanced;
  try {
    const raw = await llama.generate(fullPrompt, { maxTokens: 512, temperature: 0.3, timeoutMs: 30000 });
    enhanced = (raw || '').trim();
  } catch (e) {
    return { enhanced: null, error: e?.message || 'Enhancement failed.' };
  }
  if (!enhanced) return { enhanced: null, error: 'AI returned an empty response. Please try again.' };

  return {
    enhanced,
    namespaceId,
    namespaceName,
    used: {
      profile: !!profileBlock,
      passages: passages.map(p => ({ filename: p.filename, folder: p.folder })),
      constraints: policyCards.map(p => p.text).filter(Boolean),
    },
  };
}

module.exports = {
  assembleEnhancementPrompt,
  buildKgContextBlock,
  runEnhancement,
  MAX_PASSAGES,
  MAX_POLICIES,
};
