/**
 * PromptWorkflowService.test.js
 *
 * Covers:
 *   - assembleEnhancementPrompt (pure function): structure, truncation,
 *     namespace scoping, policy/passage cap.
 *   - runEnhancement (orchestrated): degrades gracefully when collaborators
 *     are missing, calls llama.generate with the assembled prompt, threads
 *     the detected namespace through.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assembleEnhancementPrompt,
  buildKgContextBlock,
  runEnhancement,
  MAX_PASSAGES,
  MAX_POLICIES,
} = require("../src/main/services/PromptWorkflowService");

// ── assembleEnhancementPrompt ──────────────────────────────────────────────

test("assembleEnhancementPrompt includes the user prompt verbatim", () => {
  const out = assembleEnhancementPrompt({ userPrompt: "summarize my Q3 report" });
  assert.ok(out.includes("summarize my Q3 report"));
  assert.ok(out.includes("Improved prompt"));
});

test("assembleEnhancementPrompt scopes the KG block to the namespace name", () => {
  const out = assembleEnhancementPrompt({
    userPrompt: "draft an email",
    kgContextBlock: "Folders: Finance, Legal",
    namespaceName: "Acme Co",
  });
  assert.ok(out.includes("scoped to \"Acme Co\" only"));
  assert.ok(out.includes("Folders: Finance, Legal"));
});

test("assembleEnhancementPrompt caps passages at MAX_PASSAGES", () => {
  const passages = Array.from({ length: MAX_PASSAGES + 5 }, (_, i) => ({
    filename: `f${i}.txt`, snippet: `snippet body ${i}`,
  }));
  const out = assembleEnhancementPrompt({ userPrompt: "x", passages });
  // First MAX_PASSAGES included, rest dropped
  for (let i = 0; i < MAX_PASSAGES; i++) assert.ok(out.includes(`f${i}.txt`));
  for (let i = MAX_PASSAGES; i < MAX_PASSAGES + 5; i++) {
    assert.ok(!out.includes(`f${i}.txt`), `dropped passage f${i}.txt should not appear`);
  }
});

test("assembleEnhancementPrompt drops empty policy texts but keeps non-empty ones", () => {
  const out = assembleEnhancementPrompt({
    userPrompt: "x",
    policyCards: [{ text: "" }, { text: "Never email customers after 9pm." }, { text: "  " }],
  });
  assert.ok(out.includes("Never email customers after 9pm."));
  assert.ok(out.includes("MUST-FOLLOW constraints"));
});

test("assembleEnhancementPrompt omits sections when their inputs are empty", () => {
  const out = assembleEnhancementPrompt({ userPrompt: "just this" });
  assert.ok(!out.includes("Relevant file context"));
  assert.ok(!out.includes("MUST-FOLLOW constraints"));
  assert.ok(!out.includes("Specific details retrieved"));
});

// ── buildKgContextBlock ────────────────────────────────────────────────────

test("buildKgContextBlock returns '' when the KG is empty", () => {
  assert.equal(buildKgContextBlock({ kg: null }), "");
  assert.equal(buildKgContextBlock({ kg: { folders: {} } }), "");
});

test("buildKgContextBlock falls back to broad folder list when namespace lookup throws", () => {
  const ctx = {
    kg: { folders: { Finance: {}, Legal: {}, HR: {} } },
    namespaceService: {
      getContextForNamespace: () => { throw new Error("boom"); },
    },
  };
  const out = buildKgContextBlock(ctx, "ns-1");
  assert.ok(out.includes("File categories"));
  assert.ok(out.includes("Finance"));
});

// ── runEnhancement ─────────────────────────────────────────────────────────

test("runEnhancement returns error when prompt is empty", async () => {
  const r = await runEnhancement("   ", {}, {});
  assert.equal(r.enhanced, null);
  assert.match(r.error, /Empty/);
});

test("runEnhancement returns error when llama isn't ready", async () => {
  const r = await runEnhancement("hello", {}, {
    llama: { isReady: () => false, generate: async () => "x" },
  });
  assert.equal(r.enhanced, null);
  assert.match(r.error, /still loading/i);
});

test("runEnhancement calls llama.generate with assembled prompt and returns the enhanced text", async () => {
  let receivedPrompt = "";
  const r = await runEnhancement("write a status update", {}, {
    llama: {
      isReady: () => true,
      generate: async (prompt) => { receivedPrompt = prompt; return "ENHANCED OUTPUT"; },
    },
  });
  assert.equal(r.enhanced, "ENHANCED OUTPUT");
  assert.ok(receivedPrompt.includes("write a status update"));
});

test("runEnhancement returns error when llama returns empty string", async () => {
  const r = await runEnhancement("x", {}, {
    llama: { isReady: () => true, generate: async () => "   " },
  });
  assert.equal(r.enhanced, null);
  assert.match(r.error, /empty/i);
});

test("runEnhancement threads detected namespace to retrieve()", async () => {
  let retrieveCalledWith = null;
  await runEnhancement("look at acme stuff", {}, {
    llama: { isReady: () => true, generate: async () => "ok" },
    namespaceService: {
      detectPromptNamespace: () => "ns-acme",
      listNamespaces: () => [{ id: "ns-acme", label: "Acme" }],
    },
    retrieve: async (q, nsId) => { retrieveCalledWith = { q, nsId }; return []; },
  });
  assert.deepEqual(retrieveCalledWith, { q: "look at acme stuff", nsId: "ns-acme" });
});

test("runEnhancement surfaces llama.generate errors instead of crashing", async () => {
  const r = await runEnhancement("x", {}, {
    llama: { isReady: () => true, generate: async () => { throw new Error("model crashed"); } },
  });
  assert.equal(r.enhanced, null);
  assert.match(r.error, /model crashed/);
});
