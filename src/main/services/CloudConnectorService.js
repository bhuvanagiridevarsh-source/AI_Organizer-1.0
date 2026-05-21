var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var CloudConnectorService_exports = {};
__export(CloudConnectorService_exports, {
  detectCloudStoragePaths: () => detectCloudStoragePaths,
  disableConnector: () => disableConnector,
  enableConnector: () => enableConnector,
  getConnectorDestPath: () => getConnectorDestPath,
  getConnectorStatus: () => getConnectorStatus,
  getEnabledConnectors: () => getEnabledConnectors,
  initCloudConnectors: () => initCloudConnectors,
  listConnectors: () => listConnectors,
  redetect: () => redetect,
  setConnectorPath: () => setConnectorPath,
  setConnectorSubfolder: () => setConnectorSubfolder
});
module.exports = __toCommonJS(CloudConnectorService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_os = __toESM(require("os"));
let _configPath = "";
let _config = { connectors: [], updatedAt: "" };
function initCloudConnectors(userDataDir) {
  _configPath = import_path.default.join(userDataDir, "cloud_connectors.json");
  _config = loadConfig();
  if (_config.connectors.length === 0) {
    const detected = detectCloudStoragePaths();
    _config.connectors = detected;
    saveConfig();
    console.log(
      `[CloudConnector] Initial detection: ${detected.length} provider(s) found \u2014 ` + detected.map((c) => `${c.label} (${c.basePath})`).join(", ")
    );
  } else {
    refreshAccessibility();
    console.log(
      `[CloudConnector] Loaded ${_config.connectors.length} connector(s) from config`
    );
  }
}
function detectCloudStoragePaths() {
  const connectors = [];
  const home = import_os.default.homedir();
  if (process.platform === "darwin") {
    const icloudPath = import_path.default.join(
      home,
      "Library",
      "Mobile Documents",
      "com~apple~CloudDocs"
    );
    if (dirExists(icloudPath)) {
      connectors.push({
        id: "icloud",
        label: "iCloud Drive",
        basePath: icloudPath,
        subfolder: "AI_Organizer",
        enabled: false,
        accessible: true,
        autoDetected: true
      });
    }
  }
  const gdriveCandidate = findGoogleDrivePath(home);
  if (gdriveCandidate) {
    connectors.push({
      id: "googledrive",
      label: "Google Drive",
      basePath: gdriveCandidate,
      subfolder: "AI_Organizer",
      enabled: false,
      accessible: true,
      autoDetected: true
    });
  }
  return connectors;
}
function findGoogleDrivePath(home) {
  if (process.platform === "darwin") {
    const cloudStorageDir = import_path.default.join(home, "Library", "CloudStorage");
    if (dirExists(cloudStorageDir)) {
      try {
        const entries = import_fs.default.readdirSync(cloudStorageDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith("GoogleDrive-")) {
            const myDrive = import_path.default.join(cloudStorageDir, entry.name, "My Drive");
            if (dirExists(myDrive)) return myDrive;
            return import_path.default.join(cloudStorageDir, entry.name);
          }
        }
      } catch {
      }
    }
    const legacyPath = import_path.default.join(home, "Google Drive");
    if (dirExists(legacyPath)) return legacyPath;
    const legacyMyDrive = import_path.default.join(home, "Google Drive", "My Drive");
    if (dirExists(legacyMyDrive)) return legacyMyDrive;
  }
  if (process.platform === "win32") {
    for (const letter of ["G", "H", "I"]) {
      const winPath = import_path.default.join(`${letter}:`, "My Drive");
      if (dirExists(winPath)) return winPath;
    }
    const userGDrive = import_path.default.join(home, "Google Drive");
    if (dirExists(userGDrive)) return userGDrive;
  }
  if (process.platform === "linux") {
    const linuxPath = import_path.default.join(home, "Google Drive");
    if (dirExists(linuxPath)) return linuxPath;
  }
  return null;
}
function listConnectors() {
  refreshAccessibility();
  return _config.connectors.map((c) => ({ ...c }));
}
function enableConnector(id) {
  const connector = _config.connectors.find((c) => c.id === id);
  if (!connector) return null;
  if (!dirExists(connector.basePath)) {
    connector.accessible = false;
    saveConfig();
    throw new Error(
      `Cannot enable ${connector.label}: path not accessible (${connector.basePath})`
    );
  }
  const destDir = import_path.default.join(connector.basePath, connector.subfolder);
  if (!import_fs.default.existsSync(destDir)) {
    import_fs.default.mkdirSync(destDir, { recursive: true });
    console.log(`[CloudConnector] Created cloud subfolder: ${destDir}`);
  }
  connector.enabled = true;
  connector.accessible = true;
  saveConfig();
  console.log(`[CloudConnector] Enabled: ${connector.label} \u2192 ${destDir}`);
  return { ...connector };
}
function disableConnector(id) {
  const connector = _config.connectors.find((c) => c.id === id);
  if (!connector) return null;
  connector.enabled = false;
  saveConfig();
  console.log(`[CloudConnector] Disabled: ${connector.label}`);
  return { ...connector };
}
function setConnectorPath(id, newPath) {
  let connector = _config.connectors.find((c) => c.id === id);
  if (!connector) {
    const label = id === "icloud" ? "iCloud Drive" : id === "googledrive" ? "Google Drive" : id;
    connector = {
      id,
      label,
      basePath: newPath,
      subfolder: "AI_Organizer",
      enabled: false,
      accessible: dirExists(newPath),
      autoDetected: false
    };
    _config.connectors.push(connector);
  } else {
    connector.basePath = newPath;
    connector.accessible = dirExists(newPath);
    connector.autoDetected = false;
  }
  saveConfig();
  console.log(`[CloudConnector] Path set: ${connector.label} \u2192 ${newPath} (accessible: ${connector.accessible})`);
  return { ...connector };
}
function setConnectorSubfolder(id, subfolder) {
  const connector = _config.connectors.find((c) => c.id === id);
  if (!connector) return null;
  const safe = subfolder.replace(/[<>:"|?*\x00-\x1f]/g, "").trim();
  if (!safe) throw new Error("Invalid subfolder name");
  connector.subfolder = safe;
  saveConfig();
  console.log(`[CloudConnector] Subfolder set: ${connector.label} \u2192 ${safe}`);
  return { ...connector };
}
function getConnectorDestPath(id) {
  const connector = _config.connectors.find((c) => c.id === id);
  if (!connector || !connector.accessible) return null;
  return import_path.default.join(connector.basePath, connector.subfolder);
}
function getEnabledConnectors() {
  refreshAccessibility();
  return _config.connectors.filter((c) => c.enabled && c.accessible).map((c) => ({
    id: c.id,
    label: c.label,
    destPath: import_path.default.join(c.basePath, c.subfolder)
  }));
}
function getConnectorStatus(id) {
  const connector = _config.connectors.find((c) => c.id === id);
  if (!connector) {
    return { exists: false, enabled: false, accessible: false, destPath: null, freeSpace: "N/A" };
  }
  refreshSingleAccessibility(connector);
  return {
    exists: true,
    enabled: connector.enabled,
    accessible: connector.accessible,
    destPath: connector.accessible ? import_path.default.join(connector.basePath, connector.subfolder) : null,
    freeSpace: "N/A"
    // Could add disk space check later
  };
}
function redetect() {
  const fresh = detectCloudStoragePaths();
  for (const detected of fresh) {
    const existing = _config.connectors.find((c) => c.id === detected.id);
    if (!existing) {
      _config.connectors.push(detected);
      console.log(`[CloudConnector] New provider detected: ${detected.label}`);
    } else if (existing.autoDetected) {
      existing.basePath = detected.basePath;
      existing.accessible = detected.accessible;
    }
  }
  refreshAccessibility();
  saveConfig();
  return _config.connectors.map((c) => ({ ...c }));
}
function loadConfig() {
  try {
    if (import_fs.default.existsSync(_configPath)) {
      const raw = import_fs.default.readFileSync(_configPath, "utf-8");
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn(`[CloudConnector] Failed to load config: ${err}`);
  }
  return { connectors: [], updatedAt: "" };
}
function saveConfig() {
  _config.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  try {
    import_fs.default.writeFileSync(_configPath, JSON.stringify(_config, null, 2), "utf-8");
  } catch (err) {
    console.error(`[CloudConnector] Failed to save config: ${err}`);
  }
}
function dirExists(p) {
  try {
    return import_fs.default.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function refreshAccessibility() {
  for (const c of _config.connectors) {
    refreshSingleAccessibility(c);
  }
}
function refreshSingleAccessibility(c) {
  c.accessible = dirExists(c.basePath);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  detectCloudStoragePaths,
  disableConnector,
  enableConnector,
  getConnectorDestPath,
  getConnectorStatus,
  getEnabledConnectors,
  initCloudConnectors,
  listConnectors,
  redetect,
  setConnectorPath,
  setConnectorSubfolder
});
