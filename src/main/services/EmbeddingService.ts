/**
 * EmbeddingService.ts — Semantic embeddings via LlamaService (no Ollama).
 *
 * Delegates to LlamaService.getEmbedding() which uses node-llama-cpp directly.
 * Falls back gracefully to null (TF-IDF only) if embeddings aren't available.
 */

import {
  getEmbedding    as llamaGetEmbedding,
  supportsEmbeddings,
  normalizeVector as llamaNormalize,
  cosineSimilarity as llamaCosine,
  isReady,
} from "./LlamaService";

// Re-export math utilities so callers don't need to change their imports
export { llamaNormalize as normalizeVector, llamaCosine as cosineSimilarity };

/**
 * Generate a normalized unit embedding vector for `text`.
 *
 * Returns null if:
 *   - LlamaService not yet initialized
 *   - Loaded model doesn't support embeddings
 *   - Any inference error
 *
 * Callers treat null as "embeddings unavailable; use TF-IDF only."
 */
export async function getEmbedding(text: string): Promise<number[] | null> {
  if (!isReady()) return null;
  return llamaGetEmbedding(text);
}

/**
 * Returns true if the current model supports embedding generation.
 * Fast — uses cached state, no inference call.
 */
export async function isEmbeddingAvailable(): Promise<boolean> {
  return isReady() && supportsEmbeddings();
}

/**
 * No-op — kept for API compatibility with old callers.
 * LlamaService handles its own state.
 */
export function resetEmbeddingCache(): void {
  // Nothing to do — LlamaService manages this internally
}
