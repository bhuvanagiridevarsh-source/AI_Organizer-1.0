/**
 * modelDownloader.js — Downloads the GGUF model on first launch.
 *
 * Replaces the old Ollama modelPuller. Instead of pulling from Ollama's
 * registry, we download the GGUF directly from a URL to:
 *   userData/models/ai-organizer-v2-Q4_K_M.gguf
 *
 * Progress events sent to the renderer via IPC:
 *   "model:download-progress"  { percent, downloaded, total }
 *   "model:download-done"
 *   "model:download-error"     { message }
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
  return new Promise((resolve) => {
    const modelsDir = getModelsDir();
    if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });

    const destPath = getModelPath();
    const tmpPath  = destPath + ".part";

    console.log(`[ModelDownloader] Downloading ${MODEL_FILE} …`);
    console.log(`[ModelDownloader] URL: ${MODEL_DOWNLOAD_URL}`);
    console.log(`[ModelDownloader] Dest: ${destPath}`);

    // Resume partial download if we were interrupted last time
    let startByte = 0;
    if (fs.existsSync(tmpPath)) {
      startByte = fs.statSync(tmpPath).size;
      console.log(`[ModelDownloader] Resuming from byte ${startByte}`);
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
        const e = `Bad URL: ${currentUrl}`;
        window?.webContents?.send("model:download-error", { message: e });
        resolve({ success: false, error: e });
        return;
      }
      const protocol = url.protocol === "https:" ? https : http;

      const reqOptions = {
        hostname: url.hostname,
        port:     url.port || (url.protocol === "https:" ? 443 : 80),
        path:     url.pathname + url.search,
        method:   "GET",
        headers:  startByte > 0 ? { Range: `bytes=${startByte}-` } : {},
      };

      const req = protocol.request(reqOptions, (res) => {
        // Follow redirects to where the server actually points us.
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume(); // drain the response
          const location = res.headers.location;
          if (!location || redirectsLeft <= 0) {
            const err = `Redirect failed (HTTP ${res.statusCode}, no usable Location)`;
            console.error(`[ModelDownloader] ${err}`);
            window?.webContents?.send("model:download-error", { message: err });
            resolve({ success: false, error: err });
            return;
          }
          // Resolve relative redirects against the current URL.
          const nextUrl = new URL(location, url).toString();
          console.log(`[ModelDownloader] Redirect → ${nextUrl}`);
          doRequest(nextUrl, redirectsLeft - 1);
          return;
        }

        if (res.statusCode !== 200 && res.statusCode !== 206) {
          const err = `HTTP ${res.statusCode}`;
          console.error(`[ModelDownloader] Download failed: ${err}`);
          window?.webContents?.send("model:download-error", { message: err });
          resolve({ success: false, error: err });
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
            window?.webContents?.send("model:download-progress", {
              percent,
              downloaded,
              total: totalBytes,
            });
          }
        });

        res.on("end", () => {
          writeStream.end(() => {
            if (downloaded < 100 * 1024 * 1024) {
              const err = "Downloaded file is too small — possible corrupt download.";
              window?.webContents?.send("model:download-error", { message: err });
              resolve({ success: false, error: err });
              return;
            }

            // Rename .part → final
            fs.renameSync(tmpPath, destPath);
            console.log(`[ModelDownloader] Download complete → ${destPath}`);
            window?.webContents?.send("model:download-done");
            resolve({ success: true, path: destPath });
          });
        });

        res.on("error", (err) => {
          writeStream.end();
          console.error(`[ModelDownloader] Stream error: ${err.message}`);
          window?.webContents?.send("model:download-error", { message: err.message });
          resolve({ success: false, error: err.message });
        });
      });

      req.on("error", (err) => {
        console.error(`[ModelDownloader] Request error: ${err.message}`);
        window?.webContents?.send("model:download-error", { message: err.message });
        resolve({ success: false, error: err.message });
      });

      req.end();
    };

    doRequest(MODEL_DOWNLOAD_URL, MAX_REDIRECTS);
  });
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
