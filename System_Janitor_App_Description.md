# System Janitor — App Description (v1.1.0, July 2026)

## What it is
System Janitor is an Electron desktop app that organizes a user's files using a local LLM — no cloud AI calls required. Target user: non-technical professionals with messy folders (Desktop, Downloads, etc.).

## Core functionality
- **AI file classification & organization** — scans folders, classifies files by content (not just extension), and files them into an organized structure. Uses a local llama.cpp model (`node-llama-cpp`) plus Ollama integration, with OCR (Tesseract) and document parsing (PDF, Word via `mammoth`) to read file contents.
- **Smart Rename** — batch, content-aware file renaming.
- **Chronological filing** — extracts dates from file content to file documents by date (`DateExtractService`).
- **Screenshot sweeper** — cleans up loose screenshots automatically.
- **Renewal Radar** — regex-based detection of subscription/contract renewal dates in documents, surfaces upcoming obligations.
- **Quiet-clean scheduler** — background organizing on a daily/weekly cadence with a grace window.
- **Tray + quick-drop window** — lets users drag files onto a persistent tray/quick-drop UI for instant filing.
- **Encrypted Vault** — AES-256-GCM encrypted storage for sensitive files (not license-gated).
- **Insights dashboard + duplicate finder** — surfaces storage stats and exact-duplicate files; duplicates are archived to `_Duplicates` (never deleted), with a single-step undo.
- **Search & chat** — a ⌘K command palette for search/collections and a ⌘⇧K chat interface (LLM-backed) for asking about files.
- **Cloud connectors** — Google Drive integration and a general cloud sync/connector service.

## Architecture
- Electron app: `src/main` (Node/Electron backend, ~35 services) and `src/renderer` (vanilla JS UI — a React redesign prototype exists in `UI_Redesign_v2` but is intentionally not wired in).
- Local intelligence stack: embeddings, clustering, knowledge graph, and a "concept pool" system that groups files by learned concepts, with background learning from user corrections (`BackgroundLearnerService`, `LearningService`).
- Safety: file moves use exclusive-create + SHA-256 verification, undo log for reversible operations, 255-byte filename truncation guard.
- Test suite: 91 Node test-runner tests (`node --test test/*.test.js`).

## Monetization (built, not fully live)
- 300-file free trial, then paywall.
- Licenses are device-bound (max 2 devices), backed by a Vercel/Supabase/Stripe/Resend backend (`backend-two-mu-53.vercel.app`), 7-day offline grace period.
- Not yet live: device-limit enforcement is fail-open until a Supabase migration runs, `TESTING_MODE=true` still bypasses paywall, and no Stripe payment link is created yet.

## Known constraints
- macOS builds are unsigned (no Apple developer cert), so auto-update silently fails on Mac.
- Remaining launch steps before going live: run the Supabase `license_devices` migration, create the Stripe payment link, and flip `TESTING_MODE` to `false` (tracked in `DEPLOY.md`).
