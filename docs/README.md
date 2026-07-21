# System Janitor — Docs

A workflow walkthrough for every feature, plus how the app is tested. Start with the [root README](../README.md) for install instructions if you haven't set the app up yet.

> **Note on the diagrams in this folder:** the app doesn't have real screenshots captured yet, so each feature doc below uses a simple step-by-step flow diagram instead of a screenshot. They show *what happens*, not *what it looks like on screen*. If/when real screenshots are captured, drop them into `docs/screenshots/` and swap the `<img>` references in each feature doc.

## Feature guides

| Doc | Covers |
|---|---|
| [organize-and-classify.md](features/organize-and-classify.md) | Core AI organizing, content-based classification, chronological filing, screenshot sweeper |
| [search-and-chat.md](features/search-and-chat.md) | `⌘K` search palette, collections, `⌘⇧K` chat |
| [smart-rename.md](features/smart-rename.md) | Batch, content-aware renaming |
| [renewal-radar.md](features/renewal-radar.md) | Subscription/contract renewal date detection |
| [scheduler-and-tray.md](features/scheduler-and-tray.md) | Quiet-clean background scheduler, tray + quick-drop window |
| [vault.md](features/vault.md) | Encrypted local Vault |
| [insights-and-duplicates.md](features/insights-and-duplicates.md) | Storage insights dashboard, exact-duplicate finder |
| [trial-and-licensing.md](features/trial-and-licensing.md) | Free trial, paywall, device-bound licensing |

## Testing

See [TESTING.md](TESTING.md) for the automated test suite, edge-case coverage, and how to test a build by hand.

## Safety guarantees that apply across every feature

- Every move/rename is reversible via the Undo log.
- File writes use exclusive-create + SHA-256 verification — a move never completes silently corrupted or half-written.
- Same-named files are never overwritten; the incoming file is renamed instead (`file (2).ext`).
- Filenames are truncated (not left to crash) if a rename would exceed the 255-byte filesystem limit.
- Duplicates are archived, never deleted.
