/**
 * RenameService.ts — AI-powered batch file rename suggestions.
 *
 * Reads the content of a file (via the existing TextExtractionService) and
 * asks the local Ollama model to suggest a clean, professional filename.
 *
 * The prompt is deliberately tight:
 *   - Output ONLY the filename (with extension) — no explanation
 *   - Use snake_case or Title_Case, no spaces
 *   - Include a date if clearly identifiable in the content
 *   - Keep it under 60 characters
 *   - Preserve the original file extension
 *
 * Designed to be fast: uses a short context window so rename suggestions
 * return in 1–3 seconds even on CPU-only machines.
 */

import fs   from "fs";
import path from "path";
import * as LlamaService from "./LlamaService";

// ── Types ──────────────────────────────────────────────────────────────────

export interface RenameSuggestion {
  originalPath: string;
  originalName: string;
  suggestedName: string;
  extension: string;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const CONTENT_LIMIT = 600;  // chars of file content sent to AI (keep it fast)

// Characters not allowed in filenames
const UNSAFE_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

// ── Helpers ────────────────────────────────────────────────────────────────

async function ollamaGenerate(prompt: string): Promise<string> {
  return LlamaService.generate(prompt, { maxTokens: 60, temperature: 0.2, timeoutMs: 15_000 });
}

function sanitizeFilename(name: string, ext: string): string {
  // Strip any extension the AI may have added
  const withoutExt = name.replace(/\.[a-zA-Z0-9]{1,5}$/, "");

  // Replace unsafe characters and collapse whitespace
  const safe = withoutExt
    .replace(UNSAFE_CHARS, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80);

  return safe ? safe + ext : "";
}

function scoreConfidence(original: string, suggested: string): "high" | "medium" | "low" {
  if (!suggested || suggested === original) return "low";
  if (suggested.length > 5 && suggested.length < 60) return "high";
  return "medium";
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Suggest a clean filename for a single file.
 *
 * @param filePath    Absolute path to the file
 * @param textContent Already-extracted text (pass empty string to skip content analysis)
 */
export async function suggestRename(
  filePath: string,
  textContent: string
): Promise<RenameSuggestion> {
  const ext          = path.extname(filePath);
  const originalName = path.basename(filePath);
  const snippet      = textContent.slice(0, CONTENT_LIMIT).replace(/\s+/g, " ").trim();

  const prompt = `You are a file naming assistant. Based on the filename and file content below, suggest ONE clean, professional filename (without extension).

Rules:
- Use_underscores_or_Title_Case (no spaces)
- Include a date like 2024-03-15 if clearly stated in content
- Max 60 characters
- Be specific — avoid generic names like "document" or "file"
- Output ONLY the filename stem, nothing else. No explanation. No quotes.

Filename: ${originalName}
Content preview: ${snippet || "(no text extracted)"}

New filename stem:`;

  let suggested = "";
  let reasoning = "AI suggestion";

  try {
    const raw  = await ollamaGenerate(prompt);
    // Take only the first line in case the model outputs multiple
    const line = raw.split("\n")[0].trim();
    suggested  = sanitizeFilename(line, ext);
    if (!suggested) {
      suggested = originalName;
      reasoning = "AI output was unusable — kept original";
    }
  } catch (err) {
    suggested = originalName;
    reasoning = `AI error: ${err}`;
  }

  return {
    originalPath: filePath,
    originalName,
    suggestedName: suggested,
    extension: ext,
    confidence: scoreConfidence(originalName, suggested),
    reasoning,
  };
}

/**
 * Rename a file on disk from its current name to newName.
 * newName should be a bare filename (no directory), e.g. "Invoice_Acme_2024.pdf".
 * Returns the new absolute path.
 */
export function applyRename(originalPath: string, newName: string): string {
  const dir     = path.dirname(originalPath);
  const newPath = path.join(dir, newName);

  if (newPath === originalPath) return originalPath; // No-op

  if (fs.existsSync(newPath)) {
    throw new Error(`A file named "${newName}" already exists in that folder.`);
  }

  fs.renameSync(originalPath, newPath);
  console.log(`[Rename] ${path.basename(originalPath)} → ${newName}`);
  return newPath;
}
