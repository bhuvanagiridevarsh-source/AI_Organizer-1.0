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
var LlamaService_exports = {};
__export(LlamaService_exports, {
  MODEL_DOWNLOAD_URL: () => MODEL_DOWNLOAD_URL,
  MODEL_FILE: () => MODEL_FILE,
  cosineSimilarity: () => cosineSimilarity,
  dispose: () => dispose,
  generate: () => generate,
  getEmbedding: () => getEmbedding,
  getError: () => getError,
  getModelPath: () => getModelPath,
  initialize: () => initialize,
  isReady: () => isReady,
  normalizeVector: () => normalizeVector,
  streamChat: () => streamChat,
  supportsEmbeddings: () => supportsEmbeddings
});
module.exports = __toCommonJS(LlamaService_exports);
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_electron = require("electron");
const MODEL_FILE = "ai-organizer-v2-Q4_K_M.gguf";
const MODEL_DOWNLOAD_URL = "https://github.com/bhuvanagiridevarsh-source/AI_Organizer/releases/download/v2.0/" + MODEL_FILE;
const CTX_CLASSIFY = 4096;
const CTX_CHAT = 8192;
const state = {
  llama: null,
  model: null,
  classifyCtx: null,
  chatCtx: null,
  embedCtx: null,
  ready: false,
  initializing: false,
  error: null
};
function getModelsDir() {
  return import_path.default.join(import_electron.app.getPath("userData"), "models");
}
function getModelPath() {
  const userDataPath = import_path.default.join(getModelsDir(), MODEL_FILE);
  if (import_fs.default.existsSync(userDataPath)) return userDataPath;
  const devBundledPath = import_path.default.join(__dirname, "..", "..", "..", "resources", "models", MODEL_FILE);
  if (import_fs.default.existsSync(devBundledPath)) return devBundledPath;
  if (typeof process !== "undefined" && process.resourcesPath) {
    const prodBundledPath = import_path.default.join(process.resourcesPath, "models", MODEL_FILE);
    if (import_fs.default.existsSync(prodBundledPath)) return prodBundledPath;
  }
  return userDataPath;
}
async function initialize() {
  if (state.ready) return { success: true };
  if (state.initializing) return { success: false, error: "Already initializing" };
  state.initializing = true;
  state.error = null;
  try {
    const { getLlama, LlamaChatSession, LlamaCompletion } = await import("node-llama-cpp");
    const modelPath = getModelPath();
    const fs2 = await import("fs");
    if (!fs2.existsSync(modelPath)) {
      throw new Error(`Model file not found at ${modelPath}. Run first-launch download.`);
    }
    console.log(`[LlamaService] Loading model from ${modelPath} \u2026`);
    state.llama = await getLlama();
    state.model = await state.llama.loadModel({ modelPath });
    state.classifyCtx = await state.model.createContext({ contextSize: CTX_CLASSIFY });
    state.chatCtx = await state.model.createContext({ contextSize: CTX_CHAT });
    try {
      state.embedCtx = await state.model.createEmbeddingContext();
      console.log("[LlamaService] Embedding context ready.");
    } catch {
      console.warn("[LlamaService] Model does not support embeddings \u2014 falling back to TF-IDF.");
      state.embedCtx = null;
    }
    state.ready = true;
    state.initializing = false;
    console.log("[LlamaService] Model loaded and ready.");
    return { success: true };
  } catch (err) {
    state.error = err?.message ?? String(err);
    state.initializing = false;
    console.error(`[LlamaService] Init failed: ${state.error}`);
    return { success: false, error: state.error };
  }
}
function isReady() {
  return state.ready;
}
function getError() {
  return state.error;
}
async function generate(prompt, options = {}) {
  if (!state.ready || !state.classifyCtx) return "";
  const {
    maxTokens = 512,
    temperature = 0.1,
    timeoutMs = 3e4
  } = options;
  try {
    const { LlamaCompletion } = await import("node-llama-cpp");
    const completion = new LlamaCompletion({
      contextSequence: state.classifyCtx.getSequence()
    });
    const timeoutPromise = new Promise(
      (_, reject) => setTimeout(() => reject(new Error("generate() timed out")), timeoutMs)
    );
    const result = await Promise.race([
      completion.generateCompletion(prompt, {
        maxTokens,
        temperature
      }),
      timeoutPromise
    ]);
    return typeof result === "string" ? result.trim() : "";
  } catch (err) {
    console.warn(`[LlamaService] generate() failed: ${err}`);
    return "";
  }
}
async function streamChat(messages, options = {}) {
  if (!state.ready || !state.chatCtx) return "";
  const {
    temperature = 0.7,
    maxTokens = 1024,
    onToken,
    onDone,
    timeoutMs = 12e4
  } = options;
  try {
    const { LlamaChatSession } = await import("node-llama-cpp");
    const systemMsg = messages.find((m) => m.role === "system");
    const userMsgs = messages.filter((m) => m.role !== "system");
    const session = new LlamaChatSession({
      contextSequence: state.chatCtx.getSequence(),
      systemPrompt: systemMsg?.content ?? void 0
    });
    for (let i = 0; i < userMsgs.length - 1; i += 2) {
      const user = userMsgs[i];
      const assistant = userMsgs[i + 1];
      if (user && assistant && assistant.role === "assistant") {
        await session.prompt(user.content, { maxTokens: 2048 });
      }
    }
    const lastUserMsg = [...userMsgs].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return "";
    let fullResponse = "";
    const timeoutPromise = new Promise(
      (_, reject) => setTimeout(() => reject(new Error("streamChat() timed out")), timeoutMs)
    );
    const genPromise = session.prompt(lastUserMsg.content, {
      maxTokens,
      temperature,
      onTextChunk: (chunk) => {
        fullResponse += chunk;
        onToken?.(chunk);
      }
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
async function getEmbedding(text) {
  if (!state.ready || !state.embedCtx) return null;
  try {
    const input = text.slice(0, 2e3);
    const result = await state.embedCtx.getEmbeddingFor(input);
    const raw = Array.from(result.vector);
    if (!raw.length) return null;
    return normalizeVector(raw);
  } catch (err) {
    console.warn(`[LlamaService] getEmbedding() failed: ${err}`);
    return null;
  }
}
function supportsEmbeddings() {
  return state.embedCtx !== null;
}
function normalizeVector(v) {
  let mag = 0;
  for (const x of v) mag += x * x;
  mag = Math.sqrt(mag);
  if (mag === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] /= mag;
  return v;
}
function cosineSimilarity(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(-1, Math.min(1, dot));
}
async function dispose() {
  try {
    state.embedCtx?.dispose?.();
    state.classifyCtx?.dispose?.();
    state.chatCtx?.dispose?.();
    state.model?.dispose?.();
    state.llama?.dispose?.();
  } catch {
  }
  state.llama = null;
  state.model = null;
  state.classifyCtx = null;
  state.chatCtx = null;
  state.embedCtx = null;
  state.ready = false;
  console.log("[LlamaService] Disposed.");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MODEL_DOWNLOAD_URL,
  MODEL_FILE,
  cosineSimilarity,
  dispose,
  generate,
  getEmbedding,
  getError,
  getModelPath,
  initialize,
  isReady,
  normalizeVector,
  streamChat,
  supportsEmbeddings
});
