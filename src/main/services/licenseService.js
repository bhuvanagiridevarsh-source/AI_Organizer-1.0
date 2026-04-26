/**
 * licenseService.js — Local license gatekeeper backed by electron-store.
 *
 * Flow:
 *   1. User enters license key in your UI
 *   2. validateLicense(key) hits your Stripe backend to verify
 *   3. Result is cached locally (encrypted) for 24 hours
 *   4. canOrganizeFiles() checks the cache — no network needed
 *
 * Usage:
 *   const license = require("./services/licenseService");
 *   const valid = await license.validateLicense("sk_live_abc123");
 *   if (license.canOrganizeFiles()) { ... }
 */

const Store = require("electron-store");
const https = require("https");

// ── Configuration ──────────────────────────────────────────

const TESTING_MODE = true; // free access until license backend is deployed

// After deploying /backend to Vercel, paste your deployment URL here.
// If this is still a placeholder the app will degrade gracefully instead of crashing.
const LICENSE_API_URL = "TODO_YOUR_VERCEL_URL/api/license/validate";

// True when the URL has not been configured yet (prevents a crash on new URL())
const _API_URL_CONFIGURED = LICENSE_API_URL.startsWith("https://");

// Cache validity period (24 hours in milliseconds)
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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
    expiresAt: { type: "number", default: 0 }, // Unix ms when cache expires
    validatedAt: { type: "number", default: 0 },
  },
});

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
    const postData = JSON.stringify({ key: licenseKey });
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
    store.set("validatedAt", now);
    store.set("expiresAt", now + CACHE_TTL_MS);

    return {
      valid: !!response.valid,
      plan: response.plan || "",
    };
  } catch (err) {
    // Network error — if we have a previous valid cache, keep it alive
    // (don't lock users out because of a transient network issue)
    const cached = store.get("status");
    if (cached === "valid" && !_isCacheExpired()) {
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
 * Quick synchronous check: can the user organize files right now?
 * Returns false if no valid cached license or if the cache has expired.
 */
function canOrganizeFiles() {
  if (TESTING_MODE) return true;
  const status = store.get("status");
  if (status !== "valid") return false;
  if (_isCacheExpired()) return false;
  return true;
}

/**
 * Get the currently stored license info (for displaying in settings).
 */
function getLicenseInfo() {
  return {
    key: store.get("licenseKey") || "",
    status: store.get("status") || "unknown",
    plan: store.get("plan") || "",
    validatedAt: store.get("validatedAt") || 0,
    expiresAt: store.get("expiresAt") || 0,
    cached: !_isCacheExpired(),
  };
}

/**
 * Clear stored license (logout / deactivate).
 */
function clearLicense() {
  store.clear();
}

// ── Internals ──────────────────────────────────────────────

function _isCacheExpired() {
  const expiresAt = store.get("expiresAt") || 0;
  return Date.now() > expiresAt;
}

module.exports = {
  validateLicense,
  canOrganizeFiles,
  getLicenseInfo,
  clearLicense,
};
