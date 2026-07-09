/**
 * modelDownloader.js — Downloads the GGUF model on first launch.
 *
 * Replaces the old Ollama modelPuller. Instead of pulling from Ollama's
 * registry, we download the GGUF directly from a URL to:
 *   userData/models/ai-organizer-v2-Q4_K_M.gguf
 *
 * Progress events sent to the renderer via IPC (channel names/payload shapes
 * MUST match what preload.js exposes and renderer.js's modelDownloadModule
 * listens for — this drifted apart once before and silently broke the
 * progress pill even on successful downloads):
 *   "model:pull-progress"  { pct, model, downloaded, total }
 *   "model:pull-retry"     { attempt, maxAttempts, reason, model }
 *   "model:pull-done"      { model }
 *   "model:pull-error"     { error, model }
 *
 * Reliability notes:
 * A chunk of real-world failures here are TLS-layer (e.g. Windows machines
 * running SSL-inspecting antivirus/corporate proxies that corrupt the TLS
 * record stream — surfaces as "BAD_DECRYPT" from the TLS library) rather than
 * plain HTTP errors. Those corrupt the in-flight socket, not just the request,
 * so we: (1) never reuse a socket/agent across attempts, (2) time out stalled
 * connections instead of hanging forever, (3) retry with backoff, and
 * (4) throw away a partial .part file once we've failed on it — resuming a
 * range read against bytes that may have been corrupted by a broken TLS
 * session is how you end up with a "successful" download that's silently bad.
 */

const https    = require("https");
const http     = require("http");
const fs       = require("fs");
const path     = require("path");
const { app }  = require("electron");

// These must match LlamaService.ts constants
const MODEL_FILE         = "ai-organizer-v2-Q4_K_M.gguf";
const MODEL_DOWNLOAD_URL = process.env.MODEL_DOWNLOAD_URL ||
  "https://github.com/bhuvanagiridevarsh-source/AI_Organizer-1.0/releases/download/v2.0/" +
  MODEL_FILE;

const MAX_ATTEMPTS       = 4;
const RETRY_BASE_DELAY_MS = 2000; // 2s, 4s, 8s, …
const SOCKET_TIMEOUT_MS   = 30_000; // abort a stalled connection/read

function getModelsDir() {
  return path.join(app.getPath("userData"), "models");
}

/**
 * Resolve model path with fallback chain:
 *  1. userData/models/           (downloaded)
 *  2. resources/models/          (dev copy)
 *  3. process.resourcesPath/     (production bundle)
 */
function getModelPath() {
  // 1. Standard userData download location
  const userDataPath = path.join(getModelsDir(), MODEL_FILE);
  if (fs.existsSync(userDataPath) && fs.statSync(userDataPath).size > 100 * 1024 * 1024)
    return userDataPath;

  // 2. Dev-time: resources/models/ inside the project root
  const devBundledPath = path.join(__dirname, "..", "..", "..", "resources", "models", MODEL_FILE);
  if (fs.existsSync(devBundledPath) && fs.statSync(devBundledPath).size > 100 * 1024 * 1024)
    return devBundledPath;

  // 3. Production: bundled as extraResource
  if (process.resourcesPath) {
    const prodBundledPath = path.join(process.resourcesPath, "models", MODEL_FILE);
    if (fs.existsSync(prodBundledPath) && fs.statSync(prodBundledPath).size > 100 * 1024 * 1024)
      return prodBundledPath;
  }

  // None found — return standard userData path (download will be triggered)
  return userDataPath;
}

/**
 * Returns true if the model GGUF already exists on disk (any location).
 */
function isModelDownloaded() {
  const p = getModelPath();
  if (!fs.existsSync(p)) return false;
  // Sanity check: file must be at least 100 MB (a partial download is useless)
  const stat = fs.statSync(p);
  return stat.size > 100 * 1024 * 1024;
}

/**
 * Download the GGUF from MODEL_DOWNLOAD_URL.
 *
 * @param {Electron.BrowserWindow | null} window  — Renderer window (for IPC progress)
 * @param {(percent: number) => void}     onProgress — Optional JS callback
 * @returns {Promise<{ success: boolean, path?: string, error?: string }>}
 */
function downloadModel(window, onProgress) {
  const modelsDir = getModelsDir();
  if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });

  const destPath = getModelPath();
  const tmpPath  = destPath + ".part";

  console.log(`[ModelDownloader] Downloading ${MODEL_FILE} …`);
  console.log(`[ModelDownloader] URL: ${MODEL_DOWNLOAD_URL}`);
  console.log(`[ModelDownloader] Dest: ${destPath}`);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const discardPartial = (reason) => {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
        console.warn(`[ModelDownloader] Discarded partial download (${reason})`);
      } catch (e) {
        console.warn(`[ModelDownloader] Could not remove partial file: ${e.message}`);
      }
    }
  };

  // Runs a single end-to-end attempt (following redirects). Resolves with
  // { success, path } or rejects with an Error describing what went wrong —
  // the retry loop below decides whether the error is worth retrying.
  const attemptOnce = () => {
    return new Promise((resolve, reject) => {
      // Every attempt gets a fresh, non-keep-alive agent. Reusing a socket
      // that just threw a TLS decrypt error tends to reproduce the same
      // failure instantly instead of giving the retry a clean shot.
      const agentOpts = { keepAlive: false };
      const httpsAgent = new https.Agent(agentOpts);
      const httpAgent  = new http.Agent(agentOpts);

      // Only resume a partial file within a single attempt's redirect chain;
      // across attempts we decide up-front (see downloadModel loop) whether
      // to keep or discard the .part file.
      let startByte = 0;
      if (fs.existsSync(tmpPath)) {
        startByte = fs.statSync(tmpPath).size;
        if (startByte > 0) console.log(`[ModelDownloader] Resuming from byte ${startByte}`);
      }

      const MAX_REDIRECTS = 6;

      // Issues the GET and follows redirects using the Location header. GitHub
      // release downloads ALWAYS 302 to a signed object-storage URL, so we must
      // follow the redirect target — re-requesting the original URL would just
      // redirect again forever (the previous bug).
      const doRequest = (currentUrl, redirectsLeft) => {
        let url;
        try { url = new URL(currentUrl); }
        catch {
          reject(new Error(`Bad URL: ${currentUrl}`));
          return;
        }
        const protocol = url.protocol === "https:" ? https : http;

        const reqOptions = {
          hostname: url.hostname,
          port:     url.port || (url.protocol === "https:" ? 443 : 80),
          path:     url.pathname + url.search,
          method:   "GET",
          agent:    url.protocol === "https:" ? httpsAgent : httpAgent,
          headers:  startByte > 0 ? { Range: `bytes=${startByte}-` } : {},
        };

        const req = protocol.request(reqOptions, (res) => {
          // Follow redirects to where the server actually points us.
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            res.resume(); // drain the response
            const location = res.headers.location;
            if (!location || redirectsLeft <= 0) {
              reject(new Error(`Redirect failed (HTTP ${res.statusCode}, no usable Location)`));
              return;
            }
            // Resolve relative redirects against the current URL.
            const nextUrl = new URL(location, url).toString();
            console.log(`[ModelDownloader] Redirect → ${nextUrl}`);
            doRequest(nextUrl, redirectsLeft - 1);
            return;
          }

          if (res.statusCode !== 200 && res.statusCode !== 206) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          const contentLength = parseInt(res.headers["content-length"] || "0", 10);
          const totalBytes    = contentLength + startByte;
          let   downloaded    = startByte;

          const writeStream = fs.createWriteStream(tmpPath, {
            flags: startByte > 0 ? "a" : "w",
          });

          res.on("data", (chunk) => {
            downloaded += chunk.length;
            writeStream.write(chunk);

            if (totalBytes > 0) {
              const percent = Math.round((downloaded / totalBytes) * 100);
              onProgress?.(percent);
              // NOTE: channel + payload shape must match what preload.js /
              // renderer.js's modelDownloadModule actually listen for
              // ("model:pull-progress", { pct }) — a previous mismatch here
              // ("model:download-progress", { percent }) meant the renderer's
              // progress pill silently never updated and never learned the
              // download had finished, even on success.
              window?.webContents?.send("model:pull-progress", {
                pct: percent,
                model: MODEL_FILE,
                downloaded,
                total: totalBytes,
              });
            }
          });

          res.on("end", () => {
            writeStream.end(() => {
              if (downloaded < 100 * 1024 * 1024) {
                reject(new Error("Downloaded file is too small — possible corrupt download."));
                return;
              }

              // Rename .part → final
              fs.renameSync(tmpPath, destPath);
              console.log(`[ModelDownloader] Download complete → ${destPath}`);
              window?.webContents?.send("model:pull-done", { model: MODEL_FILE });
              resolve({ success: true, path: destPath });
            });
          });

          res.on("error", (err) => {
            writeStream.end();
            reject(err);
          });
        });

        // Guard against a connection that stalls silently (common symptom of
        // TLS-intercepting proxies/AVs) — without this a broken proxy can hang
        // the download forever instead of erroring out so we can retry.
        req.setTimeout(SOCKET_TIMEOUT_MS, () => {
          req.destroy(new Error(`Connection stalled (no data for ${SOCKET_TIMEOUT_MS / 1000}s)`));
        });

        req.on("error", (err) => reject(err));
        req.end();
      };

      doRequest(MODEL_DOWNLOAD_URL, MAX_REDIRECTS);
    });
  };

  // Errors that are almost certainly not going to be fixed by retrying
  // (bad URL, redirect loop, clearly-wrong HTTP status) — fail fast instead
  // of burning attempts. Everything else (TLS/socket/network-ish errors) gets
  // retried.
  const isFatal = (err) => /^Bad URL:|^Redirect failed|^HTTP 4\d\d/.test(err.message);

  return (async () => {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Any error on a previous attempt means we don't trust the partial
      // bytes already on disk (a TLS decrypt failure can corrupt the tail of
      // what looked like a fine transfer) — start that attempt clean.
      if (attempt > 1) discardPartial(`retry attempt ${attempt}`);

      try {
        const result = await attemptOnce();
        return result;
      } catch (err) {
        lastError = err;
        console.error(`[ModelDownloader] Attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);

        if (isFatal(err) || attempt === MAX_ATTEMPTS) break;

        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        window?.webContents?.send("model:pull-retry", {
          model: MODEL_FILE,
          attempt: attempt + 1,
          maxAttempts: MAX_ATTEMPTS,
          reason: err.message,
        });
        console.log(`[ModelDownloader] Retrying in ${delay}ms …`);
        await sleep(delay);
      }
    }

    // All attempts exhausted (or a fatal, non-retryable error) — clean up and
    // surface the last error to the caller.
    discardPartial("final failure");
    const message = lastError ? lastError.message : "Unknown download error";
    console.error(`[ModelDownloader] Download failed after ${MAX_ATTEMPTS} attempts: ${message}`);
    window?.webContents?.send("model:pull-error", { error: message, model: MODEL_FILE });
    return { success: false, error: message };
  })();
}

/**
 * Ensure the model is available.
 * - If already downloaded: returns immediately.
 * - If missing: starts download and resolves when done.
 */
async function ensureModel(window, onProgress) {
  if (isModelDownloaded()) {
    console.log("[ModelDownloader] Model already present — skipping download.");
    return { success: true, path: getModelPath(), alreadyPresent: true };
  }
  return downloadModel(window, onProgress);
}

module.exports = {
  MODEL_FILE,
  MODEL_DOWNLOAD_URL,
  getModelPath,
  getModelsDir,
  isModelDownloaded,
  ensureModel,
  downloadModel,
};
