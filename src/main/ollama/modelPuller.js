/**
 * modelPuller.js — Check if a model is installed, pull it with progress if not.
 *
 * Uses the Ollama HTTP API (localhost:11434) for reliable JSON progress
 * instead of parsing CLI stdout.
 *
 * Usage from main process:
 *   const { checkAndPullModel } = require("./ollama/modelPuller");
 *   await checkAndPullModel("llama3.2:1b", (pct) => {
 *     mainWindow.webContents.send("pull-progress", pct);
 *   });
 */

const http = require("http");

const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 4000;
const CONNECT_TIMEOUT_MS = 10000;

/**
 * Hit GET /api/tags and check if modelName is in the list.
 */
async function isModelInstalled(modelName) {
  return new Promise((resolve) => {
    const req = http.get(
      `http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/tags`,
      { timeout: CONNECT_TIMEOUT_MS },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            const models = (data.models || []).map((m) => m.name);
            // Ollama stores names as "llama3.2:1b" or "llama3.2:latest"
            const found = models.some(
              (n) =>
                n === modelName ||
                n.startsWith(modelName + ":") ||
                n === modelName + ":latest"
            );
            resolve(found);
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * POST /api/pull with streaming JSON progress.
 * Calls onProgress(percent) as download advances.
 * Returns a promise that resolves when complete or rejects on error.
 */
function pullModelStream(modelName, onProgress) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ name: modelName, stream: true });

    const req = http.request(
      {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: "/api/pull",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
        timeout: 0, // no timeout — large downloads take a while
      },
      (res) => {
        let buffer = "";

        res.on("data", (chunk) => {
          buffer += chunk.toString();

          // Ollama streams newline-delimited JSON
          const lines = buffer.split("\n");
          buffer = lines.pop(); // keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);

              if (msg.total && msg.completed) {
                const pct = Math.round((msg.completed / msg.total) * 100);
                onProgress(pct);
              }

              if (msg.status === "success") {
                onProgress(100);
              }

              // Ollama error inside stream
              if (msg.error) {
                reject(new Error(msg.error));
                return;
              }
            } catch {
              // Ignore malformed lines
            }
          }
        });

        res.on("end", () => resolve());
        res.on("error", (err) => reject(err));
      }
    );

    req.on("error", (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

/**
 * Main entry point. Checks if model exists, pulls with retries if not.
 *
 * @param {string} modelName - e.g. "llama3.2:1b"
 * @param {function} onProgress - called with 0-100 percent
 * @returns {Promise<void>}
 */
async function checkAndPullModel(modelName, onProgress = () => {}) {
  const installed = await isModelInstalled(modelName);
  if (installed) {
    onProgress(100);
    return;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(
        `[modelPuller] Pulling ${modelName} (attempt ${attempt}/${MAX_RETRIES})...`
      );
      await pullModelStream(modelName, onProgress);
      return; // success
    } catch (err) {
      lastError = err;
      console.warn(`[modelPuller] Attempt ${attempt} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  throw new Error(
    `Failed to pull ${modelName} after ${MAX_RETRIES} attempts: ${lastError?.message}`
  );
}

module.exports = { checkAndPullModel, isModelInstalled };
