# System Janitor — Tester Guide

Thanks for testing System Janitor. It's a private AI assistant that runs **entirely on your computer**, learns what you work on from your own files, and uses that to make the AI tools you already use give you better, more relevant results.

---

## Install

### macOS
1. Download the `.dmg` and open it, then drag **System Janitor** to Applications.
2. The first time you open it, macOS will say the app *"can't be opened because Apple cannot check it for malicious software"* (the app isn't notarized yet during testing).
3. **Right-click the app → Open → Open.** You only have to do this once. (Or: System Settings → Privacy & Security → scroll down → "Open Anyway".)

### Windows
1. Download the `.exe` installer (or the `.zip`, unzip, run the `.exe`).
2. Windows SmartScreen may show *"Windows protected your PC."* This is expected for a new, unsigned app.
3. Click **More info → Run anyway.**

---

## First launch (important)
- On first run the app downloads its AI model (a few hundred MB to ~2 GB). **This needs an internet connection and a few minutes.** A progress indicator will show.
- After that, **everything runs offline on your machine** — your files and what the app learns never leave your device.
- Give it a folder of real files to organize so it has something to learn from. There's a `test_folder` in the repo if you'd rather try sample files first.

## Minimum specs
- **RAM:** 8 GB or more recommended. On low-RAM machines the AI falls back to a simpler rules-only mode.
- **Disk:** ~3 GB free for the model.
- macOS 12+ (Apple Silicon) or Windows 10/11 (64-bit).

---

## What to try
1. Point it at a messy folder and let it organize.
2. Open the prompt enhancer, type a rough prompt (e.g. *"write an update for my team"*) and see if the improved version reflects what you actually do.
3. Open **Settings → "What this app knows about you"** to see what it inferred — and erase it if anything feels off.

## Sending feedback
Open **Settings → Send feedback**, type, and hit Send. Notes are saved locally to a `feedback.json` in the app's data folder — grab that file and send it to me, or just message me directly.

---

## Privacy — what leaves your device
This is a local-first app. The only times it talks to the internet are:
- **First-run model download** (one time).
- **App updates** (checks the GitHub release feed).
- **Optional cloud connectors** (e.g. Google Drive) — only if *you* explicitly enable them.

Your files, the text inside them, and the profile the app builds about you are **never uploaded**. The profile is stored encrypted on your own machine and you can view or erase it anytime in Settings.
