# Testing

Two layers: an automated suite that runs on every change, and a set of hand-built edge-case scenarios for the file-safety guarantees automated tests can't easily cover (real filesystem quirks, collisions, huge files).

## Automated suite

```bash
npm test
```

Runs Node's built-in test runner (`node --test test/*.test.js`) — no external test framework needed.

**Last verified run (2026-07-21, v1.1.3): 91/91 passing, 0 failing.**

```
# tests 91
# suites 0
# pass 91
# fail 0
# cancelled 0
# skipped 0
```

### Coverage

| File | Subject |
|---|---|
| `hashUtil.test.js` | SHA-256 streaming + `filesMatch` content compare |
| `PromptWorkflowService.test.js` | Prompt assembly + RAG orchestration (pure + mocked) |
| `universal-pool-manager.test.js` | Generic-term detection, cross-contamination, pool validation (largest file — 8 tests alone cover distinctiveness scoring and pool merging) |
| `ClassificationService.test.js` | Pure helpers from the classification waterfall (tokenize, normForDedup, etc.) |
| `ComplianceService.test.js` | Audit log rotation — nothing is dropped on overflow |
| `DateExtractService.test.js` | Content-based date extraction for chronological filing |
| `InsightsService.test.js` | Storage breakdown + duplicate detection logic |
| `RenewalService.test.js` | Renewal/expiry date detection |
| `SchedulerService.test.js` | Daily/weekly cadence + grace window logic |
| `VaultService.test.js` | AES-256-GCM encrypt/decrypt round-trips |
| `fileService.test.js` | Exclusive-create move + SHA-256 verification, collision handling, 255-byte name truncation |

Tests target compiled `.js` output in `src/main/`, so run `npm run compile` first if you've changed a `.ts` source.

## Edge-case scenarios

The automated suite covers logic; the edge cases in [`EDGE_CASES.md`](../EDGE_CASES.md) cover real filesystem behavior that's easiest to test by actually creating the files:

1. **Case collision** — `Invoice.pdf` vs `invoice.pdf` in the same destination must both survive, not silently overwrite.
2. **Existing destination folder** — organizing into a `Photos/` folder that already has user files must merge, not overwrite or split into `Photos (2)`.
3. **255-character filenames** — renames must truncate rather than crash with `ENAMETOOLONG`.
4. **Wrong file extension** — a `.pdf` that's actually a PNG (or similar mismatches) must not crash the parser or corrupt the file.
5. **Huge zip (10,000 files)** — must be treated as one opaque file, never auto-extracted, never read entry-by-entry into memory.
6. **Symlinks pointing outside the target folder** — (see file for full scenario and more beyond #6).

Setup/cleanup:

```bash
./create-edge-cases.sh --target ./edge_case_tests
./create-edge-cases.sh --target ./edge_case_tests --clean
```

Run `snapshot.js` before and `validate.js` after each scenario — the check is that every file's content hash still exists somewhere in the output (nothing lost) and the external bait file is byte-identical and untouched.

## Manual testing (for testers)

If you're testing a packaged build by hand rather than running the automated suite:

1. Install per the [root README](../README.md#install) (Mac or Windows).
2. Walk through each feature doc in [docs/README.md](README.md) — each one lists specific things worth checking.
3. Use a real folder with a messy mix of files, or the sample `test_folder` in this repo.
4. Send feedback via **Settings → Send feedback** in-app (saved to a local `feedback.json`), or message it directly.

### What "safe" means in this app, concretely

- Nothing is ever silently overwritten — a naming collision always results in a rename, never data loss.
- Nothing is ever permanently deleted by an organizing/duplicate-finding operation — duplicates go to `_Duplicates`, everything else is undoable via the Undo log.
- A crash mid-run should never leave a file in a half-moved, ambiguous state (exclusive-create + hash verification exists specifically to prevent this).

If you find a case where any of those three break, that's the highest-priority class of bug to report.
