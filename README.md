# System Janitor

**A private, local AI file organizer for macOS and Windows.**

System Janitor scans a messy folder, reads what's actually *in* your files (not just the filename), and files everything into a clean structure — entirely on your own device. No cloud AI calls, no file uploads.

Current version: **1.1.3** · [Release notes](CHANGELOG.md) · [Feature docs](docs/README.md) · [Testing details](docs/TESTING.md)

---

## What's in this README

- [Install](#install) — how to get it running on Mac or Windows
- [First launch](#first-launch) — the one-time model download
- [What to try first](#what-to-try-first) — a quick tour
- [Features](#features) — full list, with links to detailed docs
- [Testing this build](#testing-this-build) — what's verified, how to send feedback
- [Privacy](#privacy--what-leaves-your-device)
- [Building from source](#building-from-source) — for developers

---

## Install

### macOS

1. Download the `.dmg` for the latest release and open it, then drag **System Janitor** into Applications.
2. On first open, macOS will say it *"can't be opened because Apple cannot check it for malicious software."* This is expected — the app isn't notarized yet.
3. Right-click the app → **Open** → **Open**. You only need to do this once. (Alternative: System Settings → Privacy & Security → scroll down → **Open Anyway**.)

### Windows

1. Download the `.exe` installer for the latest release and run it (or download the `.zip`, unzip, and run the `.exe` inside).
2. Windows SmartScreen will likely show *"Windows protected your PC."* This is expected for a new, unsigned app.
3. Click **More info** → **Run anyway**.

### Minimum specs

| | Requirement |
|---|---|
| RAM | 8 GB+ recommended (falls back to a simpler rules-only mode below that) |
| Disk | ~3 GB free, for the local AI model |
| OS | macOS 12+ (Apple Silicon) or Windows 10/11 (64-bit) |

---

## First launch

On first run, the app downloads its local AI model (a few hundred MB to ~2 GB) — this needs an internet connection and a few minutes, with a progress indicator shown. After that, **everything runs offline**: your files, and everything the app learns from them, never leave your machine.

Point it at a real folder (Desktop or Downloads work well), or use the sample `test_folder` in this repo if you'd rather try dummy files first.

---

## What to try first

1. Pick a messy folder and let System Janitor organize it.
2. Hit `⌘K` (Mac) / `Ctrl+K` (Windows) to open the search palette; `⌘⇧K` / `Ctrl+Shift+K` opens chat, where you can ask questions about your files.
3. Open **Settings → "What this app knows about you"** to see what it has inferred — and erase it if anything feels off.
4. Try Smart Rename on a folder of inconsistently-named files.
5. Drop a file on the tray quick-drop window for instant filing without opening the main app.

See [docs/README.md](docs/README.md) for a full walkthrough of every feature.

---

## Features

| Feature | What it does | Docs |
|---|---|---|
| AI organize & classify | Reads file content (not just extension) — PDFs, Word docs, images via OCR — and files things into a sensible folder structure | [docs/features/organize-and-classify.md](docs/features/organize-and-classify.md) |
| Chronological filing | Extracts dates from document content to file things by date instead of just by type | same doc |
| Screenshot sweeper | Automatically cleans up loose screenshots | same doc |
| Search palette & chat | `⌘K` search + saved collections; `⌘⇧K` chat interface backed by the local model | [docs/features/search-and-chat.md](docs/features/search-and-chat.md) |
| Smart Rename | Batch, content-aware renaming across a folder | [docs/features/smart-rename.md](docs/features/smart-rename.md) |
| Renewal Radar | Scans documents for subscription/contract renewal dates and surfaces upcoming ones | [docs/features/renewal-radar.md](docs/features/renewal-radar.md) |
| Quiet-clean scheduler | Background organizing on a daily/weekly cadence, with a grace window | [docs/features/scheduler-and-tray.md](docs/features/scheduler-and-tray.md) |
| Tray & quick-drop | Persistent tray icon + drop window for instant filing | same doc |
| Encrypted Vault | AES-256-GCM encrypted local storage for sensitive files (never license-gated) | [docs/features/vault.md](docs/features/vault.md) |
| Insights & duplicate finder | Storage breakdown + exact-duplicate detection; duplicates are archived, never deleted, with one-step undo | [docs/features/insights-and-duplicates.md](docs/features/insights-and-duplicates.md) |
| Free trial & licensing | 300 free file moves, then a license key; device-bound, 7-day offline grace | [docs/features/trial-and-licensing.md](docs/features/trial-and-licensing.md) |

Every organizing operation is undoable, uses exclusive-create + SHA-256 verification before touching a file, and never overwrites a same-named file without renaming the incoming one instead.

---

## Testing this build

- **Automated suite:** 91/91 tests passing (`npm test`, Node's built-in test runner). Details: [docs/TESTING.md](docs/TESTING.md).
- **Edge cases:** collision handling, 255-character filenames, mismatched file extensions, huge zips, symlinks, and more — see [EDGE_CASES.md](EDGE_CASES.md) and [docs/TESTING.md](docs/TESTING.md).
- **Manual testing:** if you're testing a build by hand, see [docs/TESTING.md](docs/TESTING.md) for what to check and how to send feedback.

**Sending feedback:** open **Settings → Send feedback** in the app, type your note, and hit Send — it's saved locally to `feedback.json` in the app's data folder. Grab that file and send it over, or just message directly.

---

## Privacy — what leaves your device

This is a local-first app. The only times it talks to the internet:

- **First-run model download** (one time).
- **App update checks** (GitHub release feed).
- **Optional cloud connectors** (e.g. Google Drive) — only if you explicitly enable them.

Your files, their contents, and the profile the app builds about you are never uploaded. That profile is stored encrypted on your own machine and you can view or erase it anytime in Settings.

---

## Building from source

```bash
npm install
npm run dev          # run in development
npm test             # run the test suite
npm run build:mac    # build a macOS package
npm run build:win    # build a Windows package
```

Note: macOS builds are currently unsigned (no Apple developer certificate yet), so auto-update silently fails on Mac and Gatekeeper shows the "unidentified developer" warning described above. See [DEPLOY.md](DEPLOY.md) for the remaining steps to go fully live (payment link, license enforcement migration, etc.).
