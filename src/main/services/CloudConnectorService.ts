/**
 * CloudConnectorService.ts — Cloud Storage Connector Management.
 *
 * Detects, configures, and manages Google Drive and iCloud connectors.
 * Uses LOCAL filesystem paths (sync folders) — no OAuth or API keys needed.
 *
 * Supported providers:
 *   - iCloud Drive (macOS): ~/Library/Mobile Documents/com~apple~CloudDocs/
 *   - Google Drive (macOS): ~/Library/CloudStorage/GoogleDrive-[account]/My Drive/
 *   - Google Drive (legacy): ~/Google Drive/
 *   - Google Drive (Windows): G:\My Drive\ or user-configured
 *
 * Config persisted to: userData/cloud_connectors.json
 *
 * PRIVACY: All operations are local filesystem only — no cloud APIs called.
 * SAFETY:  Files are COPIED to cloud (never moved). Local org is untouched.
 */

import fs   from "fs";
import path from "path";
import os   from "os";

// ── Types ─────────────────────────────────────────────────────────

export type CloudProviderID = "icloud" | "googledrive";

export interface CloudConnector {
  id: CloudProviderID;
  label: string;
  /** Detected or user-set root path for this cloud provider */
  basePath: string;
  /** Subfolder within the cloud root where organized files go */
  subfolder: string;
  /** Whether this connector is actively syncing organized files */
  enabled: boolean;
  /** Whether the basePath is currently accessible on disk */
  accessible: boolean;
  /** Whether the path was auto-detected or manually set */
  autoDetected: boolean;
}

export interface CloudConnectorConfig {
  connectors: CloudConnector[];
  /** ISO timestamp of last config save */
  updatedAt: string;
}

// ── Internal state ────────────────────────────────────────────────

let _configPath = "";
let _config: CloudConnectorConfig = { connectors: [], updatedAt: "" };

// ── Initialization ────────────────────────────────────────────────

/**
 * Initialize the cloud connector service.
 * Call once from index.js on app.whenReady().
 *
 * @param userDataDir — app.getPath("userData")
 */
export function initCloudConnectors(userDataDir: string): void {
  _configPath = path.join(userDataDir, "cloud_connectors.json");
  _config = loadConfig();

  // If no connectors configured yet, run initial detection
  if (_config.connectors.length === 0) {
    const detected = detectCloudStoragePaths();
    _config.connectors = detected;
    saveConfig();
    console.log(
      `[CloudConnector] Initial detection: ${detected.length} provider(s) found — ` +
      detected.map((c) => `${c.label} (${c.basePath})`).join(", ")
    );
  } else {
    // Refresh accessibility status on each startup
    refreshAccessibility();
    console.log(
      `[CloudConnector] Loaded ${_config.connectors.length} connector(s) from config`
    );
  }
}

// ── Detection ─────────────────────────────────────────────────────

/**
 * Auto-detect cloud storage sync folders on the local filesystem.
 * Returns connectors with enabled=false (opt-in by user).
 */
export function detectCloudStoragePaths(): CloudConnector[] {
  const connectors: CloudConnector[] = [];
  const home = os.homedir();

  // ── iCloud Drive ────────────────────────────────────────────
  if (process.platform === "darwin") {
    const icloudPath = path.join(
      home, "Library", "Mobile Documents", "com~apple~CloudDocs"
    );
    if (dirExists(icloudPath)) {
      connectors.push({
        id: "icloud",
        label: "iCloud Drive",
        basePath: icloudPath,
        subfolder: "AI_Organizer",
        enabled: false,
        accessible: true,
        autoDetected: true,
      });
    }
  }

  // ── Google Drive ────────────────────────────────────────────
  const gdriveCandidate = findGoogleDrivePath(home);
  if (gdriveCandidate) {
    connectors.push({
      id: "googledrive",
      label: "Google Drive",
      basePath: gdriveCandidate,
      subfolder: "AI_Organizer",
      enabled: false,
      accessible: true,
      autoDetected: true,
    });
  }

  return connectors;
}

/**
 * Find the Google Drive sync folder path.
 * Checks multiple known locations across platforms.
 */
function findGoogleDrivePath(home: string): string | null {
  if (process.platform === "darwin") {
    // Modern Google Drive for Desktop (macOS)
    const cloudStorageDir = path.join(home, "Library", "CloudStorage");
    if (dirExists(cloudStorageDir)) {
      try {
        const entries = fs.readdirSync(cloudStorageDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith("GoogleDrive-")) {
            const myDrive = path.join(cloudStorageDir, entry.name, "My Drive");
            if (dirExists(myDrive)) return myDrive;
            // Some setups don't have "My Drive" subfolder
            return path.join(cloudStorageDir, entry.name);
          }
        }
      } catch { /* ignore */ }
    }

    // Legacy Google Drive path (macOS)
    const legacyPath = path.join(home, "Google Drive");
    if (dirExists(legacyPath)) return legacyPath;

    // Another legacy variant
    const legacyMyDrive = path.join(home, "Google Drive", "My Drive");
    if (dirExists(legacyMyDrive)) return legacyMyDrive;
  }

  if (process.platform === "win32") {
    // Windows: Check common drive letters
    for (const letter of ["G", "H", "I"]) {
      const winPath = path.join(`${letter}:`, "My Drive");
      if (dirExists(winPath)) return winPath;
    }
    // User profile fallback
    const userGDrive = path.join(home, "Google Drive");
    if (dirExists(userGDrive)) return userGDrive;
  }

  if (process.platform === "linux") {
    // Linux: gnome-online-accounts or rclone mount points
    const linuxPath = path.join(home, "Google Drive");
    if (dirExists(linuxPath)) return linuxPath;
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * List all configured connectors with refreshed accessibility status.
 */
export function listConnectors(): CloudConnector[] {
  refreshAccessibility();
  return _config.connectors.map((c) => ({ ...c }));
}

/**
 * Enable a cloud connector by provider ID.
 * Creates the subfolder in the cloud location if it doesn't exist.
 */
export function enableConnector(id: CloudProviderID): CloudConnector | null {
  const connector = _config.connectors.find((c) => c.id === id);
  if (!connector) return null;

  // Verify path is accessible before enabling
  if (!dirExists(connector.basePath)) {
    connector.accessible = false;
    saveConfig();
    throw new Error(
      `Cannot enable ${connector.label}: path not accessible (${connector.basePath})`
    );
  }

  // Create the subfolder for organized files
  const destDir = path.join(connector.basePath, connector.subfolder);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
    console.log(`[CloudConnector] Created cloud subfolder: ${destDir}`);
  }

  connector.enabled = true;
  connector.accessible = true;
  saveConfig();

  console.log(`[CloudConnector] Enabled: ${connector.label} → ${destDir}`);
  return { ...connector };
}

/**
 * Disable a cloud connector.
 * Does NOT delete any files in cloud — just stops future syncing.
 */
export function disableConnector(id: CloudProviderID): CloudConnector | null {
  const connector = _config.connectors.find((c) => c.id === id);
  if (!connector) return null;

  connector.enabled = false;
  saveConfig();

  console.log(`[CloudConnector] Disabled: ${connector.label}`);
  return { ...connector };
}

/**
 * Set a custom base path for a connector (overrides auto-detection).
 */
export function setConnectorPath(id: CloudProviderID, newPath: string): CloudConnector | null {
  let connector = _config.connectors.find((c) => c.id === id);

  if (!connector) {
    // Create a new connector entry if the provider ID is valid
    const label = id === "icloud" ? "iCloud Drive" : id === "googledrive" ? "Google Drive" : id;
    connector = {
      id,
      label,
      basePath: newPath,
      subfolder: "AI_Organizer",
      enabled: false,
      accessible: dirExists(newPath),
      autoDetected: false,
    };
    _config.connectors.push(connector);
  } else {
    connector.basePath = newPath;
    connector.accessible = dirExists(newPath);
    connector.autoDetected = false;
  }

  saveConfig();
  console.log(`[CloudConnector] Path set: ${connector.label} → ${newPath} (accessible: ${connector.accessible})`);
  return { ...connector };
}

/**
 * Set the subfolder name within the cloud root where organized files go.
 */
export function setConnectorSubfolder(id: CloudProviderID, subfolder: string): CloudConnector | null {
  const connector = _config.connectors.find((c) => c.id === id);
  if (!connector) return null;

  // Sanitize subfolder name
  const safe = subfolder.replace(/[<>:"|?*\x00-\x1f]/g, "").trim();
  if (!safe) throw new Error("Invalid subfolder name");

  connector.subfolder = safe;
  saveConfig();

  console.log(`[CloudConnector] Subfolder set: ${connector.label} → ${safe}`);
  return { ...connector };
}

/**
 * Get the full destination path for a connector (basePath + subfolder).
 * Returns null if the connector doesn't exist or isn't accessible.
 */
export function getConnectorDestPath(id: CloudProviderID): string | null {
  const connector = _config.connectors.find((c) => c.id === id);
  if (!connector || !connector.accessible) return null;
  return path.join(connector.basePath, connector.subfolder);
}

/**
 * Get all enabled connectors with valid destination paths.
 * Used by CloudSyncService to know where to copy files.
 */
export function getEnabledConnectors(): Array<{ id: CloudProviderID; label: string; destPath: string }> {
  refreshAccessibility();
  return _config.connectors
    .filter((c) => c.enabled && c.accessible)
    .map((c) => ({
      id: c.id,
      label: c.label,
      destPath: path.join(c.basePath, c.subfolder),
    }));
}

/**
 * Get the status of a specific connector.
 */
export function getConnectorStatus(id: CloudProviderID): {
  exists: boolean;
  enabled: boolean;
  accessible: boolean;
  destPath: string | null;
  freeSpace: string;
} {
  const connector = _config.connectors.find((c) => c.id === id);
  if (!connector) {
    return { exists: false, enabled: false, accessible: false, destPath: null, freeSpace: "N/A" };
  }

  refreshSingleAccessibility(connector);

  return {
    exists: true,
    enabled: connector.enabled,
    accessible: connector.accessible,
    destPath: connector.accessible ? path.join(connector.basePath, connector.subfolder) : null,
    freeSpace: "N/A", // Could add disk space check later
  };
}

/**
 * Re-run auto-detection. Merges newly found providers with existing config.
 * Preserves user-customized paths and enabled state.
 */
export function redetect(): CloudConnector[] {
  const fresh = detectCloudStoragePaths();

  for (const detected of fresh) {
    const existing = _config.connectors.find((c) => c.id === detected.id);
    if (!existing) {
      // New provider found — add it (disabled by default)
      _config.connectors.push(detected);
      console.log(`[CloudConnector] New provider detected: ${detected.label}`);
    } else if (existing.autoDetected) {
      // Update auto-detected path if it changed (user-set paths are preserved)
      existing.basePath = detected.basePath;
      existing.accessible = detected.accessible;
    }
  }

  refreshAccessibility();
  saveConfig();
  return _config.connectors.map((c) => ({ ...c }));
}

// ── Config persistence ────────────────────────────────────────────

function loadConfig(): CloudConnectorConfig {
  try {
    if (fs.existsSync(_configPath)) {
      const raw = fs.readFileSync(_configPath, "utf-8");
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn(`[CloudConnector] Failed to load config: ${err}`);
  }
  return { connectors: [], updatedAt: "" };
}

function saveConfig(): void {
  _config.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(_configPath, JSON.stringify(_config, null, 2), "utf-8");
  } catch (err) {
    console.error(`[CloudConnector] Failed to save config: ${err}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function refreshAccessibility(): void {
  for (const c of _config.connectors) {
    refreshSingleAccessibility(c);
  }
}

function refreshSingleAccessibility(c: CloudConnector): void {
  c.accessible = dirExists(c.basePath);
}
