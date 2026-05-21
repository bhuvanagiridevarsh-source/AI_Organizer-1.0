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
var GoogleDriveService_exports = {};
__export(GoogleDriveService_exports, {
  cleanupTemp: () => cleanupTemp,
  createFolder: () => createFolder,
  downloadFile: () => downloadFile,
  findOrCreateFolder: () => findOrCreateFolder,
  getAuthStatus: () => getAuthStatus,
  getStorageQuota: () => getStorageQuota,
  initGoogleDrive: () => initGoogleDrive,
  isAuthenticated: () => isAuthenticated,
  listFiles: () => listFiles,
  moveFile: () => moveFile,
  organizeInDrive: () => organizeInDrive,
  searchFiles: () => searchFiles,
  signOut: () => signOut,
  startAuthFlow: () => startAuthFlow,
  uploadFile: () => uploadFile
});
module.exports = __toCommonJS(GoogleDriveService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_os = __toESM(require("os"));
var import_http = __toESM(require("http"));
var import_https = __toESM(require("https"));
var import_crypto = __toESM(require("crypto"));
var import_url = require("url");
const fsp = import_fs.default.promises;
let _tokens = null;
let _configDir = "";
let _tokenPath = "";
let _isInitialized = false;
let _tempDir = "";
let _pkceVerifier = "";
let _oauthServer = null;
const GOOGLE_CLIENT_ID = "278013680546-oeg3eaikuaoddr537pqnto15qfhtg5rl.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = "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";
const DEFAULT_REDIRECT_URI = "http://localhost:47832/oauth2callback";
const OAUTH_PORT = 47832;
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const SCOPES = [
  "https://www.googleapis.com/auth/drive"
].join(" ");
function initGoogleDrive(userDataDir) {
  _configDir = userDataDir;
  _tokenPath = import_path.default.join(userDataDir, "gdrive_tokens.json");
  _tempDir = import_path.default.join(import_os.default.tmpdir(), "ai_organizer_gdrive");
  if (!import_fs.default.existsSync(_tempDir)) {
    import_fs.default.mkdirSync(_tempDir, { recursive: true });
  }
  _tokens = loadTokens();
  _isInitialized = true;
  console.log(
    `[GoogleDrive] Initialized. Authenticated: ${_tokens !== null}.`
  );
}
function isAuthenticated() {
  return _tokens !== null && !!_tokens.access_token;
}
function getAuthStatus() {
  return {
    isAuthenticated: isAuthenticated(),
    needsRefresh: _tokens !== null && Date.now() >= _tokens.expiry_date
  };
}
function startAuthFlow() {
  return new Promise((resolve) => {
    if (_oauthServer) {
      try {
        _oauthServer.close();
      } catch {
      }
      _oauthServer = null;
    }
    _pkceVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(_pkceVerifier);
    const params = new import_url.URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: DEFAULT_REDIRECT_URI,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent",
      code_challenge: codeChallenge,
      code_challenge_method: "S256"
    });
    const authUrl = `${AUTH_URL}?${params.toString()}`;
    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      if (_oauthServer) {
        try {
          _oauthServer.close();
        } catch {
        }
        _oauthServer = null;
      }
      resolve(result);
    };
    const server = import_http.default.createServer(async (req, res) => {
      if (!req.url || !req.url.startsWith("/oauth2callback")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const url = new import_url.URL(req.url, `http://localhost:${OAUTH_PORT}`);
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
        const tokens = await exchangeCodeForTokens(code);
        _tokens = tokens;
        saveTokens(tokens);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body style='font-family:system-ui;text-align:center;padding:60px;'><h2 style='color:#34d399;'>Connected to Google Drive!</h2><p>You can close this tab and return to AI Organizer.</p></body></html>"
        );
        done({ ok: true });
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>Token exchange failed</h2><p>${err.message}</p></body></html>`);
        done({ ok: false, error: err.message });
      }
    });
    _oauthServer = server;
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.log(`[GoogleDrive] Port ${OAUTH_PORT} in use \u2014 forcing release and retrying...`);
        const cleanup = import_http.default.createServer();
        cleanup.once("error", () => {
          done({ ok: false, error: `Port ${OAUTH_PORT} is in use. Please close any lingering browser tabs from a previous sign-in attempt and try again.` });
        });
        cleanup.listen(OAUTH_PORT, "127.0.0.1", () => {
          cleanup.close(() => {
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
      const { shell } = require("electron");
      shell.openExternal(authUrl);
    });
    setTimeout(() => {
      done({ ok: false, error: "OAuth flow timed out (5 minutes)" });
    }, 5 * 60 * 1e3);
  });
}
function signOut() {
  _tokens = null;
  try {
    import_fs.default.unlinkSync(_tokenPath);
  } catch {
  }
  console.log("[GoogleDrive] Signed out.");
}
async function listFiles(folderId = "root", pageSize = 100) {
  await ensureValidToken();
  const query = `'${folderId}' in parents and trashed = false`;
  const params = new import_url.URLSearchParams({
    q: query,
    pageSize: String(pageSize),
    fields: "files(id,name,mimeType,size,modifiedTime,parents,webViewLink,iconLink,starred)",
    orderBy: "folder,name"
  });
  const data = await driveGet(`/files?${params.toString()}`);
  return data.files || [];
}
async function searchFiles(queryText) {
  await ensureValidToken();
  const query = `fullText contains '${queryText.replace(/'/g, "\\'")}' and trashed = false`;
  const params = new import_url.URLSearchParams({
    q: query,
    pageSize: "50",
    fields: "files(id,name,mimeType,size,modifiedTime,parents,webViewLink,iconLink)",
    orderBy: "modifiedTime desc"
  });
  const data = await driveGet(`/files?${params.toString()}`);
  return data.files || [];
}
async function downloadFile(fileId, fileName) {
  await ensureValidToken();
  const localPath = import_path.default.join(_tempDir, `${fileId}_${fileName}`);
  if (import_fs.default.existsSync(localPath)) {
    return localPath;
  }
  const url = `${DRIVE_API}/files/${fileId}?alt=media`;
  await downloadToFile(url, localPath);
  console.log(`[GoogleDrive] Downloaded: ${fileName} \u2192 ${localPath}`);
  return localPath;
}
async function uploadFile(localPath, parentFolderId = "root", fileName) {
  await ensureValidToken();
  const name = fileName || import_path.default.basename(localPath);
  const stat = await fsp.stat(localPath);
  const fileContent = await fsp.readFile(localPath);
  if (stat.size < 5 * 1024 * 1024) {
    return multipartUpload(name, parentFolderId, fileContent);
  } else {
    return simpleUpload(name, parentFolderId, fileContent);
  }
}
async function createFolder(name, parentId = "root") {
  await ensureValidToken();
  const metadata = {
    name,
    mimeType: "application/vnd.google-apps.folder",
    parents: [parentId]
  };
  const data = await drivePost("/files", metadata);
  console.log(`[GoogleDrive] Created folder: ${name} (${data.id})`);
  return { id: data.id, name: data.name, parents: data.parents };
}
async function findOrCreateFolder(name, parentId = "root") {
  await ensureValidToken();
  const query = `name = '${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const params = new import_url.URLSearchParams({
    q: query,
    pageSize: "1",
    fields: "files(id,name,parents)"
  });
  const data = await driveGet(`/files?${params.toString()}`);
  if (data.files && data.files.length > 0) {
    return data.files[0];
  }
  return createFolder(name, parentId);
}
async function moveFile(fileId, newParentId, oldParentId) {
  await ensureValidToken();
  const params = new import_url.URLSearchParams({
    addParents: newParentId,
    removeParents: oldParentId,
    fields: "id,name,mimeType,parents"
  });
  const data = await drivePatch(`/files/${fileId}?${params.toString()}`, {});
  console.log(`[GoogleDrive] Moved file ${fileId} to folder ${newParentId}`);
  return data;
}
async function organizeInDrive(fileId, currentParentId, category, rootFolderName = "AI_Organized") {
  const rootFolder = await findOrCreateFolder(rootFolderName, "root");
  const categoryFolder = await findOrCreateFolder(category, rootFolder.id);
  const file = await moveFile(fileId, categoryFolder.id, currentParentId);
  return { file, folder: categoryFolder };
}
async function getStorageQuota() {
  await ensureValidToken();
  const params = new import_url.URLSearchParams({ fields: "storageQuota" });
  const data = await driveGet(`/about?${params.toString()}`);
  return data.storageQuota || { limit: "0", usage: "0", usageInDrive: "0" };
}
async function cleanupTemp() {
  let cleaned = 0;
  try {
    const files = await fsp.readdir(_tempDir);
    for (const file of files) {
      const fullPath = import_path.default.join(_tempDir, file);
      const stat = await fsp.stat(fullPath);
      if (Date.now() - stat.mtimeMs > 60 * 60 * 1e3) {
        await fsp.unlink(fullPath);
        cleaned++;
      }
    }
  } catch {
  }
  return cleaned;
}
async function ensureValidToken() {
  if (!_tokens) {
    throw new Error("Not authenticated with Google Drive. Please sign in first.");
  }
  if (Date.now() >= _tokens.expiry_date - 5 * 60 * 1e3) {
    await refreshAccessToken();
  }
}
async function exchangeCodeForTokens(code) {
  const body = new import_url.URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: DEFAULT_REDIRECT_URI,
    grant_type: "authorization_code",
    code_verifier: _pkceVerifier
  });
  const data = await httpsPost(TOKEN_URL, body.toString(), "application/x-www-form-urlencoded");
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type || "Bearer",
    expiry_date: Date.now() + (data.expires_in || 3600) * 1e3,
    scope: data.scope || SCOPES
  };
}
async function refreshAccessToken() {
  if (!_tokens || !_tokens.refresh_token) {
    throw new Error("Cannot refresh token \u2014 missing refresh token");
  }
  const body = new import_url.URLSearchParams({
    refresh_token: _tokens.refresh_token,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token"
  });
  const data = await httpsPost(TOKEN_URL, body.toString(), "application/x-www-form-urlencoded");
  _tokens.access_token = data.access_token;
  _tokens.expiry_date = Date.now() + (data.expires_in || 3600) * 1e3;
  if (data.refresh_token) _tokens.refresh_token = data.refresh_token;
  saveTokens(_tokens);
  console.log("[GoogleDrive] Token refreshed.");
}
function loadTokens() {
  try {
    if (import_fs.default.existsSync(_tokenPath)) {
      return JSON.parse(import_fs.default.readFileSync(_tokenPath, "utf-8"));
    }
  } catch {
  }
  return null;
}
function saveTokens(tokens) {
  try {
    import_fs.default.writeFileSync(_tokenPath, JSON.stringify(tokens, null, 2), "utf-8");
  } catch (err) {
    console.error(`[GoogleDrive] Failed to save tokens: ${err}`);
  }
}
function generateCodeVerifier() {
  return import_crypto.default.randomBytes(64).toString("base64url").slice(0, 128);
}
function generateCodeChallenge(verifier) {
  return import_crypto.default.createHash("sha256").update(verifier).digest("base64url");
}
async function driveGet(endpoint) {
  const url = endpoint.startsWith("http") ? endpoint : `${DRIVE_API}${endpoint}`;
  return httpsRequest("GET", url);
}
async function drivePost(endpoint, body) {
  const url = endpoint.startsWith("http") ? endpoint : `${DRIVE_API}${endpoint}`;
  return httpsRequest("POST", url, JSON.stringify(body), "application/json");
}
async function drivePatch(endpoint, body) {
  const url = endpoint.startsWith("http") ? endpoint : `${DRIVE_API}${endpoint}`;
  return httpsRequest("PATCH", url, JSON.stringify(body), "application/json");
}
function httpsRequest(method, url, body, contentType) {
  return new Promise((resolve, reject) => {
    const parsed = new import_url.URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        ...contentType ? { "Content-Type": contentType } : {},
        ...body ? { "Content-Length": Buffer.byteLength(body) } : {},
        ..._tokens ? { Authorization: `Bearer ${_tokens.access_token}` } : {}
      }
    };
    const req = import_https.default.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk.toString();
      });
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
function httpsPost(url, body, contentType) {
  return new Promise((resolve, reject) => {
    const parsed = new import_url.URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(body)
      }
    };
    const req = import_https.default.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk.toString();
      });
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
async function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const parsed = new import_url.URL(url);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        Authorization: `Bearer ${_tokens?.access_token}`
      }
    };
    const req = import_https.default.request(options, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const location = res.headers.location;
        if (location) {
          downloadToFile(location, destPath).then(resolve).catch(reject);
          return;
        }
      }
      if (res.statusCode && res.statusCode >= 400) {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.on("end", () => reject(new Error(`Download failed (${res.statusCode}): ${data.slice(0, 200)}`)));
        return;
      }
      const ws = import_fs.default.createWriteStream(destPath);
      res.pipe(ws);
      ws.on("finish", () => {
        ws.close();
        resolve();
      });
      ws.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}
async function multipartUpload(name, parentId, content) {
  await ensureValidToken();
  const boundary = "----AIOrganizerBoundary" + Date.now();
  const metadata = JSON.stringify({
    name,
    parents: [parentId]
  });
  const bodyParts = [
    `--${boundary}\r
`,
    `Content-Type: application/json; charset=UTF-8\r
\r
`,
    `${metadata}\r
`,
    `--${boundary}\r
`,
    `Content-Type: application/octet-stream\r
\r
`
  ];
  const bodyEnd = `\r
--${boundary}--`;
  const bodyBuf = Buffer.concat([
    Buffer.from(bodyParts.join("")),
    content,
    Buffer.from(bodyEnd)
  ]);
  return new Promise((resolve, reject) => {
    const parsed = new import_url.URL(`${UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,size,parents`);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        Authorization: `Bearer ${_tokens?.access_token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": bodyBuf.length
      }
    };
    const req = import_https.default.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(json.error?.message || data));
          } else {
            console.log(`[GoogleDrive] Uploaded: ${name} \u2192 ${parentId}`);
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
async function simpleUpload(name, parentId, content) {
  await ensureValidToken();
  const metadata = JSON.stringify({
    name,
    parents: [parentId]
  });
  return new Promise((resolve, reject) => {
    const parsed = new import_url.URL(`${UPLOAD_API}/files?uploadType=resumable&fields=id,name,mimeType,size,parents`);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        Authorization: `Bearer ${_tokens?.access_token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "Content-Length": Buffer.byteLength(metadata),
        "X-Upload-Content-Length": content.length
      }
    };
    const initReq = import_https.default.request(options, (res) => {
      if (res.statusCode !== 200) {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.on("end", () => reject(new Error(`Resumable init failed: ${data.slice(0, 200)}`)));
        return;
      }
      const uploadUrl = res.headers.location;
      if (!uploadUrl) {
        reject(new Error("No upload URL in response"));
        return;
      }
      const uploadParsed = new import_url.URL(uploadUrl);
      const uploadOptions = {
        hostname: uploadParsed.hostname,
        port: 443,
        path: uploadParsed.pathname + uploadParsed.search,
        method: "PUT",
        headers: {
          "Content-Length": content.length,
          "Content-Type": "application/octet-stream"
        }
      };
      const uploadReq = import_https.default.request(uploadOptions, (uploadRes) => {
        let data = "";
        uploadRes.on("data", (chunk) => {
          data += chunk.toString();
        });
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
      res.resume();
    });
    initReq.on("error", reject);
    initReq.write(metadata);
    initReq.end();
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  cleanupTemp,
  createFolder,
  downloadFile,
  findOrCreateFolder,
  getAuthStatus,
  getStorageQuota,
  initGoogleDrive,
  isAuthenticated,
  listFiles,
  moveFile,
  organizeInDrive,
  searchFiles,
  signOut,
  startAuthFlow,
  uploadFile
});
