/**
 * GoogleDriveService.ts — Full two-way Google Drive API integration.
 *
 * Uses Google Drive REST API v3 with OAuth2 for authentication.
 * No external dependencies — uses Node's built-in https/http modules.
 *
 * Features:
 *   - OAuth2 login flow (opens browser, captures callback)
 *   - Token storage + automatic refresh
 *   - List files & folders from Drive
 *   - Download files to local temp for AI classification
 *   - Upload organized files back to Drive
 *   - Create & manage folders in Drive
 *   - Move files between Drive folders
 *
 * PRIVACY: Only accesses files the user explicitly grants access to.
 *          Tokens are stored locally in userData directory.
 */

import fs   from "fs";
import path from "path";
import os   from "os";
import http from "http";
import https from "https";
import crypto from "crypto";
import { URL, URLSearchParams } from "url";

const fsp = fs.promises;

// ── Types ─────────────────────────────────────────────────────────

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
  webViewLink?: string;
  iconLink?: string;
  starred?: boolean;
}

export interface DriveFolder {
  id: string;
  name: string;
  parents?: string[];
}

export interface DriveTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number;
  scope: string;
}

// NOTE: No DriveAuthConfig interface needed — credentials are embedded below.

// ── Internal state ────────────────────────────────────────────────

let _tokens: DriveTokens | null = null;
let _configDir = "";
let _tokenPath = "";
let _isInitialized = false;
let _tempDir = "";
let _pkceVerifier = ""; // PKCE code_verifier for current auth flow
let _oauthServer: http.Server | null = null; // Track active OAuth callback server

// ── Embedded OAuth2 Credentials ──────────────────────────────────
// These are for a "Desktop app" OAuth client — the secret is public
// (Google considers it non-confidential for native/desktop apps).
// Replace these with your actual Google Cloud project credentials.
const GOOGLE_CLIENT_ID     = "278013680546-oeg3eaikuaoddr537pqnto15qfhtg5rl.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = "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";

const DEFAULT_REDIRECT_URI = "http://localhost:47832/oauth2callback";
const OAUTH_PORT = 47832;

// Google API endpoints
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

// Scopes for full Drive access
const SCOPES = [
  "https://www.googleapis.com/auth/drive",
].join(" ");

// ── Initialization ────────────────────────────────────────────────

/**
 * Initialize the Google Drive service.
 * @param userDataDir — app.getPath("userData")
 */
export function initGoogleDrive(userDataDir: string): void {
  _configDir = userDataDir;
  _tokenPath = path.join(userDataDir, "gdrive_tokens.json");
  _tempDir = path.join(os.tmpdir(), "ai_organizer_gdrive");

  // Ensure temp dir exists
  if (!fs.existsSync(_tempDir)) {
    fs.mkdirSync(_tempDir, { recursive: true });
  }

  // Load saved tokens (credentials are embedded — no loading needed)
  _tokens = loadTokens();
  _isInitialized = true;

  console.log(
    `[GoogleDrive] Initialized. Authenticated: ${_tokens !== null}.`
  );
}

// ── OAuth2 Flow ───────────────────────────────────────────────────

/**
 * Check if the user is currently authenticated (has valid tokens).
 */
export function isAuthenticated(): boolean {
  return _tokens !== null && !!_tokens.access_token;
}

/**
 * Get the current auth status.
 * Credentials are always available (embedded in app).
 */
export function getAuthStatus(): {
  isAuthenticated: boolean;
  needsRefresh: boolean;
} {
  return {
    isAuthenticated: isAuthenticated(),
    needsRefresh: _tokens !== null && Date.now() >= _tokens.expiry_date,
  };
}

/**
 * Start OAuth2 login flow.
 * Opens the consent page in the user's browser.
 * Returns a promise that resolves when the user completes auth.
 */
export function startAuthFlow(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    // Kill any leftover server from a previous attempt
    if (_oauthServer) {
      try { _oauthServer.close(); } catch {}
      _oauthServer = null;
    }

    // Generate PKCE code_verifier and code_challenge
    _pkceVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(_pkceVerifier);

    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: DEFAULT_REDIRECT_URI,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const authUrl = `${AUTH_URL}?${params.toString()}`;

    let resolved = false;
    const done = (result: { ok: boolean; error?: string }) => {
      if (resolved) return;
      resolved = true;
      if (_oauthServer) {
        try { _oauthServer.close(); } catch {}
        _oauthServer = null;
      }
      resolve(result);
    };

    // Start local HTTP server to capture the OAuth callback
    const server = http.createServer(async (req, res) => {
      if (!req.url || !req.url.startsWith("/oauth2callback")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const url = new URL(req.url, `http://localhost:${OAUTH_PORT}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Authorization Failed</h2><p>You can close this tab.</p></body></html>");
        done({ ok: false, error: `OAuth error: ${error}` });
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h2>No authorization code received</h2></body></html>");
        done({ ok: false, error: "No authorization code received" });
        return;
      }

      try {
        // Exchange code for tokens
        const tokens = await exchangeCodeForTokens(code);
        _tokens = tokens;
        saveTokens(tokens);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body style='font-family:system-ui;text-align:center;padding:60px;'>" +
          "<h2 style='color:#34d399;'>Connected to Google Drive!</h2>" +
          "<p>You can close this tab and return to AI Organizer.</p></body></html>"
        );
        done({ ok: true });
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>Token exchange failed</h2><p>${err.message}</p></body></html>`);
        done({ ok: false, error: err.message });
      }
    });

    _oauthServer = server;

    // Handle port-in-use: close the zombie and retry once
    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        console.log(`[GoogleDrive] Port ${OAUTH_PORT} in use — forcing release and retrying...`);
        // Create a temporary connection to force the old server to close
        const cleanup = http.createServer();
        cleanup.once("error", () => {
          // Still can't bind — give up
          done({ ok: false, error: `Port ${OAUTH_PORT} is in use. Please close any lingering browser tabs from a previous sign-in attempt and try again.` });
        });
        cleanup.listen(OAUTH_PORT, "127.0.0.1", () => {
          cleanup.close(() => {
            // Port freed — retry
            server.listen(OAUTH_PORT, "127.0.0.1", () => {
              console.log(`[GoogleDrive] OAuth callback server listening on port ${OAUTH_PORT} (retry)`);
              const { shell } = require("electron");
              shell.openExternal(authUrl);
            });
          });
        });
      } else {
        done({ ok: false, error: `OAuth server error: ${err.message}` });
      }
    });

    server.listen(OAUTH_PORT, "127.0.0.1", () => {
      console.log(`[GoogleDrive] OAuth callback server listening on port ${OAUTH_PORT}`);
      // Open the auth URL in the user's default browser
      const { shell } = require("electron");
      shell.openExternal(authUrl);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      done({ ok: false, error: "OAuth flow timed out (5 minutes)" });
    }, 5 * 60 * 1000);
  });
}

/**
 * Sign out — remove stored tokens.
 */
export function signOut(): void {
  _tokens = null;
  try { fs.unlinkSync(_tokenPath); } catch {}
  console.log("[GoogleDrive] Signed out.");
}

// ── Drive API — File Operations ───────────────────────────────────

/**
 * List files in a Drive folder.
 * @param folderId — The Drive folder ID (use "root" for top-level)
 * @param pageSize — Max files to return (default 100)
 */
export async function listFiles(
  folderId: string = "root",
  pageSize: number = 100
): Promise<DriveFile[]> {
  await ensureValidToken();

  const query = `'${folderId}' in parents and trashed = false`;
  const params = new URLSearchParams({
    q: query,
    pageSize: String(pageSize),
    fields: "files(id,name,mimeType,size,modifiedTime,parents,webViewLink,iconLink,starred)",
    orderBy: "folder,name",
  });

  const data = await driveGet(`/files?${params.toString()}`);
  return data.files || [];
}

/**
 * Search files across the entire Drive.
 * @param queryText — Search text
 */
export async function searchFiles(queryText: string): Promise<DriveFile[]> {
  await ensureValidToken();

  const query = `fullText contains '${queryText.replace(/'/g, "\\'")}' and trashed = false`;
  const params = new URLSearchParams({
    q: query,
    pageSize: "50",
    fields: "files(id,name,mimeType,size,modifiedTime,parents,webViewLink,iconLink)",
    orderBy: "modifiedTime desc",
  });

  const data = await driveGet(`/files?${params.toString()}`);
  return data.files || [];
}

/**
 * Download a file from Drive to local temp directory.
 * Returns the local file path.
 */
export async function downloadFile(fileId: string, fileName: string): Promise<string> {
  await ensureValidToken();

  const localPath = path.join(_tempDir, `${fileId}_${fileName}`);

  // Check if already downloaded
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  const url = `${DRIVE_API}/files/${fileId}?alt=media`;
  await downloadToFile(url, localPath);

  console.log(`[GoogleDrive] Downloaded: ${fileName} → ${localPath}`);
  return localPath;
}

/**
 * Upload a file to Drive.
 * @param localPath — Local file path
 * @param parentFolderId — Drive folder to upload into
 * @param fileName — Optional override for the filename in Drive
 */
export async function uploadFile(
  localPath: string,
  parentFolderId: string = "root",
  fileName?: string
): Promise<DriveFile> {
  await ensureValidToken();

  const name = fileName || path.basename(localPath);
  const stat = await fsp.stat(localPath);
  const fileContent = await fsp.readFile(localPath);

  // Use multipart upload for files under 5MB, resumable for larger
  if (stat.size < 5 * 1024 * 1024) {
    return multipartUpload(name, parentFolderId, fileContent);
  } else {
    return simpleUpload(name, parentFolderId, fileContent);
  }
}

/**
 * Create a folder in Drive.
 * @param name — Folder name
 * @param parentId — Parent folder ID (default: root)
 */
export async function createFolder(
  name: string,
  parentId: string = "root"
): Promise<DriveFolder> {
  await ensureValidToken();

  const metadata = {
    name,
    mimeType: "application/vnd.google-apps.folder",
    parents: [parentId],
  };

  const data = await drivePost("/files", metadata);
  console.log(`[GoogleDrive] Created folder: ${name} (${data.id})`);
  return { id: data.id, name: data.name, parents: data.parents };
}

/**
 * Find or create a folder by name within a parent.
 */
export async function findOrCreateFolder(
  name: string,
  parentId: string = "root"
): Promise<DriveFolder> {
  await ensureValidToken();

  // Search for existing folder
  const query = `name = '${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const params = new URLSearchParams({
    q: query,
    pageSize: "1",
    fields: "files(id,name,parents)",
  });

  const data = await driveGet(`/files?${params.toString()}`);
  if (data.files && data.files.length > 0) {
    return data.files[0];
  }

  return createFolder(name, parentId);
}

/**
 * Move a file to a different folder in Drive.
 */
export async function moveFile(
  fileId: string,
  newParentId: string,
  oldParentId: string
): Promise<DriveFile> {
  await ensureValidToken();

  const params = new URLSearchParams({
    addParents: newParentId,
    removeParents: oldParentId,
    fields: "id,name,mimeType,parents",
  });

  const data = await drivePatch(`/files/${fileId}?${params.toString()}`, {});
  console.log(`[GoogleDrive] Moved file ${fileId} to folder ${newParentId}`);
  return data;
}

/**
 * Organize a Drive file: move it to a category folder within an AI_Organizer root folder.
 * Creates the folder structure if needed.
 */
export async function organizeInDrive(
  fileId: string,
  currentParentId: string,
  category: string,
  rootFolderName: string = "AI_Organized"
): Promise<{ file: DriveFile; folder: DriveFolder }> {
  // Find or create the AI_Organized root folder
  const rootFolder = await findOrCreateFolder(rootFolderName, "root");

  // Find or create the category subfolder
  const categoryFolder = await findOrCreateFolder(category, rootFolder.id);

  // Move the file
  const file = await moveFile(fileId, categoryFolder.id, currentParentId);

  return { file, folder: categoryFolder };
}

/**
 * Get Drive storage quota info.
 */
export async function getStorageQuota(): Promise<{
  limit: string;
  usage: string;
  usageInDrive: string;
}> {
  await ensureValidToken();

  const params = new URLSearchParams({ fields: "storageQuota" });
  const data = await driveGet(`/about?${params.toString()}`);
  return data.storageQuota || { limit: "0", usage: "0", usageInDrive: "0" };
}

/**
 * Clean up temp downloaded files.
 */
export async function cleanupTemp(): Promise<number> {
  let cleaned = 0;
  try {
    const files = await fsp.readdir(_tempDir);
    for (const file of files) {
      const fullPath = path.join(_tempDir, file);
      const stat = await fsp.stat(fullPath);
      // Clean files older than 1 hour
      if (Date.now() - stat.mtimeMs > 60 * 60 * 1000) {
        await fsp.unlink(fullPath);
        cleaned++;
      }
    }
  } catch {}
  return cleaned;
}

// ── Token Management ──────────────────────────────────────────────

async function ensureValidToken(): Promise<void> {
  if (!_tokens) {
    throw new Error("Not authenticated with Google Drive. Please sign in first.");
  }

  // Refresh token if expired or about to expire (5 min buffer)
  if (Date.now() >= _tokens.expiry_date - 5 * 60 * 1000) {
    await refreshAccessToken();
  }
}

async function exchangeCodeForTokens(code: string): Promise<DriveTokens> {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: DEFAULT_REDIRECT_URI,
    grant_type: "authorization_code",
    code_verifier: _pkceVerifier,
  });

  const data = await httpsPost(TOKEN_URL, body.toString(), "application/x-www-form-urlencoded");

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type || "Bearer",
    expiry_date: Date.now() + (data.expires_in || 3600) * 1000,
    scope: data.scope || SCOPES,
  };
}

async function refreshAccessToken(): Promise<void> {
  if (!_tokens || !_tokens.refresh_token) {
    throw new Error("Cannot refresh token — missing refresh token");
  }

  const body = new URLSearchParams({
    refresh_token: _tokens.refresh_token,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const data = await httpsPost(TOKEN_URL, body.toString(), "application/x-www-form-urlencoded");

  _tokens.access_token = data.access_token;
  _tokens.expiry_date = Date.now() + (data.expires_in || 3600) * 1000;
  if (data.refresh_token) _tokens.refresh_token = data.refresh_token;

  saveTokens(_tokens);
  console.log("[GoogleDrive] Token refreshed.");
}

function loadTokens(): DriveTokens | null {
  try {
    if (fs.existsSync(_tokenPath)) {
      return JSON.parse(fs.readFileSync(_tokenPath, "utf-8"));
    }
  } catch {}
  return null;
}

function saveTokens(tokens: DriveTokens): void {
  try {
    fs.writeFileSync(_tokenPath, JSON.stringify(tokens, null, 2), "utf-8");
  } catch (err) {
    console.error(`[GoogleDrive] Failed to save tokens: ${err}`);
  }
}

// ── PKCE Helpers ─────────────────────────────────────────────────

/**
 * Generate a random PKCE code_verifier (43–128 chars, URL-safe).
 */
function generateCodeVerifier(): string {
  return crypto.randomBytes(64).toString("base64url").slice(0, 128);
}

/**
 * Compute PKCE code_challenge = base64url(SHA-256(code_verifier)).
 */
function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// ── HTTP Helpers ──────────────────────────────────────────────────

async function driveGet(endpoint: string): Promise<any> {
  const url = endpoint.startsWith("http") ? endpoint : `${DRIVE_API}${endpoint}`;
  return httpsRequest("GET", url);
}

async function drivePost(endpoint: string, body: any): Promise<any> {
  const url = endpoint.startsWith("http") ? endpoint : `${DRIVE_API}${endpoint}`;
  return httpsRequest("POST", url, JSON.stringify(body), "application/json");
}

async function drivePatch(endpoint: string, body: any): Promise<any> {
  const url = endpoint.startsWith("http") ? endpoint : `${DRIVE_API}${endpoint}`;
  return httpsRequest("PATCH", url, JSON.stringify(body), "application/json");
}

function httpsRequest(
  method: string,
  url: string,
  body?: string,
  contentType?: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        ...(contentType ? { "Content-Type": contentType } : {}),
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        ...(_tokens ? { Authorization: `Bearer ${_tokens.access_token}` } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode && res.statusCode >= 400) {
            const errMsg = json.error?.message || json.error_description || JSON.stringify(json);
            reject(new Error(`Drive API error (${res.statusCode}): ${errMsg}`));
          } else {
            resolve(json);
          }
        } catch {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Drive API error (${res.statusCode}): ${data.slice(0, 200)}`));
          } else {
            resolve(data);
          }
        }
      });
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsPost(url: string, body: string, contentType: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(json.error_description || json.error?.message || data));
          } else {
            resolve(json);
          }
        } catch {
          reject(new Error(`Failed to parse response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function downloadToFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        Authorization: `Bearer ${_tokens?.access_token}`,
      },
    };

    const req = https.request(options, (res) => {
      // Handle redirects
      if (res.statusCode === 302 || res.statusCode === 301) {
        const location = res.headers.location;
        if (location) {
          downloadToFile(location, destPath).then(resolve).catch(reject);
          return;
        }
      }

      if (res.statusCode && res.statusCode >= 400) {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => reject(new Error(`Download failed (${res.statusCode}): ${data.slice(0, 200)}`)));
        return;
      }

      const ws = fs.createWriteStream(destPath);
      res.pipe(ws);
      ws.on("finish", () => { ws.close(); resolve(); });
      ws.on("error", reject);
    });

    req.on("error", reject);
    req.end();
  });
}

async function multipartUpload(
  name: string,
  parentId: string,
  content: Buffer
): Promise<DriveFile> {
  await ensureValidToken();

  const boundary = "----AIOrganizerBoundary" + Date.now();
  const metadata = JSON.stringify({
    name,
    parents: [parentId],
  });

  const bodyParts = [
    `--${boundary}\r\n`,
    `Content-Type: application/json; charset=UTF-8\r\n\r\n`,
    `${metadata}\r\n`,
    `--${boundary}\r\n`,
    `Content-Type: application/octet-stream\r\n\r\n`,
  ];

  const bodyEnd = `\r\n--${boundary}--`;

  const bodyBuf = Buffer.concat([
    Buffer.from(bodyParts.join("")),
    content,
    Buffer.from(bodyEnd),
  ]);

  return new Promise((resolve, reject) => {
    const parsed = new URL(`${UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,size,parents`);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        Authorization: `Bearer ${_tokens?.access_token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": bodyBuf.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(json.error?.message || data));
          } else {
            console.log(`[GoogleDrive] Uploaded: ${name} → ${parentId}`);
            resolve(json);
          }
        } catch {
          reject(new Error(`Upload parse error: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function simpleUpload(
  name: string,
  parentId: string,
  content: Buffer
): Promise<DriveFile> {
  // For larger files, use resumable upload
  // Step 1: Initiate upload session
  await ensureValidToken();

  const metadata = JSON.stringify({
    name,
    parents: [parentId],
  });

  return new Promise((resolve, reject) => {
    const parsed = new URL(`${UPLOAD_API}/files?uploadType=resumable&fields=id,name,mimeType,size,parents`);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        Authorization: `Bearer ${_tokens?.access_token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "Content-Length": Buffer.byteLength(metadata),
        "X-Upload-Content-Length": content.length,
      },
    };

    const initReq = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => reject(new Error(`Resumable init failed: ${data.slice(0, 200)}`)));
        return;
      }

      const uploadUrl = res.headers.location;
      if (!uploadUrl) {
        reject(new Error("No upload URL in response"));
        return;
      }

      // Step 2: Upload content to session URL
      const uploadParsed = new URL(uploadUrl);
      const uploadOptions: https.RequestOptions = {
        hostname: uploadParsed.hostname,
        port: 443,
        path: uploadParsed.pathname + uploadParsed.search,
        method: "PUT",
        headers: {
          "Content-Length": content.length,
          "Content-Type": "application/octet-stream",
        },
      };

      const uploadReq = https.request(uploadOptions, (uploadRes) => {
        let data = "";
        uploadRes.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        uploadRes.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (uploadRes.statusCode && uploadRes.statusCode >= 400) {
              reject(new Error(json.error?.message || data));
            } else {
              console.log(`[GoogleDrive] Uploaded (resumable): ${name}`);
              resolve(json);
            }
          } catch {
            reject(new Error(`Upload parse error: ${data.slice(0, 200)}`));
          }
        });
      });

      uploadReq.on("error", reject);
      uploadReq.write(content);
      uploadReq.end();

      // Consume init response body
      res.resume();
    });

    initReq.on("error", reject);
    initReq.write(metadata);
    initReq.end();
  });
}
