var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var EmbeddingService_exports = {};
__export(EmbeddingService_exports, {
  cosineSimilarity: () => import_LlamaService.cosineSimilarity,
  getEmbedding: () => getEmbedding,
  isEmbeddingAvailable: () => isEmbeddingAvailable,
  normalizeVector: () => import_LlamaService.normalizeVector,
  resetEmbeddingCache: () => resetEmbeddingCache
});
module.exports = __toCommonJS(EmbeddingService_exports);
var import_LlamaService = require("./LlamaService");
async function getEmbedding(text) {
  if (!(0, import_LlamaService.isReady)()) return null;
  return (0, import_LlamaService.getEmbedding)(text);
}
async function isEmbeddingAvailable() {
  return (0, import_LlamaService.isReady)() && (0, import_LlamaService.supportsEmbeddings)();
}
function resetEmbeddingCache() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  cosineSimilarity,
  getEmbedding,
  isEmbeddingAvailable,
  normalizeVector,
  resetEmbeddingCache
});
