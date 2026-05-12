/**
 * ui-init.js — Rail proxy wiring, theme toggle, and UI-init helpers.
 *
 * Loaded as an external script (CSP-safe) so Electron's Content-Security-Policy
 * doesn't block it. All code runs inside DOMContentLoaded so renderer.js has
 * already set up its own event listeners before we wire the proxy layer.
 */

document.addEventListener('DOMContentLoaded', () => {

  // ── Theme toggle ──────────────────────────────────────
  const themeBtn = document.getElementById('themeToggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const isLight = document.documentElement.classList.toggle('light');
      document.documentElement.classList.toggle('dark', !isLight);
      themeBtn.textContent = isLight ? '☾' : '☀';
      themeBtn.title = isLight ? 'Switch to dark mode' : 'Switch to light mode';
    });
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

});
