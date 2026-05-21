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
var ComplianceService_exports = {};
__export(ComplianceService_exports, {
  addRetentionRule: () => addRetentionRule,
  buildComplianceReportHTML: () => buildComplianceReportHTML,
  deleteRetentionRule: () => deleteRetentionRule,
  getComplianceStats: () => getComplianceStats,
  getRetentionRules: () => getRetentionRules,
  initCompliance: () => initCompliance,
  logPIIIncident: () => logPIIIncident,
  readAuditLog: () => readAuditLog,
  readPIIIncidents: () => readPIIIncidents,
  resolvePIIIncident: () => resolvePIIIncident,
  saveRetentionRules: () => saveRetentionRules,
  scanRetention: () => scanRetention,
  writeAuditEntry: () => writeAuditEntry
});
module.exports = __toCommonJS(ComplianceService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_os = __toESM(require("os"));
let _workDir = "";
function auditPath() {
  return import_path.default.join(_workDir, "compliance_audit.json");
}
function piiPath() {
  return import_path.default.join(_workDir, "pii_incidents.json");
}
function retentionPath() {
  return import_path.default.join(_workDir, "retention_rules.json");
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function loadJSON(filePath, fallback) {
  try {
    if (import_fs.default.existsSync(filePath)) {
      return JSON.parse(import_fs.default.readFileSync(filePath, "utf-8"));
    }
  } catch {
  }
  return fallback;
}
function saveJSON(filePath, data) {
  try {
    import_fs.default.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("[Compliance] Save failed:", err);
  }
}
function initCompliance(workDir) {
  _workDir = workDir;
}
function writeAuditEntry(action, fields) {
  const entry = {
    id: uid(),
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    user: import_os.default.userInfo().username,
    action,
    ...fields
  };
  const entries = loadJSON(auditPath(), []);
  entries.push(entry);
  if (entries.length > 5e3) entries.splice(0, entries.length - 5e3);
  saveJSON(auditPath(), entries);
  return entry;
}
function readAuditLog() {
  return loadJSON(auditPath(), []);
}
function logPIIIncident(filename, fullPath, detectedTypes, action) {
  const incident = {
    id: uid(),
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    filename,
    fullPath,
    detectedTypes,
    action,
    resolved: false
  };
  const incidents = loadJSON(piiPath(), []);
  incidents.push(incident);
  saveJSON(piiPath(), incidents);
  return incident;
}
function resolvePIIIncident(id) {
  const incidents = loadJSON(piiPath(), []);
  const inc = incidents.find((i) => i.id === id);
  if (!inc) return false;
  inc.resolved = true;
  inc.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
  saveJSON(piiPath(), incidents);
  return true;
}
function readPIIIncidents() {
  return loadJSON(piiPath(), []);
}
function getRetentionRules() {
  return loadJSON(retentionPath(), []);
}
function saveRetentionRules(rules) {
  saveJSON(retentionPath(), rules);
}
function addRetentionRule(folder, maxAgeDays, label) {
  const rule = { id: uid(), folder, maxAgeDays, label };
  const rules = getRetentionRules();
  rules.push(rule);
  saveRetentionRules(rules);
  return rule;
}
function deleteRetentionRule(id) {
  const rules = getRetentionRules().filter((r) => r.id !== id);
  saveRetentionRules(rules);
}
function scanRetention() {
  if (!_workDir || !import_fs.default.existsSync(_workDir)) return [];
  const rules = getRetentionRules();
  if (!rules.length) return [];
  const flags = [];
  const now = Date.now();
  const MS_DAY = 864e5;
  for (const rule of rules) {
    const folderPath = import_path.default.join(_workDir, rule.folder);
    if (!import_fs.default.existsSync(folderPath)) continue;
    let entries;
    try {
      entries = import_fs.default.readdirSync(folderPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const fullPath = import_path.default.join(folderPath, e.name);
      try {
        const stat = import_fs.default.statSync(fullPath);
        const ageDays = Math.floor((now - stat.mtimeMs) / MS_DAY);
        if (ageDays >= rule.maxAgeDays) {
          flags.push({
            filename: e.name,
            fullPath,
            folder: rule.folder,
            lastModified: stat.mtime.toISOString(),
            ageDays,
            ruleLabel: rule.label
          });
        }
      } catch {
      }
    }
  }
  return flags;
}
function getComplianceStats() {
  const entries = readAuditLog();
  const incidents = readPIIIncidents();
  const retention = scanRetention();
  const moves = entries.filter((e) => e.action === "MOVED" || e.action === "AUTO_ORGANIZED");
  const unresolvedPII = incidents.filter((i) => !i.resolved).length;
  const folderCounts = {};
  for (const e of moves) {
    const f = e.folder || e.to?.split("/").slice(-2, -1)[0] || "Unknown";
    folderCounts[f] = (folderCounts[f] ?? 0) + 1;
  }
  const topFolders = Object.entries(folderCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([folder, count]) => ({ folder, count }));
  let score = 100;
  if (unresolvedPII > 0) score -= Math.min(40, unresolvedPII * 10);
  if (retention.length > 0) score -= Math.min(30, retention.length * 5);
  const reviewEntries = entries.filter((e) => e.action === "CLASSIFIED" && (e.aiConfidence ?? 100) < 70);
  if (reviewEntries.length > 0) score -= Math.min(20, reviewEntries.length * 2);
  score = Math.max(0, score);
  return {
    totalAuditEntries: entries.length,
    totalMoves: moves.length,
    totalPIIIncidents: incidents.length,
    unresolvedPII,
    retentionFlags: retention.length,
    complianceScore: score,
    topFolders,
    recentActivity: entries.slice(-15).reverse()
  };
}
function buildComplianceReportHTML() {
  const stats = getComplianceStats();
  const incidents = readPIIIncidents();
  const retention = scanRetention();
  const entries = readAuditLog().slice(-100).reverse();
  const now = (/* @__PURE__ */ new Date()).toLocaleString();
  const user = import_os.default.userInfo().username;
  const scoreColor = stats.complianceScore >= 80 ? "#34d399" : stats.complianceScore >= 50 ? "#fb923c" : "#f87171";
  const incidentRows = incidents.length === 0 ? "<tr><td colspan='4' style='color:#aaa;text-align:center'>No incidents recorded</td></tr>" : incidents.slice(-50).reverse().map((i) => `
        <tr>
          <td>${new Date(i.timestamp).toLocaleDateString()}</td>
          <td>${i.filename}</td>
          <td>${i.detectedTypes.join(", ") || "PII"}</td>
          <td style="color:${i.resolved ? "#34d399" : "#f87171"}">${i.resolved ? "Resolved" : "Open"}</td>
        </tr>`).join("");
  const retentionRows = retention.length === 0 ? "<tr><td colspan='4' style='color:#aaa;text-align:center'>No violations found</td></tr>" : retention.map((r) => `
        <tr>
          <td>${r.filename}</td>
          <td>${r.folder}</td>
          <td>${r.ageDays} days</td>
          <td>${r.ruleLabel}</td>
        </tr>`).join("");
  const auditRows = entries.slice(0, 50).map((e) => `
    <tr>
      <td>${new Date(e.timestamp).toLocaleString()}</td>
      <td>${e.user}</td>
      <td>${e.action}</td>
      <td>${e.filename}</td>
      <td>${e.folder || (e.to ? e.to.split("/").pop() : "\u2014")}</td>
    </tr>`).join("");
  return `<!DOCTYPE html><html>
<head>
  <meta charset="UTF-8">
  <title>Compliance Report \u2014 ${now}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #1a1a2e; margin: 40px; font-size: 13px; }
    h1 { font-size: 22px; color: #0f3460; border-bottom: 2px solid #0f3460; padding-bottom: 8px; }
    h2 { font-size: 15px; color: #0f3460; margin-top: 32px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    .meta { color: #666; font-size: 12px; margin-bottom: 24px; }
    .stats-grid { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
    .stat-box { border: 1px solid #ddd; border-radius: 8px; padding: 14px 20px; min-width: 140px; }
    .stat-label { font-size: 10px; text-transform: uppercase; color: #666; font-weight: bold; letter-spacing: 0.5px; }
    .stat-value { font-size: 28px; font-weight: bold; color: #0f3460; margin-top: 4px; }
    .score-value { color: ${scoreColor}; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 12px; }
    th { background: #f4f6fb; text-align: left; padding: 8px 10px; font-size: 10px; text-transform: uppercase; color: #666; }
    td { padding: 7px 10px; border-bottom: 1px solid #f0f0f0; }
    tr:last-child td { border-bottom: none; }
    .footer { margin-top: 40px; font-size: 11px; color: #aaa; border-top: 1px solid #eee; padding-top: 12px; }
  </style>
</head>
<body>
  <h1>\u{1F4CB} Compliance Audit Report</h1>
  <div class="meta">Generated: ${now} &nbsp;\xB7&nbsp; User: ${user} &nbsp;\xB7&nbsp; System Janitor Enterprise</div>

  <div class="stats-grid">
    <div class="stat-box">
      <div class="stat-label">Compliance Score</div>
      <div class="stat-value score-value">${stats.complianceScore}/100</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">Files Organized</div>
      <div class="stat-value">${stats.totalMoves}</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">PII Incidents</div>
      <div class="stat-value" style="color:${stats.unresolvedPII > 0 ? "#f87171" : "#34d399"}">${stats.totalPIIIncidents}</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">Unresolved PII</div>
      <div class="stat-value" style="color:${stats.unresolvedPII > 0 ? "#f87171" : "#34d399"}">${stats.unresolvedPII}</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">Retention Flags</div>
      <div class="stat-value" style="color:${stats.retentionFlags > 0 ? "#fb923c" : "#34d399"}">${stats.retentionFlags}</div>
    </div>
  </div>

  <h2>PII / Sensitive Data Incidents</h2>
  <table>
    <thead><tr><th>Date</th><th>File</th><th>Type Detected</th><th>Status</th></tr></thead>
    <tbody>${incidentRows}</tbody>
  </table>

  <h2>Retention Policy Violations</h2>
  <table>
    <thead><tr><th>File</th><th>Folder</th><th>Age</th><th>Rule</th></tr></thead>
    <tbody>${retentionRows}</tbody>
  </table>

  <h2>Audit Log (last 50 actions)</h2>
  <table>
    <thead><tr><th>Timestamp</th><th>User</th><th>Action</th><th>File</th><th>Destination</th></tr></thead>
    <tbody>${auditRows}</tbody>
  </table>

  <div class="footer">This report was generated automatically by System Janitor Enterprise. All data is stored locally and never transmitted externally.</div>
</body></html>`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  addRetentionRule,
  buildComplianceReportHTML,
  deleteRetentionRule,
  getComplianceStats,
  getRetentionRules,
  initCompliance,
  logPIIIncident,
  readAuditLog,
  readPIIIncidents,
  resolvePIIIncident,
  saveRetentionRules,
  scanRetention,
  writeAuditEntry
});
