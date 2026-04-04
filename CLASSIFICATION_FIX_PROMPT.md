# Classification Accuracy Fix — Definitive Surgical Prompt

Apply the following four targeted fixes to `src/main/services/ClassificationService.ts`.
Do NOT restructure, rewrite, or move any other code. Make only the changes described.

---

## FIX 1 — Bullseye: Folder-name substring match (handles "Pre-Calc" ↔ "PreCalc")

**Root cause:** The Bullseye tokenizer splits a hyphenated folder name like `"Pre-Calc"` into
tokens `["pre", "calc"]`, but the filename `"PreCalc Chapter 11.6"` contains the single token
`"precalc"`. The `tokenMatchesWord` ratio check (0.6 floor) then rejects both:
- `"precalc"` vs `"pre"` → 3/7 = 0.43 < 0.6 → ✗
- `"precalc"` vs `"calc"` → doesn't start with "calc" → ✗

So the folder is skipped entirely even though the subject name appears verbatim in the filename.

**Fix:** Inside `tryBullseyeMatch`, at the end of `collectHits()`, right BEFORE the
`// B) Core-topic / alias match` block but AFTER the `if (matched.length === nameWords.length)`
block, add a second name-check that strips hyphens/underscores and tests substring containment:

```typescript
// A-2) Hyphen-normalised folder-name substring match
//      Handles "Pre-Calc" folder ↔ "PreCalc" in filename (and vice-versa).
//      Strip hyphens/underscores from both sides and do a substring check.
const normFolder = folder.toLowerCase().replace(/[-_\s]/g, "");
const normText   = (nameNoExt + " " + (fileContent ? fileContent.split(/\s+/).slice(0, BULLSEYE_CONTENT_WORDS).join(" ") : "")).toLowerCase().replace(/[-_]/g, "");
if (normFolder.length >= 3 && normText.includes(normFolder)) {
  found.push({
    folder,
    matched: normFolder.length,
    total:   normFolder.length,
    via:     `${viaPrefix}normalised-name substring "${normFolder}" in text`,
  });
  continue;
}
```

**Where exactly to insert this code:**

Find this block inside `collectHits()`:
```typescript
      if (matched.length === nameWords.length) {
          found.push({
            folder,
            matched: matched.length,
            total: nameWords.length,
            via: `${viaPrefix}folder name [${matched.join(", ")}]`,
          });
          continue; // name matched — skip alias check
        }
      }

      // B) Core-topic / alias match (≥75 % of topic words)
```

Insert the new A-2 block between the closing `}` of the `if (nameWords.length > 0)` block
and the `// B) Core-topic` comment. It must come BEFORE the core-topics loop.

**IMPORTANT:** The `normText` construction above references `nameNoExt` and `fileContent` and
`BULLSEYE_CONTENT_WORDS` — these are already in scope inside `tryBullseyeMatch`, so the inner
`collectHits` function can access them via closure. This is safe.

---

## FIX 2 — Smart Groups: Filename-hint tiebreaker

**Root cause:** When a user has both a "Biology" folder AND a "Chemistry" folder, both match the
SCIENCE group. Their keyword hits can pile up more total SCIENCE hits than a single "PreCalc"
folder accumulates MATH hits — even for a pure math file — because two folders contribute
independently.

**Fix:** In `trySmartGroupMatch`, after `scores.sort((a, b) => b.hits - a.hits);` and before
`const best = scores[0];`, add a tiebreaker that boosts any folder whose name (or group hints)
appears in the filename:

```typescript
  // Tiebreaker: if any scored folder's name or group hints appear in the
  // filename, boost its score so it wins over same-group competitors.
  const filenameLower = filename.toLowerCase().replace(/[-_]/g, "");
  for (const entry of scores) {
    const folderNorm = entry.folder.toLowerCase().replace(/[-_\s]/g, "");
    if (folderNorm.length >= 3 && filenameLower.includes(folderNorm)) {
      entry.hits += 1000; // large boost — filename is the strongest signal
    }
    // Also boost if any folderHint for this group appears in the filename
    const group = SUBJECT_GROUPS[entry.group];
    if (group) {
      for (const hint of group.folderHints) {
        if (hint.length >= 3 && filenameLower.includes(hint.replace(/[-_\s]/g, ""))) {
          entry.hits += 50;
          break;
        }
      }
    }
  }
  // Re-sort after tiebreaker boost
  scores.sort((a, b) => b.hits - a.hits);
```

Insert this block immediately after:
```typescript
  scores.sort((a, b) => b.hits - a.hits);
  const best = scores[0];
```
→ Replace the two-line block above with the tiebreaker code + `const best = scores[0];`

---

## FIX 3 — Pool Match: Minimum score floor

**Root cause:** The pool match returns a result even when the top score is barely above zero,
causing weak-signal matches (1 or 2 concept hits in a noisy pool) to override the AI fallback
that would have found the right answer.

**Fix:** In `tryPoolMatch()`, find the final `return` block where it picks the best pool
candidate and returns a `ClassificationResult`. Immediately before that `return`, add:

```typescript
  // Score floor: reject pool matches that are too weak to be trusted.
  // A score below 1.5 means fewer than 2 solid concept overlaps —
  // better to let the AI handle it.
  if (topScore < 1.5) return null;
```

To find the right location, search for the line that reads roughly:
```typescript
  console.log(`[Classification] POOL MATCH: ...`);
```
inside `tryPoolMatch`. The score floor check goes immediately before that log line.

---

## FIX 4 — KEYWORD MAP: Add more robust math compound phrases

**Root cause:** The existing math folderMatcher keywords require exact multi-word phrases
("cross product", "vectors in the plane") but student notes often use shorter forms ("vectors",
"cross products", "parametric"). Add single-word high-confidence math terms that are unambiguous
in the context of a precalc/math file.

**Fix:** In the `KEYWORD_MAP` array, find the existing math entry that starts with:
```typescript
  // ── Math compound phrases → dynamic folder match ──────────
  {
    keywords: [
      "cross product", "dot product", "vectors in the plane",
```

Add the following additional keywords to that same entry's `keywords` array:
```
"precalculus", "pre-calculus", "precalc", "pre calc",
"unit circle", "law of sines", "law of cosines", "pythagorean",
"standard form", "vertex form", "completing the square",
"arithmetic sequence", "geometric sequence", "binomial theorem",
"angle of elevation", "angle of depression",
"inverse function", "composition of functions",
"sum and difference", "double angle", "half angle",
```

Do NOT remove any existing keywords. Just add these to the same array.

---

## FIX 5 — Bullseye filename-first shortcut (new pre-check)

**Root cause:** Even with Fixes 1-4, a file like "11.6 Notes.pdf" with no subject identifier in
the name needs multiple keyword hits to route correctly. But the most important signal is always
the folder name itself — if it appears literally anywhere in the filename, that should be a
guaranteed win.

**Fix:** At the very beginning of the `classifyFile` export function, right AFTER the parallel
data-loading block (`await Promise.all(...)`) and BEFORE the Archives Ban (STEP 0), add a
"name-in-filename fast path":

```typescript
  // ── PRE-CHECK: folder name literal in filename ──────────────
  // If any user folder name (ignoring hyphens/underscores/spaces) appears
  // verbatim inside the filename, route there immediately at 100%.
  // This is the strongest possible signal and needs no AI.
  {
    const filenamePlain = filename.toLowerCase().replace(/[-_\s]/g, "");
    for (const folder of userFolders) {
      if (isNoiseFolderName(folder)) continue;
      const folderPlain = folder.toLowerCase().replace(/[-_\s]/g, "");
      if (folderPlain.length >= 4 && filenamePlain.includes(folderPlain)) {
        const result: ClassificationResult = {
          category: folder,
          confidence: 100,
          reasoning: `FILENAME MATCH: folder name "${folder}" found verbatim in filename "${filename}"`,
          isNewFolder: false,
          detected_concepts: [folder],
          concept_abstraction: `Folder name found in filename`,
          requires_review: false,
          was_noise_penalized: false,
          global_domain: "",
          global_subdomain: "",
          suggested_path: "",
          match_level: "bullseye",
        };
        logResult(filename, fileContent, result);
        return result;
      }
    }
  }
```

Insert this block between the `const extension = ...` line and the `// ── STEP 0: Archives Ban` comment.

Also apply the same pre-check to `classifyBatch()`: find the equivalent location inside the
per-file loop in `classifyBatch` (right after the bullseye check) and add the same name-in-filename
guard there too.

---

## AFTER APPLYING ALL FIXES

Run the following commands in order:

```bash
cd /path/to/AI_Organizer
npm run build:mac:protected
```

If `build:mac:protected` fails (obfuscator issue), fall back to:
```bash
npm run build:mac
```

Then test by scanning a folder that contains files with the subject name in the filename
(e.g., "PreCalc Chapter 11.6 Notes.pdf") — they should ALL route to the correct folder
immediately via the FILENAME MATCH pre-check.
