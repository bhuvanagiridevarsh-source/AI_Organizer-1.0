/**
 * DatabaseService.js — SQLite persistence layer (with JSON fallback).
 *
 * Replaces the flat-JSON storage used by SearchIndex, audit logs, concept
 * pools, and knowledge graph.  At ~10,000 entries the JSON files become
 * hundreds of MB; every read parses the whole file, every write serializes
 * the whole file, and there's no concurrent-access safety.
 *
 * Design:
 *   • Single shared SQLite DB under app.getPath("userData")/system_janitor.db
 *   • Tables created on demand by callers (search_index, audit_log, etc.)
 *   • Graceful fallback: if `better-sqlite3` is NOT installed (native build
 *     not yet performed), every call returns null/[] and callers can use
 *     their pre-existing JSON paths.  This means the migration can ship
 *     incrementally without bricking the app on first install.
 *
 * To finish the migration:
 *   1. Add `"better-sqlite3": "^11.0.0"` to package.json dependencies
 *   2. The existing electron-rebuild postinstall hook will compile it
 *      for the bundled Electron ABI automatically.
 *   3. On first launch with the new build, callers that detect a legacy
 *      JSON file should migrate its contents into SQLite and rename the
 *      old file to `<name>.json.migrated`.
 */

const fs = require("fs");
const path = require("path");

let _db = null;
let _dbPath = null;
let _sqliteAvailable = null; // tri-state: null=unchecked, true/false

/**
 * Detect whether better-sqlite3 is loadable.  Lazy + cached so the
 * filesystem isn't probed on every API call.
 */
function isAvailable() {
  if (_sqliteAvailable !== null) return _sqliteAvailable;
  try {
    // eslint-disable-next-line global-require
    require.resolve("better-sqlite3");
    _sqliteAvailable = true;
  } catch {
    _sqliteAvailable = false;
    console.warn(
      "[DatabaseService] better-sqlite3 not installed — falling back to JSON storage. " +
      "Add it to package.json + npm install to enable SQLite-backed indexes."
    );
  }
  return _sqliteAvailable;
}

/**
 * Initialize the SQLite database under `dataDir` (typically app.getPath("userData")).
 * Idempotent — safe to call from multiple services on startup.
 * @returns {boolean} true if SQLite is active, false if running JSON fallback
 */
function init(dataDir) {
  if (!isAvailable()) return false;
  if (_db) return true;
  try {
    // eslint-disable-next-line global-require
    const Database = require("better-sqlite3");
    _dbPath = path.join(dataDir, "system_janitor.db");
    _db = new Database(_dbPath);
    // PRAGMA tuning: WAL gives concurrent reads while a write is in flight,
    // synchronous=NORMAL is the recommended ACID-preserving fast setting.
    _db.pragma("journal_mode = WAL");
    _db.pragma("synchronous = NORMAL");
    console.log(`[DatabaseService] SQLite opened at ${_dbPath}`);
    return true;
  } catch (err) {
    console.error(`[DatabaseService] Failed to open SQLite: ${err}`);
    _sqliteAvailable = false;
    return false;
  }
}

function getDb() {
  return _db;
}

/**
 * Run a one-time table creation if needed.  Tables track their own schema
 * via the standard SQLite metadata — no separate migration table needed
 * for the small set of tables we manage here.
 */
function ensureTable(ddl) {
  if (!_db) return;
  _db.exec(ddl);
}

/**
 * Migrate a legacy JSON file into the database by calling `importer`
 * once with the parsed contents, then renaming the JSON file to
 * `<original>.migrated` so subsequent boots skip the import.
 *
 * @param {string} jsonPath full path to the legacy JSON file
 * @param {(data: any) => void} importer  receives the parsed JSON object/array
 * @returns {boolean} true if a migration was performed
 */
function migrateLegacyJson(jsonPath, importer) {
  if (!_db) return false;
  try {
    if (!fs.existsSync(jsonPath)) return false;
    const raw = fs.readFileSync(jsonPath, "utf-8");
    const data = JSON.parse(raw);
    importer(data);
    fs.renameSync(jsonPath, `${jsonPath}.migrated`);
    console.log(`[DatabaseService] Migrated ${path.basename(jsonPath)} → SQLite`);
    return true;
  } catch (err) {
    console.error(`[DatabaseService] Migration of ${jsonPath} failed: ${err}`);
    return false;
  }
}

function close() {
  if (_db) {
    try { _db.close(); } catch {}
    _db = null;
  }
}

module.exports = {
  init,
  isAvailable,
  getDb,
  ensureTable,
  migrateLegacyJson,
  close,
};
