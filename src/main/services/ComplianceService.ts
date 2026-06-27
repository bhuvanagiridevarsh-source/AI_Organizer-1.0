/**
 * ComplianceService.ts — Enterprise compliance engine (Work Mode only).
 *
 * Provides:
 *   1. Structured audit log  — every file action logged as JSON with user,
 *      timestamp, AI confidence, source/dest. Replaces the plain-text audit_log.txt
 *      for Work Mode. Personal mode audit_log.txt is untouched.
 *
 *   2. PII incident log — separate ledger for sensitive-data detections with
 *      type of PII found, action taken, and resolution status.
 *
 *   3. Retention policy engine — admin defines rules (folder + max age in days).
 *      scanRetention() walks the work directory and returns files that violate rules.
 *
 *   4. PDF report generation — builds an HTML compliance report and returns it
 *      as a Buffer via Electron's webContents.printToPDF, saved via dialog.
 *
 * Nothing in this file touches personal mode data.
 */

import fs   from "fs";
import path from "path";
import os   from "os";

// ── Types ──────────────────────────────────────────────────────────────────

export type AuditAction =
  | "CLASSIFIED" | "MOVED" | "AUTO_ORGANIZED"
  | "PII_DETECTED" | "RENAMED" | "UNDONE"
  | "RETENTION_FLAGGED" | "RETENTION_RESOLVED";

export interface AuditEntry {
  id:           string;
  timestamp:    string;
  action:       AuditAction;
  filename:     string;
  from?:        string;
  to?:          string;
  folder?:      string;
  aiConfidence?: number;
  piiTypes?:    string[];
  user:         string;
}

export interface PIIIncident {
  id:           string;
  timestamp:    string;
  filename:     string;
  fullPath:     string;
  detectedTypes: string[];
  action:       "quarantined" | "flagged";
  resolved:     boolean;
  resolvedAt?:  string;
}

export interface RetentionRule {
  id:         string;
  folder:     string;   // Folder name inside work dir to watch
  maxAgeDays: number;
  label:      string;   // e.g. "Client Files — 7 year retention"
}

export interface RetentionFlag {
  filename:     string;
  fullPath:     string;
  folder:       string;
  lastModified: string;
  ageDays:      number;
  ruleLabel:    string;
}

export interface ComplianceStats {
  totalAuditEntries: number;
  totalMoves:        number;
  totalPIIIncidents: number;
  unresolvedPII:     number;
  retentionFlags:    number;
  complianceScore:   number;   // 0–100
  topFolders:        { folder: string; count: number }[];
  recentActivity:    AuditEntry[];
}

// ── File paths (set once by init) ──────────────────────────────────────────

let _workDir = "";

function auditPath()     { return path.join(_workDir, "compliance_audit.json"); }
function piiPath()       { return path.join(_workDir, "pii_incidents.json"); }
function retentionPath() { return path.join(_workDir, "retention_rules.json"); }
function auditArchiveDir() { return path.join(_workDir, "compliance_audit_archives"); }

// ── Audit log rotation policy ─────────────────────────────────────────────
// Compliance requires that NO entries are dropped.  When the live file passes
// MAX_ACTIVE_ENTRIES, we move the oldest entries to a dated JSONL archive in
// `compliance_audit_archives/`, keeping the live file fast to load and write
// while preserving every record for audits.
const MAX_ACTIVE_ENTRIES = 5000;
const KEEP_AFTER_ROTATE  = 4000;

// ── Helpers ────────────────────────────────────────────────────────────────

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function loadJSON<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    }
  } catch { /* corrupted — start fresh */ }
  return fallback;
}

function saveJSON(filePath: string, data: unknown): void {
  // Atomic write: tmp → rename.  Prevents partial-write corruption if the
  // process crashes mid-write (which would otherwise destroy the audit log).
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  } catch (err) { console.error("[Compliance] Save failed:", err); }
}

/**
 * Append a batch of entries to a dated JSONL archive file.  JSONL is
 * append-only — corruption affects at most one line, not the whole file.
 */
function archiveAuditEntries(entries: AuditEntry[]): void {
  if (entries.length === 0) return;
  try {
    const dir = auditArchiveDir();
    fs.mkdirSync(dir, { recursive: true });
    // One archive file per day so the audit trail is easy to navigate
    const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const archivePath = path.join(dir, `audit-${stamp}.jsonl`);
    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.appendFileSync(archivePath, lines, "utf-8");
  } catch (err) {
    console.error("[Compliance] Archive rotation failed:", err);
  }
}

/**
 * Read every entry from every archive file.  Used when a full historical
 * report is requested.  Bounded by archive directory size — for very large
 * histories the caller should paginate.
 */
function readAuditArchives(): AuditEntry[] {
  const dir = auditArchiveDir();
  if (!fs.existsSync(dir)) return [];
  const all: AuditEntry[] = [];
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
    for (const f of files) {
      try {
        const text = fs.readFileSync(path.join(dir, f), "utf-8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try { all.push(JSON.parse(line) as AuditEntry); }
          catch { /* skip corrupt line, JSONL design isolates damage */ }
        }
      } catch { /* skip unreadable archive */ }
    }
  } catch { /* dir read failed */ }
  return all;
}

// ── Init ───────────────────────────────────────────────────────────────────

export function initCompliance(workDir: string): void {
  _workDir = workDir;
}

// ── Audit Log ──────────────────────────────────────────────────────────────

export function writeAuditEntry(
  action: AuditAction,
  fields: Omit<AuditEntry, "id" | "timestamp" | "user">
): AuditEntry {
  const entry: AuditEntry = {
    id:        uid(),
    timestamp: new Date().toISOString(),
    user:      os.userInfo().username,
    action,
    ...fields,
  };
  const entries = loadJSON<AuditEntry[]>(auditPath(), []);
  entries.push(entry);
  // Rotate (don't truncate): when over MAX_ACTIVE_ENTRIES, move the oldest
  // overflow into a dated archive instead of dropping them.  This preserves
  // the full compliance trail forever — required for audits.
  if (entries.length > MAX_ACTIVE_ENTRIES) {
    const overflow = entries.length - KEEP_AFTER_ROTATE;
    const toArchive = entries.splice(0, overflow);
    archiveAuditEntries(toArchive);
  }
  saveJSON(auditPath(), entries);
  return entry;
}

/**
 * Read the live audit log.  By default returns only the active rolling
 * window (~last 4–5k entries).  Pass `{ includeArchives: true }` to merge
 * in every archived entry from `compliance_audit_archives/` for a full
 * historical view — used by the PDF report and audit-export flows.
 */
export function readAuditLog(opts: { includeArchives?: boolean } = {}): AuditEntry[] {
  const live = loadJSON<AuditEntry[]>(auditPath(), []);
  if (!opts.includeArchives) return live;
  const archived = readAuditArchives();
  // Archives are oldest-first by filename; live appends are also chronological
  return [...archived, ...live];
}

// ── PII Incidents ──────────────────────────────────────────────────────────

export function logPIIIncident(
  filename: string,
  fullPath: string,
  detectedTypes: string[],
  action: "quarantined" | "flagged"
): PIIIncident {
  const incident: PIIIncident = {
    id:            uid(),
    timestamp:     new Date().toISOString(),
    filename,
    fullPath,
    detectedTypes,
    action,
    resolved:      false,
  };
  const incidents = loadJSON<PIIIncident[]>(piiPath(), []);
  incidents.push(incident);
  saveJSON(piiPath(), incidents);
  return incident;
}

export function resolvePIIIncident(id: string): boolean {
  const incidents = loadJSON<PIIIncident[]>(piiPath(), []);
  const inc = incidents.find((i) => i.id === id);
  if (!inc) return false;
  inc.resolved   = true;
  inc.resolvedAt = new Date().toISOString();
  saveJSON(piiPath(), incidents);
  return true;
}

export function readPIIIncidents(): PIIIncident[] {
  return loadJSON<PIIIncident[]>(piiPath(), []);
}

// ── Retention Policies ─────────────────────────────────────────────────────

export function getRetentionRules(): RetentionRule[] {
  return loadJSON<RetentionRule[]>(retentionPath(), []);
}

export function saveRetentionRules(rules: RetentionRule[]): void {
  saveJSON(retentionPath(), rules);
}

export function addRetentionRule(
  folder: string, maxAgeDays: number, label: string
): RetentionRule {
  const rule: RetentionRule = { id: uid(), folder, maxAgeDays, label };
  const rules = getRetentionRules();
  rules.push(rule);
  saveRetentionRules(rules);
  return rule;
}

export function deleteRetentionRule(id: string): void {
  const rules = getRetentionRules().filter((r) => r.id !== id);
  saveRetentionRules(rules);
}

/**
 * Walk workDir and return files that violate any retention rule.
 * A file violates a rule if it lives in the matching folder and
 * its last-modified date exceeds the rule's maxAgeDays.
 */
export function scanRetention(): RetentionFlag[] {
  if (!_workDir || !fs.existsSync(_workDir)) return [];
  const rules   = getRetentionRules();
  if (!rules.length) return [];

  const flags: RetentionFlag[] = [];
  const now     = Date.now();
  const MS_DAY  = 86_400_000;

  for (const rule of rules) {
    const folderPath = path.join(_workDir, rule.folder);
    if (!fs.existsSync(folderPath)) continue;

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(folderPath, { withFileTypes: true }); }
    catch { continue; }

    for (const e of entries) {
      if (!e.isFile()) continue;
      const fullPath = path.join(folderPath, e.name);
      try {
        const stat    = fs.statSync(fullPath);
        const ageDays = Math.floor((now - stat.mtimeMs) / MS_DAY);
        if (ageDays >= rule.maxAgeDays) {
          flags.push({
            filename:     e.name,
            fullPath,
            folder:       rule.folder,
            lastModified: stat.mtime.toISOString(),
            ageDays,
            ruleLabel:    rule.label,
          });
        }
      } catch { /* skip */ }
    }
  }
  return flags;
}

// ── Compliance Stats ───────────────────────────────────────────────────────

export function getComplianceStats(): ComplianceStats {
  // Include archives so totalMoves/totalAuditEntries reflect the FULL
  // history, not just the rotating live window.  Compliance scoring would
  // otherwise look better than reality after a rotation.
  const entries   = readAuditLog({ includeArchives: true });
  const incidents = readPIIIncidents();
  const retention = scanRetention();

  const moves = entries.filter((e) => e.action === "MOVED" || e.action === "AUTO_ORGANIZED");
  const unresolvedPII = incidents.filter((i) => !i.resolved).length;

  // Folder breakdown
  const folderCounts: Record<string, number> = {};
  for (const e of moves) {
    const f = e.folder || e.to?.split("/").slice(-2, -1)[0] || "Unknown";
    folderCounts[f] = (folderCounts[f] ?? 0) + 1;
  }
  const topFolders = Object.entries(folderCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([folder, count]) => ({ folder, count }));

  // Compliance score: 100 minus deductions
  let score = 100;
  if (unresolvedPII > 0)           score -= Math.min(40, unresolvedPII * 10);
  if (retention.length > 0)        score -= Math.min(30, retention.length * 5);
  const reviewEntries = entries.filter((e) => e.action === "CLASSIFIED" && (e.aiConfidence ?? 100) < 70);
  if (reviewEntries.length > 0)    score -= Math.min(20, reviewEntries.length * 2);
  score = Math.max(0, score);

  return {
    totalAuditEntries: entries.length,
    totalMoves:        moves.length,
    totalPIIIncidents: incidents.length,
    unresolvedPII,
    retentionFlags:    retention.length,
    complianceScore:   score,
    topFolders,
    recentActivity:    entries.slice(-15).reverse(),
  };
}

// ── HTML Report Builder ────────────────────────────────────────────────────

export function buildComplianceReportHTML(): string {
  const stats     = getComplianceStats();
  const incidents = readPIIIncidents();
  const retention = scanRetention();
  // For the report, pull from full history (live + archives) so old activity
  // surfaces when an auditor requests a backdated review.
  const entries   = readAuditLog({ includeArchives: true }).slice(-100).reverse();
  const now       = new Date().toLocaleString();
  const user      = os.userInfo().username;

  const scoreColor = stats.complianceScore >= 80 ? "#34d399"
    : stats.complianceScore >= 50 ? "#fb923c" : "#f87171";

  const incidentRows = incidents.length === 0
    ? "<tr><td colspan='4' style='color:#aaa;text-align:center'>No incidents recorded</td></tr>"
    : incidents.slice(-50).reverse().map((i) => `
        <tr>
          <td>${new Date(i.timestamp).toLocaleDateString()}</td>
          <td>${i.filename}</td>
          <td>${i.detectedTypes.join(", ") || "PII"}</td>
          <td style="color:${i.resolved ? "#34d399" : "#f87171"}">${i.resolved ? "Resolved" : "Open"}</td>
        </tr>`).join("");

  const retentionRows = retention.length === 0
    ? "<tr><td colspan='4' style='color:#aaa;text-align:center'>No violations found</td></tr>"
    : retention.map((r) => `
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
      <td>${e.folder || (e.to ? e.to.split("/").pop() : "—")}</td>
    </tr>`).join("");

  return `<!DOCTYPE html><html>
<head>
  <meta charset="UTF-8">
  <title>Compliance Report — ${now}</title>
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
  <h1>📋 Compliance Audit Report</h1>
  <div class="meta">Generated: ${now} &nbsp;·&nbsp; User: ${user} &nbsp;·&nbsp; System Janitor Enterprise</div>

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
