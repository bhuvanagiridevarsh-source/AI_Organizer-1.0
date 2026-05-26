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
    const panel      = document.getElementById('pePanel');
    const closeBtn   = document.getElementById('peCloseBtn');
    const railBtn    = document.getElementById('railPromptEnhancerBtn');
    const input      = document.getElementById('peInput');
    const enhanceBtn = document.getElementById('peEnhanceBtn');
    const spinner    = document.getElementById('peSpinner');
    const errorEl    = document.getElementById('peError');
    const resultBox  = document.getElementById('peResultBox');
    const resultText = document.getElementById('peResultText');
    const copyBtn    = document.getElementById('peCopyBtn');

    if (!panel || !railBtn) return;

    function openPanel() {
      panel.classList.add('open');
      document.querySelectorAll('.rail-item').forEach(b => b.classList.remove('active'));
      railBtn.classList.add('active');
      // Close chat panel if open
      const chatPanel = document.getElementById('chatPanel');
      if (chatPanel) chatPanel.classList.remove('open');
    }

    function closePanel() {
      panel.classList.remove('open');
      railBtn.classList.remove('active');
    }

    railBtn.addEventListener('click', () => {
      panel.classList.contains('open') ? closePanel() : openPanel();
    });

    if (closeBtn) closeBtn.addEventListener('click', closePanel);

    function setLoading(loading) {
      enhanceBtn.disabled = loading;
      spinner.classList.toggle('visible', loading);
    }

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.classList.add('visible');
      resultBox.classList.remove('visible');
    }

    function showResult(text) {
      errorEl.classList.remove('visible');
      resultText.textContent = text;
      resultBox.classList.add('visible');
    }

    if (enhanceBtn) {
      enhanceBtn.addEventListener('click', async () => {
        const prompt = (input.value || '').trim();
        if (!prompt) {
          showError('Please type a prompt first.');
          return;
        }
        setLoading(true);
        errorEl.classList.remove('visible');
        resultBox.classList.remove('visible');
        try {
          const res = await window.api.promptEnhancer.enhance(prompt);
          if (res.error) {
            showError(res.error);
          } else {
            showResult(res.enhanced);
          }
        } catch (err) {
          showError(err?.message || 'Something went wrong. Please try again.');
        } finally {
          setLoading(false);
        }
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
