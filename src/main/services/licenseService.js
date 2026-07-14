/**
 * licenseService.js — Local license gatekeeper backed by electron-store.
 *
 * Flow:
 *   1. User enters license key in your UI
 *   2. validateLicense(key) hits your Stripe backend to verify
 *      (sends a stable per-install device id so keys can't be shared infinitely)
 *   3. Result is cached locally (encrypted); re-checked every 24 h, but a paying
 *      customer stays unlocked for a 7-day OFFLINE GRACE window so a flaky
 *      connection never locks them out
 *   4. canOrganizeFiles() checks the cache — no network needed
 *
 * Free trial:
 *   Unlicensed users may organize up to TRIAL_FILE_LIMIT files (lifetime,
 *   per install). Every gated move consumes from the allowance via
 *   consumeTrialMoves(n). After that, getAccess() flips to "locked" and the
 *   UI shows the paywall. Undo/redo and PII secure-moves are NEVER gated.
 *
 * Usage:
 *   const license = require("./services/licenseService");
 *   const access = license.getAccess();   // { allowed, mode, movesLeft }
 *   if (license.canOrganizeFiles()) { ... }
 */

// electron-store: defensive load with a JSON-file fallback so a missing module
// can never crash the app at boot. See src/main/index.js for the matching shim.
let Store = null;
try {
  Store = require("electron-store");
} catch (err) {
  console.warn(`[licenseService] electron-store unavailable, using JSON fallback: ${err?.message}`);
  const _fs = require("fs");
  const _path = require("path");
  const { app } = require("electron");
  Store = class FallbackStore {
    constructor({ name = "config" } = {}) {
      const dir = app.getPath("userData");
      try { _fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
      this._file = _path.join(dir, `${name}.json`);
      try { this.store = JSON.parse(_fs.readFileSync(this._file, "utf-8")); }
      catch { this.store = {}; }
    }
    _flush() {
      try { _fs.writeFileSync(this._file, JSON.stringify(this.store, null, 2), "utf-8"); }
      catch (e) { console.warn(`[FallbackStore] write failed: ${e.message}`); }
    }
    get(key, def) {
      return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : def;
    }
    set(key, value) {
      if (typeof key === "object" && key !== null) Object.assign(this.store, key);
      else this.store[key] = value;
      this._flush();
    }
    has(key) { return Object.prototype.hasOwnProperty.call(this.store, key); }
    delete(key) { delete this.store[key]; this._flush(); }
    clear() { this.store = {}; this._flush(); }
    get path() { return this._file; }
  };
}
const https = require("https");

// ── Configuration ──────────────────────────────────────────

// ── LAUNCH CHECKLIST ─────────────────────────────────────────
// Step 1: Deploy /backend to Vercel (see DEPLOY.md)
// Step 2: Paste your Vercel URL on the line below
// Step 3: Flip TESTING_MODE to false  ← this is the "go live" switch
// ─────────────────────────────────────────────────────────────
const TESTING_MODE = true; // ← set false when ready to charge (after Stripe + Resend are wired up)

const LICENSE_API_URL = "https://backend-two-mu-53.vercel.app/api/license/validate";
const PORTAL_API_URL = "https://backend-two-mu-53.vercel.app/api/billing/portal";

// Your Stripe Payment Link (Stripe Dashboard → Payment Links → New, mode=subscription).
// Shown on the paywall's "Subscribe" button. Leave "" until created —
// the UI falls back to showing the support email instead of a dead button.
const CHECKOUT_URL = "https://buy.stripe.com/test_6oU4gBgDn1aG3ARfyhak000"; // TEST MODE link — swap for the live payment link once Stripe onboarding (business info + bank account) is approved

const _API_URL_CONFIGURED = LICENSE_API_URL.startsWith("https://");
const _PORTAL_URL_CONFIGURED = PORTAL_API_URL.startsWith("https://");

// Cache validity period (24 hours in milliseconds) — how often we *try* to revalidate
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Offline grace: a previously-validated license keeps working this long even if
// the license server is unreachable. Prevents locking out paying customers on
// planes, behind firewalls, or during a Vercel outage.
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// Free trial: lifetime file-move allowance per install before a license is required.
// ~2–3 typical Downloads-folder cleanups — enough to prove the product works.
const TRIAL_FILE_LIMIT = 300;

// API request timeout
const REQUEST_TIMEOUT_MS = 10000;

// ── Encrypted local store ──────────────────────────────────

const store = new Store({
  name: "license",
  encryptionKey: "sj-v1-local-gatekeeper", // obfuscation, not military-grade
  schema: {
    licenseKey: { type: "string", default: "" },
    status: { type: "string", enum: ["valid", "invalid", "unknown"], default: "unknown" },
    plan: { type: "string", default: "" },
    subscriptionStatus: { type: "string", default: "" },
    expiresAt: { type: "number", default: 0 }, // Unix ms when cache expires
    validatedAt: { type: "number", default: 0 },
    trialMovesUsed: { type: "number", default: 0 }, // lifetime trial consumption
    deviceId: { type: "string", default: "" },      // stable per-install id
  },
});

// ── Device identity ────────────────────────────────────────

/**
 * Stable, anonymous per-install device id. Generated once, persisted.
 * Sent with license validation so the backend can cap devices per key.
 * Contains no hardware serials or personal data.
 */
function getDeviceId() {
  let id = store.get("deviceId");
  if (!id) {
    const crypto = require("crypto");
    id = crypto.randomUUID();
    store.set("deviceId", id);
  }
  return id;
}

// ── Network validation ─────────────────────────────────────

/**
 * Hit your Stripe backend to validate a license key.
 * Your API should return JSON: { valid: bool, plan: string, error?: string }
 */
function _callBackend(licenseKey) {
  if (!_API_URL_CONFIGURED) {
    return Promise.reject(
      new Error("License server URL is not configured. Please set LICENSE_API_URL.")
    );
  }
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      key: licenseKey,
      device_id: getDeviceId(),
      app_version: (() => { try { return require("electron").app.getVersion(); } catch { return "unknown"; } })(),
    });
    const url = new URL(LICENSE_API_URL);

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            resolve(data);
          } catch {
            reject(new Error("Invalid JSON from license server"));
          }
        });
      }
    );

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("License server request timed out"));
    });

    req.write(postData);
    req.end();
  });
}

// ── Public API ─────────────────────────────────────────────

/**
 * Validate a license key against your backend.
 * Caches the result locally for 24 hours.
 *
 * @param {string} key — The license key entered by the user
 * @returns {Promise<{valid: boolean, plan: string, error?: string}>}
 */
async function validateLicense(key) {
  try {
    const response = await _callBackend(key);

    const now = Date.now();
    store.set("licenseKey", key);
    store.set("status", response.valid ? "valid" : "invalid");
    store.set("plan", response.plan || "");
    store.set("subscriptionStatus", response.subscription_status || "");
    store.set("validatedAt", now);
    store.set("expiresAt", now + CACHE_TTL_MS);

    // Human-readable reason for rejections (e.g. device limit reached)
    let error;
    if (!response.valid && response.reason === "device_limit") {
      error = "This key is already active on the maximum number of devices. Remove it from another device or contact support.";
    }

    return {
      valid: !!response.valid,
      plan: response.plan || "",
      ...(error ? { error } : {}),
    };
  } catch (err) {
    // Network error — if we have a previous valid cache inside the offline
    // grace window, keep it alive (don't lock users out for a transient issue)
    const cached = store.get("status");
    const validatedAt = store.get("validatedAt") || 0;
    if (cached === "valid" && Date.now() < validatedAt + OFFLINE_GRACE_MS) {
      return {
        valid: true,
        plan: store.get("plan"),
        error: `Offline — using cached license (${err.message})`,
      };
    }

    return {
      valid: false,
      plan: "",
      error: err.message,
    };
  }
}

/**
 * Full access picture — the single source of truth for gating.
 *
 * @returns {{allowed: boolean, mode: "testing"|"licensed"|"trial"|"locked",
 *            movesLeft: number, movesTotal: number}}
 *   mode "licensed": valid license within the 7-day offline grace window
 *   mode "trial":    no license, trial allowance remaining
 *   mode "locked":   trial exhausted and no valid license
 */
function getAccess() {
  const used = store.get("trialMovesUsed") || 0;
  const movesLeft = Math.max(0, TRIAL_FILE_LIMIT - used);

  if (TESTING_MODE) {
    return { allowed: true, mode: "testing", movesLeft: Infinity, movesTotal: Infinity };
  }

  // Licensed path: status must be valid AND last successful validation must be
  // within the offline grace window. (expiresAt only marks when we should
  // silently re-check — it does not lock the user out by itself.)
  const status = store.get("status");
  const validatedAt = store.get("validatedAt") || 0;
  if (status === "valid" && Date.now() < validatedAt + OFFLINE_GRACE_MS) {
    return { allowed: true, mode: "licensed", movesLeft: Infinity, movesTotal: Infinity };
  }

  // Trial path
  if (movesLeft > 0) {
    return { allowed: true, mode: "trial", movesLeft, movesTotal: TRIAL_FILE_LIMIT };
  }

  return { allowed: false, mode: "locked", movesLeft: 0, movesTotal: TRIAL_FILE_LIMIT };
}

/**
 * Quick synchronous check: can the user organize files right now?
 * (Back-compat wrapper around getAccess().)
 */
function canOrganizeFiles() {
  return getAccess().allowed;
}

/**
 * Consume n file-moves from the trial allowance. No-op for licensed users
 * and in TESTING_MODE. Call AFTER a gated move succeeds.
 * @param {number} n — number of files moved (default 1)
 */
function consumeTrialMoves(n = 1) {
  const access = getAccess();
  if (access.mode !== "trial") return;
  const used = (store.get("trialMovesUsed") || 0) + Math.max(0, Math.floor(n));
  store.set("trialMovesUsed", used);
}

/**
 * If a key is stored and the 24 h cache marker has lapsed, silently
 * revalidate against the backend. Never throws; never downgrades access on
 * pure network failure (the offline grace window handles that).
 * Call once on app start, after a short delay.
 */
async function revalidateCached() {
  if (TESTING_MODE) return;
  const key = store.get("licenseKey");
  if (!key || store.get("status") !== "valid" || !_isCacheExpired()) return;
  try {
    await validateLicense(key); // updates validatedAt/expiresAt on success
    console.log("[licenseService] Background revalidation complete");
  } catch (err) {
    console.warn(`[licenseService] Background revalidation failed: ${err?.message}`);
  }
}

/**
 * Get the currently stored license info (for displaying in settings).
 */
function getLicenseInfo() {
  const access = getAccess();
  return {
    key: store.get("licenseKey") || "",
    status: store.get("status") || "unknown",
    plan: store.get("plan") || "",
    subscriptionStatus: store.get("subscriptionStatus") || "",
    validatedAt: store.get("validatedAt") || 0,
    expiresAt: store.get("expiresAt") || 0,
    cached: !_isCacheExpired(),
    // Access summary for the UI (trial banner, paywall, settings row)
    mode: access.mode,
    trialMovesLeft: access.mode === "trial" ? access.movesLeft : 0,
    trialMovesTotal: TRIAL_FILE_LIMIT,
    testingMode: TESTING_MODE,
    buyUrl: CHECKOUT_URL,
  };
}

/**
 * Clear stored license (logout / deactivate).
 * Only removes license fields — the trial ledger and device id survive,
 * so deactivating a key can never refill a used-up trial.
 */
function clearLicense() {
  store.delete("licenseKey");
  store.delete("status");
  store.delete("plan");
  store.delete("subscriptionStatus");
  store.delete("validatedAt");
  store.delete("expiresAt");
}

/**
 * Create a Stripe Customer Portal session URL for the currently stored key.
 * Returns { url } on success or { error } on failure.
 */
async function getPortalUrl() {
  const key = store.get("licenseKey");
  if (!key) return { error: "No license key stored" };
  if (!_PORTAL_URL_CONFIGURED) return { error: "Portal URL not configured" };

  return new Promise((resolve) => {
    const postData = JSON.stringify({ key });
    const url = new URL(PORTAL_API_URL);

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ error: "Invalid response from portal server" });
          }
        });
      }
    );
    req.on("error", (err) => resolve({ error: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ error: "Request timed out" }); });
    req.write(postData);
    req.end();
  });
}

// ── Internals ──────────────────────────────────────────────

function _isCacheExpired() {
  const expiresAt = store.get("expiresAt") || 0;
  return Date.now() > expiresAt;
}

module.exports = {
  validateLicense,
  canOrganizeFiles,
  getAccess,
  consumeTrialMoves,
  revalidateCached,
  getLicenseInfo,
  getDeviceId,
  clearLicense,
  getPortalUrl,
};
