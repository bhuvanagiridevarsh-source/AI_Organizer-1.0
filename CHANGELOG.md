# Changelog

All notable changes to System Janitor. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [1.1.3] — 2026-07-21 (latest)

This is a documentation/release-hygiene pass, done for external testers — no functional/feature changes since 1.1.2.

### Added
- Root `README.md` — Mac + Windows install instructions, full feature list, minimum specs, "what to try first," and a build-from-source section. This is the file to hand a new tester.
- `docs/` folder — one workflow doc per feature (organize & classify, search & chat, smart rename, renewal radar, scheduler & tray, vault, insights & duplicates, trial & licensing), each with a step-by-step flow diagram.
- `docs/TESTING.md` — consolidates the automated suite, edge-case coverage, and manual testing steps into one place, with the current verified pass count.
- This changelog.

### Fixed / verified
- Re-ran the full test suite: **91/91 passing**, confirmed clean on 2026-07-21.
- Confirmed no stray version drift: `package.json`, this changelog, and the git tag are now in sync at 1.1.3.

### Known gaps (unchanged from 1.1.2, tracked in `DEPLOY.md`)
- macOS builds are unsigned — auto-update silently fails on Mac.
- Backend device-limit enforcement fails open until the Supabase `license_devices` migration is run.
- `TESTING_MODE=true` still bypasses the paywall (expected for this testing build).
- No Stripe payment link configured yet.

## [1.1.2] — 2026-07-09

### Fixed
- Removed `stress_test_folder` (1.6 GB) from git tracking — it was breaking Windows checkouts.

## [1.1.1] — 2026-07-06

Stabilization pass on top of the 1.1.0 feature pack.

## [1.1.0] — 2026-07-06

### Added — 9-feature pack
- `⌘K` search palette + saved collections; `⌘⇧K` chat interface.
- Smart Rename — batch, content-aware file renaming.
- Chronological filing — files documents by date extracted from content.
- Screenshot sweeper.
- Renewal Radar — regex-based detection of subscription/contract renewal dates.
- Quiet-clean scheduler — daily/weekly background organizing with a 6-hour grace window.
- Tray + quick-drop window for instant filing.
- Encrypted Vault (AES-256-GCM, via OS secure storage) — not license-gated.

## [1.0.9] — 2026-06-25

### Added
- Free trial (300 file moves) + paywall.
- Device-bound licensing (max 2 devices per key), backed by Stripe → Supabase → Resend.
- Insights dashboard + exact-duplicate finder — duplicates archived to `_Duplicates`, never deleted, single-step undo.

## [1.0.8] and earlier

Foundational releases: core AI classification engine, local llama.cpp model integration, OCR/PDF/Word content parsing, exclusive-create + SHA-256-verified file moves, undo log, and packaging/build hardening (dropped `better-sqlite3` in favor of a JSON fallback, defensive `electron-store`, asar verifier). See `git log` for the full commit history.
