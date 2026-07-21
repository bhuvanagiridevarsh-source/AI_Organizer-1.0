# Organize & Classify

The core feature. System Janitor reads what's actually inside your files — not just the filename or extension — and files them into a sensible folder structure, entirely on-device.

- **Content-aware:** parses PDFs and Word docs (`mammoth`), and runs OCR (Tesseract) on images/screenshots, so a scanned receipt saved as `IMG_4821.jpg` still gets classified as a receipt.
- **Chronological filing:** if enabled in Settings, dates found inside a document (not just its file-modified date) are used to file it by date.
- **Screenshot sweeper:** automatically finds and tidies up loose screenshots cluttering the Desktop or Downloads.

## Workflow

![Organize & Classify workflow](../diagrams/organize-and-classify.svg)

1. Pick a folder to organize (Desktop, Downloads, or any folder you point it at).
2. The app reads file contents where it can — text extraction, OCR, PDF/Word parsing.
3. The local model classifies each file and drafts a folder plan.
4. You review the plan before anything moves.
5. Files are moved into the new structure — by date, if chronological filing is on.
6. Not happy with the result? Undo from the Undo log — every move is reversible.

## Notes for testers

- Try a folder with mixed content: PDFs, screenshots, Word docs, and a few files with misleading names/extensions (see [EDGE_CASES.md](../../EDGE_CASES.md) for specific scenarios like a `.pdf` that's actually a PNG).
- Two files with the same name landing in the same destination should never overwrite each other — check that both survive with distinct names.
- Nothing should ever be deleted by this flow; worst case, a file lands somewhere unexpected and can be undone.
