# Insights & Duplicate Finder

A dashboard showing what's taking up space, plus an exact-duplicate finder that never deletes anything outright.

## Workflow

![Insights & Duplicate Finder workflow](../diagrams/insights-and-duplicates.svg)

1. Open the Insights dashboard.
2. See a storage breakdown by category (documents, images, archives, etc.).
3. The duplicate finder scans for exact-content matches (hash-based — not "similar," but byte-identical).
4. Duplicates are archived into a `_Duplicates` folder — the original location is never left with a silently deleted file.
5. One-step undo restores everything if a duplicate pass gets something wrong.

## Notes for testers

- Duplicates are matched by content hash, so a renamed copy of the same file should still be caught; a similar-but-not-identical file should not be.
- Confirm nothing is ever permanently deleted — everything flagged as a duplicate should be recoverable from `_Duplicates` or via undo.
