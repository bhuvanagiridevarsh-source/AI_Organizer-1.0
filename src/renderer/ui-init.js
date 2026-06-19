/**
 * ui-init.js — Rail proxy wiring, theme toggle, and UI-init helpers.
 *
 * Loaded as an external script (CSP-safe) so Electron's Content-Security-Policy
 * doesn't block it. All code runs inside DOMContentLoaded so renderer.js has
 * already set up its own event listeners before we wire the proxy layer.
 */

document.addEventListener('DOMContentLoaded', () => {

  // ── Theme toggle — light is default, dark class flips it ─────────────
  const themeBtn = document.getElementById('themeToggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const isDark = document.documentElement.classList.toggle('dark');
      themeBtn.textContent = isDark ? '☀' : '☾';
      themeBtn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    });
    // Initial icon — light by default
    themeBtn.textContent = '☾';
    themeBtn.title = 'Switch to dark mode';
  }

  // ── Rail proxy buttons → trigger original hidden buttons ─────────────────
  // Each rail item with data-proxy="<id>" clicks the element with that id,
  // which renderer.js has already wired to its real handler.
  document.querySelectorAll('.rail-item[data-proxy]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rail-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = document.getElementById(btn.dataset.proxy);
      if (target) target.click();
    });
  });

  // ── Topbar Google Drive button → gdriveBtn ────────────────────────────────
  const gdriveTopBtn = document.getElementById('gdriveTopBtn');
  if (gdriveTopBtn) {
    gdriveTopBtn.addEventListener('click', () => {
      const target = document.getElementById('gdriveBtn');
      if (target) target.click();
    });
  }

  // ── Rail + ask-bar AI chat buttons → chatBtn ─────────────────────────────
  ['railChatBtn', 'askBarChatBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (id === 'railChatBtn') {
        document.querySelectorAll('.rail-item').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
      const chatBtn = document.getElementById('chatBtn');
      if (chatBtn) chatBtn.click();
    });
  });

  // ── Rail "organize all" button → organizeBtn ──────────────────────────────
  const railOrg = document.getElementById('rail-organize-btn');
  if (railOrg) {
    railOrg.addEventListener('click', () => {
      const org = document.getElementById('organizeBtn');
      if (org && !org.disabled) org.click();
    });
  }

  // ── Mirror statusDot class changes to the rail LED ────────────────────────
  const statusDotEl = document.getElementById('statusDot');
  const railLed     = document.getElementById('railStatusLed');
  if (statusDotEl && railLed) {
    const obs = new MutationObserver(() => {
      const cls = statusDotEl.className;
      railLed.className = 'sys-led ' +
        (cls.includes('ok') ? 'ready' : cls.includes('error') ? 'error' : 'active');
    });
    obs.observe(statusDotEl, { attributes: true, attributeFilter: ['class'] });
  }

  // ── ⌘K / Ctrl+K → open AI chat ───────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      const chatBtn = document.getElementById('chatBtn');
      if (chatBtn) chatBtn.click();
      else {
        const inp = document.getElementById('deepSearchInput');
        if (inp) inp.focus();
      }
    }
  });

  // ── Google Drive connection status card ───────────────────────────────────
  (function initGdriveStatCard() {
    const card = document.getElementById('gdriveStatCard');
    const dot  = document.getElementById('gdriveStatDot');
    const txt  = document.getElementById('gdriveStatText');
    if (!card || !dot || !txt) return;

    card.addEventListener('click', () => {
      const btn = document.getElementById('gdriveBtn');
      if (btn) btn.click();
    });

    async function checkStatus() {
      try {
        if (window.api && window.api.gdrive && window.api.gdrive.authStatus) {
          const s = await window.api.gdrive.authStatus();
          if (s && s.authenticated) {
            dot.style.background = '#4a7c52';
            dot.style.boxShadow  = '0 0 4px rgba(74,124,82,0.5)';
            txt.textContent      = s.email ? s.email.split('@')[0] : 'connected';
            txt.style.color      = 'var(--ink-2)';
          } else {
            dot.style.background = 'var(--ink-4)';
            dot.style.boxShadow  = 'none';
            txt.textContent      = 'not connected';
            txt.style.color      = 'var(--ink-4)';
          }
        }
      } catch { /* no-op */ }
    }
    checkStatus();
    setInterval(checkStatus, 30_000);
  })();

  // ── PDF Summary workflow toggle ───────────────────────────────────────────
  (function initPdfSummaryToggle() {
    const checkbox = document.getElementById('pdfSummaryToggle');
    const track    = document.getElementById('pdfSummaryTrack');
    const thumb    = document.getElementById('pdfSummaryThumb');
    if (!checkbox || !track || !thumb) return;

    function applyVisual(on) {
      track.style.background = on ? '#C94020' : '#333';
      thumb.style.transform  = on ? 'translateX(16px)' : 'translateX(0)';
    }

    async function fetchAndApply() {
      try {
        if (window.api && window.api.workflows) {
          const enabled = await window.api.workflows.getPdfSummaryEnabled();
          checkbox.checked = !!enabled;
          applyVisual(!!enabled);
        }
      } catch { /* no-op */ }
    }

    // Re-read whenever the Settings panel opens (its hidden class is removed)
    const overlay = document.getElementById('settingsOverlay');
    if (overlay) {
      new MutationObserver(() => {
        if (!overlay.classList.contains('hidden')) fetchAndApply();
      }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
    }

    checkbox.addEventListener('change', async () => {
      const on = checkbox.checked;
      applyVisual(on);
      try {
        if (window.api && window.api.workflows) {
          await window.api.workflows.setPdfSummaryEnabled(on);
        }
      } catch { /* no-op */ }
    });
  })();

  // ── Prompt Enhancer Panel ──────────────────────────────────────────────────
  (() => {
    const panel        = document.getElementById('pePanel');
    const closeBtn     = document.getElementById('peCloseBtn');
    const railBtn      = document.getElementById('railPromptEnhancerBtn');
    const input        = document.getElementById('peInput');
    const enhanceBtn   = document.getElementById('peEnhanceBtn');
    const spinner      = document.getElementById('peSpinner');
    const errorEl      = document.getElementById('peError');
    const resultBox    = document.getElementById('peResultBox');
    const resultText   = document.getElementById('peResultText');
    const copyBtn      = document.getElementById('peCopyBtn');
    const nsRow        = document.getElementById('peNamespaceRow');
    const nsPills      = document.getElementById('peNamespacePills');
    const nsUsedBadge  = document.getElementById('peNsUsedBadge');
    const nsUsedDot    = document.getElementById('peNsUsedDot');
    const nsUsedLabel  = document.getElementById('peNsUsedLabel');
    const startersBox  = document.getElementById('peStarters');
    const startersList = document.getElementById('peStartersList');
    // Employer identity
    const employerBox       = document.getElementById('peEmployer');
    const employerConfirmed = document.getElementById('peEmployerConfirmed');
    const employerSetup     = document.getElementById('peEmployerSetup');
    const employerName      = document.getElementById('peEmployerName');
    const employerChange    = document.getElementById('peEmployerChange');
    const employerPills     = document.getElementById('peEmployerPills');
    // RAG constraints + grounding
    const constraintsBox    = document.getElementById('peConstraints');
    const constraintsList   = document.getElementById('peConstraintsList');
    const constraintsTitle  = document.getElementById('peConstraintsTitle');
    const enhanceLabel      = document.getElementById('peEnhanceBtnLabel');
    const groundingBox      = document.getElementById('peGrounding');
    const groundingList     = document.getElementById('peGroundingList');
    const groundingNs       = document.getElementById('peGroundingNs');

    if (!panel || !railBtn) return;

    // RAG two-step state
    let constraintsStaged   = false;
    let stagedNamespace     = null;
    let stagedNamespaceName = null;
    let lastEmployerInfo    = null;

    // Track which namespace pill the user has pinned (null = auto-detect)
    let selectedNamespaceId = null;
    let loadedNamespaces    = [];

    // ── Namespace pills ──────────────────────────────────────────────────────

    async function loadNamespaces() {
      try {
        if (!window.api?.namespace) return;
        const namespaces = await window.api.namespace.list();
        loadedNamespaces = namespaces || [];
        renderNamespacePills();
      } catch { /* namespace API not yet available */ }
    }

    function renderNamespacePills() {
      if (!nsPills || !nsRow) return;
      nsPills.innerHTML = '';

      if (loadedNamespaces.length === 0) {
        nsRow.style.display = 'none';
        return;
      }

      nsRow.style.display = 'flex';

      // "Auto" pill — let system detect
      const autoPill = makePill('auto', 'Auto', '#888', selectedNamespaceId === null);
      autoPill.addEventListener('click', () => {
        selectedNamespaceId = null;
        updatePillActive();
      });
      nsPills.appendChild(autoPill);

      // One pill per namespace
      for (const ns of loadedNamespaces) {
        const pill = makePill(ns.id, ns.label, ns.color, selectedNamespaceId === ns.id);
        pill.addEventListener('click', () => {
          selectedNamespaceId = ns.id;
          updatePillActive();
        });
        nsPills.appendChild(pill);
      }
    }

    function makePill(id, label, color, isActive) {
      const pill = document.createElement('button');
      pill.className = 'pe-ns-pill' + (isActive ? ' active' : '');
      pill.dataset.nsId = id;
      pill.style.borderColor = color;
      if (isActive) pill.style.background = color;

      const dot = document.createElement('div');
      dot.className = 'pe-ns-dot';
      dot.style.background = color;

      const span = document.createElement('span');
      span.textContent = label;

      pill.appendChild(dot);
      pill.appendChild(span);
      return pill;
    }

    function updatePillActive() {
      if (!nsPills) return;
      nsPills.querySelectorAll('.pe-ns-pill').forEach(pill => {
        const isActive = pill.dataset.nsId === (selectedNamespaceId || 'auto');
        pill.classList.toggle('active', isActive);
        const ns = loadedNamespaces.find(n => n.id === pill.dataset.nsId);
        const color = ns?.color || '#888';
        pill.style.background = isActive ? color : 'rgba(91,79,232,0.06)';
      });
    }

    // ── Smart Starters — file-aware suggestion chips ─────────────────────────

    async function loadStarters() {
      if (!startersBox || !startersList) return;
      try {
        if (!window.api?.promptEnhancer?.suggestions) { startersBox.style.display = 'none'; return; }
        const res = await window.api.promptEnhancer.suggestions();
        renderStarters(res && res.suggestions ? res.suggestions : []);
      } catch {
        startersBox.style.display = 'none';
      }
    }

    function renderStarters(list) {
      if (!startersBox || !startersList) return;
      startersList.innerHTML = '';
      if (!list || list.length === 0) { startersBox.style.display = 'none'; return; }

      for (const item of list) {
        const text  = (item && item.text) || '';
        const scope = (item && item.scope) || '';
        if (!text) continue;

        const btn = document.createElement('button');
        btn.className = 'pe-starter';
        btn.type = 'button';

        const arrow = document.createElement('span');
        arrow.className = 'pe-starter-arrow';
        arrow.textContent = '↳';

        const body = document.createElement('span');
        const label = document.createElement('span');
        label.textContent = text;
        body.appendChild(label);

        if (scope && scope !== 'general') {
          const sc = document.createElement('span');
          sc.className = 'pe-starter-scope';
          sc.textContent = scope === 'cross-folder' ? 'across folders' : scope;
          body.appendChild(document.createElement('br'));
          body.appendChild(sc);
        }

        btn.appendChild(arrow);
        btn.appendChild(body);
        btn.addEventListener('click', () => {
          if (!input) return;
          input.value = text;
          input.focus();
          input.setSelectionRange(text.length, text.length);
        });

        startersList.appendChild(btn);
      }
      startersBox.style.display = 'flex';
    }

    // ── Employer identity ────────────────────────────────────────────────────

    async function loadEmployer() {
      if (!employerBox) return;
      try {
        if (!window.api?.namespace?.getEmployer) { employerBox.style.display = 'none'; return; }
        const info = await window.api.namespace.getEmployer();
        lastEmployerInfo = info;
        renderEmployer(info, false);
      } catch {
        employerBox.style.display = 'none';
      }
    }

    function renderEmployer(info, forceSetup) {
      if (!employerBox || !employerConfirmed || !employerSetup) return;
      if (!info || !Array.isArray(info.candidates) || info.candidates.length === 0) {
        employerBox.style.display = 'none';
        return;
      }
      employerBox.style.display = 'block';

      if (info.confirmed && info.employerId && !forceSetup) {
        const emp = info.candidates.find(c => c.id === info.employerId);
        if (employerName) employerName.textContent = emp ? emp.label : info.employerId;
        employerConfirmed.style.display = 'flex';
        employerSetup.style.display = 'none';
      } else {
        employerConfirmed.style.display = 'none';
        employerSetup.style.display = 'block';
        renderEmployerPills(info);
      }
    }

    function renderEmployerPills(info) {
      if (!employerPills) return;
      employerPills.innerHTML = '';
      for (const c of info.candidates) {
        const pill = document.createElement('button');
        pill.className = 'pe-emp-pill';
        pill.type = 'button';

        const label = document.createElement('span');
        label.textContent = c.label;
        pill.appendChild(label);

        if (typeof c.fileCount === 'number' && c.fileCount > 0) {
          const cnt = document.createElement('span');
          cnt.className = 'pe-emp-pill-count';
          cnt.textContent = c.fileCount + (c.fileCount === 1 ? ' file' : ' files');
          pill.appendChild(cnt);
        }
        if (c.id === info.suggestedId) {
          const badge = document.createElement('span');
          badge.className = 'pe-emp-pill-badge';
          badge.textContent = 'likely';
          pill.appendChild(badge);
        }

        pill.addEventListener('click', async () => {
          try { await window.api.namespace.setEmployer(c.id); } catch {}
          // Learn this employer's policies in the background (no-op if model busy)
          try { window.api.policy && window.api.policy.build(c.id); } catch {}
          await loadEmployer();
        });
        employerPills.appendChild(pill);
      }
    }

    if (employerChange) {
      employerChange.addEventListener('click', () => {
        if (lastEmployerInfo) renderEmployer(lastEmployerInfo, true);
      });
    }

    // ── RAG constraints (opt-in toggles) ─────────────────────────────────────

    function setEnhanceLabel(text) { if (enhanceLabel) enhanceLabel.textContent = text; }

    function hideConstraints() {
      if (constraintsBox) constraintsBox.style.display = 'none';
      if (constraintsList) constraintsList.innerHTML = '';
    }

    function resetStaging() {
      constraintsStaged = false;
      stagedNamespace = null;
      stagedNamespaceName = null;
      setEnhanceLabel('Enhance with my context');
      hideConstraints();
    }

    function renderConstraints(ctx) {
      if (!constraintsBox || !constraintsList) return;
      constraintsList.innerHTML = '';
      if (constraintsTitle) {
        const where = ctx.namespaceName ? `your ${ctx.namespaceName} files` : 'your files';
        constraintsTitle.textContent = `From ${where} — keep what applies`;
      }
      for (const c of ctx.constraints) {
        const row = document.createElement('div');
        row.className = 'pe-constraint on';
        row.dataset.text = c.text;

        const check = document.createElement('div');
        check.className = 'pe-constraint-check';
        check.textContent = '✓';

        const body = document.createElement('div');
        body.className = 'pe-constraint-body';
        const txt = document.createElement('div');
        txt.className = 'pe-constraint-text';
        txt.textContent = c.text;
        body.appendChild(txt);
        if (c.source) {
          const src = document.createElement('div');
          src.className = 'pe-constraint-src';
          src.textContent = '↳ ' + c.source;
          body.appendChild(src);
        }

        row.appendChild(check);
        row.appendChild(body);
        row.addEventListener('click', () => {
          const on = row.classList.toggle('on');
          row.classList.toggle('off', !on);
          check.textContent = on ? '✓' : '';
        });
        constraintsList.appendChild(row);
      }
      constraintsBox.style.display = 'flex';
    }

    function getKeptConstraints() {
      if (!constraintsList) return [];
      return Array.from(constraintsList.querySelectorAll('.pe-constraint.on'))
        .map(row => ({ text: row.dataset.text }))
        .filter(c => c.text);
    }

    function renderGrounding(nsName, kept) {
      if (!groundingBox || !groundingList) return;
      if (!kept || kept.length === 0) { groundingBox.style.display = 'none'; return; }
      if (groundingNs) groundingNs.textContent = nsName || 'workplace';
      groundingList.innerHTML = '';
      for (const k of kept) {
        const item = document.createElement('div');
        item.className = 'pe-grounding-item';
        const dot = document.createElement('span');
        dot.textContent = '•';
        const txt = document.createElement('span');
        txt.textContent = k.text;
        item.appendChild(dot);
        item.appendChild(txt);
        groundingList.appendChild(item);
      }
      groundingBox.style.display = 'flex';
    }

    // ── Panel open/close ─────────────────────────────────────────────────────

    function openPanel() {
      panel.classList.add('open');
      document.querySelectorAll('.rail-item').forEach(b => b.classList.remove('active'));
      railBtn.classList.add('active');
      const chatPanel = document.getElementById('chatPanel');
      if (chatPanel) chatPanel.classList.remove('open');
      // Refresh namespace list + file-aware starters + employer every time it opens
      loadNamespaces();
      loadStarters();
      loadEmployer();
      resetStaging();
    }

    function closePanel() {
      panel.classList.remove('open');
      railBtn.classList.remove('active');
    }

    railBtn.addEventListener('click', () => {
      panel.classList.contains('open') ? closePanel() : openPanel();
    });

    if (closeBtn) closeBtn.addEventListener('click', closePanel);

    // ── Enhance logic ────────────────────────────────────────────────────────

    function setLoading(loading, message) {
      enhanceBtn.disabled = loading;
      spinner.classList.toggle('visible', loading);
      if (message) {
        const span = spinner.querySelector('span');
        if (span) span.textContent = message;
      }
    }

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.classList.add('visible');
      resultBox.classList.remove('visible');
      if (nsUsedBadge) nsUsedBadge.classList.remove('visible');
    }

    function showResult(text, namespaceId, namespaceName) {
      errorEl.classList.remove('visible');
      resultText.textContent = text;
      resultBox.classList.add('visible');

      // Show which namespace was used
      if (nsUsedBadge && namespaceId && namespaceName) {
        const ns = loadedNamespaces.find(n => n.id === namespaceId);
        const color = ns?.color || '#0d9488';
        nsUsedDot.style.background = color;
        nsUsedLabel.textContent = `Used "${namespaceName}" context only`;
        nsUsedLabel.style.color = color;
        nsUsedBadge.classList.add('visible');
      } else if (nsUsedBadge) {
        nsUsedLabel.textContent = 'Used general context (no specific scope detected)';
        nsUsedLabel.style.color = '';
        nsUsedDot.style.background = '#888';
        nsUsedBadge.classList.add('visible');
      }
    }

    async function runEnhance() {
      const prompt = (input.value || '').trim();
      if (!prompt) { showError('Please type a prompt first.'); return; }

      // ── STEP 1: gather RAG constraints from the user's files (toggles first) ──
      if (!constraintsStaged) {
        errorEl.classList.remove('visible');
        resultBox.classList.remove('visible');
        if (groundingBox) groundingBox.style.display = 'none';
        if (nsUsedBadge) nsUsedBadge.classList.remove('visible');

        let ctx = null;
        if (window.api?.promptEnhancer?.ragContext) {
          setLoading(true, 'Checking your files for relevant context…');
          try { ctx = await window.api.promptEnhancer.ragContext(prompt); } catch { ctx = null; }
          setLoading(false);
        }

        if (ctx && Array.isArray(ctx.constraints) && ctx.constraints.length > 0) {
          stagedNamespace = ctx.namespaceId || null;
          stagedNamespaceName = ctx.namespaceName || null;
          renderConstraints(ctx);
          constraintsStaged = true;
          setEnhanceLabel('Rewrite with these →');
          return; // let the user review the toggles, then click again
        }

        // No constraints found → fall through to a direct rewrite
        stagedNamespace = ctx ? (ctx.namespaceId || null) : null;
        stagedNamespaceName = ctx ? (ctx.namespaceName || null) : null;
      }

      // ── STEP 2: rewrite, weaving in only the constraints the user kept ──
      const kept = getKeptConstraints();
      const ns = selectedNamespaceId || stagedNamespace || null;
      setLoading(true, 'Enhancing your prompt…');
      try {
        const res = await window.api.promptEnhancer.enhance(prompt, ns, kept.map(k => k.text));
        if (res.error) {
          showError(res.error);
        } else {
          showResult(res.enhanced, res.namespaceId, res.namespaceName);
          renderGrounding(stagedNamespaceName || res.namespaceName, kept);
        }
      } catch (err) {
        showError(err?.message || 'Something went wrong. Please try again.');
      } finally {
        setLoading(false);
        constraintsStaged = false;
        setEnhanceLabel('Enhance with my context');
        hideConstraints();
      }
    }

    if (enhanceBtn) {
      enhanceBtn.addEventListener('click', runEnhance);
    }

    // Editing the prompt invalidates any staged constraints from the old prompt
    if (input) {
      input.addEventListener('input', () => {
        if (constraintsStaged) resetStaging();
      });
    }

    // Ctrl+Enter / Cmd+Enter triggers enhance
    if (input) {
      input.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          enhanceBtn.click();
        }
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const text = resultText.textContent;
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
        }).catch(() => {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
        });
      });
    }
  })();

});
