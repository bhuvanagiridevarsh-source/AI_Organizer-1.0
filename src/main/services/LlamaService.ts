/**
 * LlamaService.ts — On-device AI engine (no Ollama, no internet required).
 *
 * Wraps node-llama-cpp to run GGUF models directly inside the Electron process.
 * This is the single source of AI for the entire app:
 *   - File classification  (generate)
 *   - Chat / file Q&A      (streamChat)
 *   - Knowledge graph      (generate)
 *   - Semantic embeddings  (embed)
 *
 * The GGUF model file lives at:
 *   macOS/Linux : ~/Library/Application Support/system-janitor/models/<MODEL_FILE>
 *   Windows     : %APPDATA%\system-janitor\models\<MODEL_FILE>
 *
 * ModelDownloader.js fetches the GGUF on first launch — nothing else is needed.
 */

import fs from "fs";
import path from "path";
import { app } from "electron";

// ── Configuration ──────────────────────────────────────────────────────────

/** Filename of the custom fine-tuned GGUF (set after training export). */
export const MODEL_FILE = "ai-organizer-v2-Q4_K_M.gguf";

/** Public download URL — host this on your CDN / GitHub release. */
export const MODEL_DOWNLOAD_URL =
  "https://github.com/bhuvanagiridevarsh-source/AI_Organizer-1.0/releases/download/v2.0/" +
  MODEL_FILE;

/** Context window sizes. */
const CTX_CLASSIFY = 4096;
const CTX_CHAT     = 8192;

// ── Internal state ─────────────────────────────────────────────────────────

type LlamaInstance    = any;
type LlamaModelHandle = any;
type LlamaContext     = any;

interface ServiceState {
  llama:           LlamaInstance | null;
  model:           LlamaModelHandle | null;
  classifyCtx:     LlamaContext | null;   // dedicated context for classification
  chatCtx:         LlamaContext | null;   // dedicated context for chat (larger)
  embedCtx:        any | null;            // embedding context (if model supports it)
  ready:           boolean;
  initializing:    boolean;
  error:           string | null;
}

const state: ServiceState = {
  llama:        null,
  model:        null,
  classifyCtx:  null,
  chatCtx:      null,
  embedCtx:     null,
  ready:        false,
  initializing: false,
  error:        null,
};

// ── Helpers ────────────────────────────────────────────────────────────────

function getModelsDir(): string {
  return path.join(app.getPath("userData"), "models");
}

/**
 * Resolve the GGUF model path using a priority-ordered search:
 *
 *  1. userData/models/         — downloaded via first-launch downloader
 *  2. resources/models/        — local dev copy (resources/ inside the project)
 *  3. process.resourcesPath/   — bundled inside the .app package (production)
 *
 * This lets developers drop the GGUF into resources/models/ and skip the
 * download step entirely, and also supports bundled production builds.
 */
export function getModelPath(): string {
  // 1. Standard userData download location
  const userDataPath = path.join(getModelsDir(), MODEL_FILE);
  if (fs.existsSync(userDataPath)) return userDataPath;

  // 2. Dev-time: resources/models/ inside the project root
  //    __dirname = .../src/main/services  → go up 3 levels
  const devBundledPath = path.join(__dirname, "..", "..", "..", "resources", "models", MODEL_FILE);
  if (fs.existsSync(devBundledPath)) return devBundledPath;

  // 3. Production: model bundled as extraResource inside the .app
  if (typeof process !== "undefined" && (process as any).resourcesPath) {
    const prodBundledPath = path.join((process as any).resourcesPath, "models", MODEL_FILE);
    if (fs.existsSync(prodBundledPath)) return prodBundledPath;
  }

  // None found — return standard path (ModelDownloader will trigger the download)
  return userDataPath;
}

// ── Initialization ─────────────────────────────────────────────────────────

/**
 * Load the GGUF model into memory.
 * Must be called once at startup (after the GGUF has been downloaded).
 * Safe to call multiple times — subsequent calls are no-ops if already ready.
 */
export async function initialize(): Promise<{ success: boolean; error?: string }> {
  if (state.ready)        return { success: true };
  if (state.initializing) return { success: false, error: "Already initializing" };

  state.initializing = true;
  state.error        = null;

  try {
    // Dynamic import keeps node-llama-cpp out of the renderer bundle
    const { getLlama, LlamaChatSession, LlamaCompletion } = await import(
      "node-llama-cpp" as any
    );

    const modelPath = getModelPath();
    const fs        = await import("fs");
    if (!fs.existsSync(modelPath)) {
      throw new Error(`Model file not found at ${modelPath}. Run first-launch download.`);
    }

    console.log(`[LlamaService] Loading model from ${modelPath} …`);

    // Get the llama instance (auto-detects GPU/CPU, Electron ABI)
    state.llama = await getLlama();
    state.model = await state.llama.loadModel({ modelPath });

    // Create two contexts — one small for fast classification, one large for chat
    state.classifyCtx = await state.model.createContext({ contextSize: CTX_CLASSIFY });
    state.chatCtx     = await state.model.createContext({ contextSize: CTX_CHAT });

    // Try to create an embedding context (works if model supports it)
    try {
      state.embedCtx = await state.model.createEmbeddingContext();
      console.log("[LlamaService] Embedding context ready.");
    } catch {
      console.warn("[LlamaService] Model does not support embeddings — falling back to TF-IDF.");
      state.embedCtx = null;
    }

    state.ready        = true;
    state.initializing = false;
    console.log("[LlamaService] Model loaded and ready.");
    return { success: true };
  } catch (err: any) {
    state.error        = err?.message ?? String(err);
    state.initializing = false;
    console.error(`[LlamaService] Init failed: ${state.error}`);
    return { success: false, error: state.error };
  }
}

/** True once initialize() has succeeded. */
export function isReady(): boolean {
  return state.ready;
}

/** Last error message from initialization or inference. */
export function getError(): string | null {
  return state.error;
}

// ── Text Generation ────────────────────────────────────────────────────────

interface GenerateOptions {
  maxTokens?:   number;
  temperature?: number;
  timeoutMs?:   number;
}

/**
 * Single-shot text generation (non-streaming).
 * Used by: ClassificationService, KnowledgeGraphService, RenameService, index.js.
 *
 * Returns empty string on failure — callers must handle gracefully.
 */
export async function generate(
  prompt: string,
  options: GenerateOptions = {}
): Promise<string> {
  if (!state.ready || !state.classifyCtx) return "";

  const {
    maxTokens   = 512,
    temperature = 0.1,
    timeoutMs   = 30_000,
  } = options;

  try {
    const { LlamaCompletion } = await import("node-llama-cpp" as any);

    const completion = new LlamaCompletion({
      contextSequence: state.classifyCtx.getSequence(),
    });

    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("generate() timed out")), timeoutMs)
    );

    const result = await Promise.race([
      completion.generateCompletion(prompt, {
        maxTokens,
        temperature,
      }),
      timeoutPromise,
    ]);

    return typeof result === "string" ? result.trim() : "";
  } catch (err) {
    console.warn(`[LlamaService] generate() failed: ${err}`);
    return "";
  }
}

// ── Streaming Chat ─────────────────────────────────────────────────────────

interface ChatMessage {
  role:    "system" | "user" | "assistant";
  content: string;
}

interface ChatOptions {
  temperature?: number;
  maxTokens?:   number;
  onToken?:     (token: string) => void;
  onDone?:      () => void;
  timeoutMs?:   number;
}

/**
 * Streaming multi-turn chat.
 * Used by: ChatService.
 *
 * Calls `onToken` for each generated token (for real-time UI streaming).
 * Calls `onDone` when generation is complete.
 * Returns the full response string.
 */
export async function streamChat(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<string> {
  if (!state.ready || !state.chatCtx) return "";

  const {
    temperature = 0.7,
    maxTokens   = 1024,
    onToken,
    onDone,
    timeoutMs   = 120_000,
  } = options;

  try {
    const { LlamaChatSession } = await import("node-llama-cpp" as any);

    // Separate out the system prompt if present
    const systemMsg = messages.find((m) => m.role === "system");
    const userMsgs  = messages.filter((m) => m.role !== "system");

    const session = new LlamaChatSession({
      contextSequence: state.chatCtx.getSequence(),
      systemPrompt:    systemMsg?.content ?? undefined,
    });

    // Replay prior assistant messages so the model has conversation history
    for (let i = 0; i < userMsgs.length - 1; i += 2) {
      const user      = userMsgs[i];
      const assistant = userMsgs[i + 1];
      if (user && assistant && assistant.role === "assistant") {
        // Feed previous turns to the session context silently
        await session.prompt(user.content, { maxTokens: 2048 });
      }
    }

    // The last user message triggers actual generation
    const lastUserMsg = [...userMsgs].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return "";

    let fullResponse = "";
    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("streamChat() timed out")), timeoutMs)
    );

    const genPromise = session.prompt(lastUserMsg.content, {
      maxTokens,
      temperature,
      onTextChunk: (chunk: string) => {
        fullResponse += chunk;
        onToken?.(chunk);
      },
    });

    await Promise.race([genPromise, timeoutPromise]);
    onDone?.();
    return fullResponse.trim();
  } catch (err) {
    console.warn(`[LlamaService] streamChat() failed: ${err}`);
    onDone?.();
    return "";
  }
}

// ── Embeddings ─────────────────────────────────────────────────────────────

/**
 * Generate a normalized unit embedding vector for `text`.
 *
 * Returns null if:
 *   - Model not loaded
 *   - Model doesn't support embeddings
 *   - Any inference error
 *
 * Callers treat null as "fall back to TF-IDF only."
 */
export async function getEmbedding(text: string): Promise<number[] | null> {
  if (!state.ready || !state.embedCtx) return null;

  try {
    // Truncate to avoid very long contexts degrading embed quality/speed
    const input = text.slice(0, 2000);
    const result = await state.embedCtx.getEmbeddingFor(input);

    // node-llama-cpp returns Float32Array; convert to plain number[]
    const raw: number[] = Array.from(result.vector as Float32Array);
    if (!raw.length) return null;

    return normalizeVector(raw);
  } catch (err) {
    console.warn(`[LlamaService] getEmbedding() failed: ${err}`);
    return null;
  }
}

/** True if the loaded model supports embedding generation. */
export function supportsEmbeddings(): boolean {
  return state.embedCtx !== null;
}

// ── Math helpers ───────────────────────────────────────────────────────────

export function normalizeVector(v: number[]): number[] {
  let mag = 0;
  for (const x of v) mag += x * x;
  mag = Math.sqrt(mag);
  if (mag === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] /= mag;
  return v;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(-1, Math.min(1, dot));
}

// ── Cleanup ────────────────────────────────────────────────────────────────

/** Release all model memory. Call before app quit. */
export async function dispose(): Promise<void> {
  try {
    state.embedCtx?.dispose?.();
    state.classifyCtx?.dispose?.();
    state.chatCtx?.dispose?.();
    state.model?.dispose?.();
    state.llama?.dispose?.();
  } catch {}

  state.llama       = null;
  state.model       = null;
  state.classifyCtx = null;
  state.chatCtx     = null;
  state.embedCtx    = null;
  state.ready       = false;

  console.log("[LlamaService] Disposed.");
}
