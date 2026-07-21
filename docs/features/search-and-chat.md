# Search & Chat

A fast way to find and ask about your own files without leaving the keyboard.

- **`⌘K` (Mac) / `Ctrl+K` (Windows):** command palette for searching files and jumping to saved collections.
- **`⌘⇧K` (Mac) / `Ctrl+Shift+K` (Windows):** opens chat — ask questions about your files in plain language, answered by the local model using an index of your content.
- **Collections:** save a search or a set of files as a named collection you can return to.

## Workflow

![Search & Chat workflow](../diagrams/search-and-chat.svg)

1. Press `⌘K` to open the search palette from anywhere in the app.
2. Type to search across filenames and indexed content, or open a saved collection.
3. Press `⌘⇧K` to switch to chat instead.
4. Ask a question about your files — e.g. "which invoices are from last quarter?"
5. The local model answers using your indexed files. Nothing is sent to the cloud to generate the answer.

## Notes for testers

- Search should return results by content match, not just filename match (e.g. searching a phrase that appears inside a PDF should surface that PDF).
- Chat answers should stay grounded in your actual files — flag anything that looks like a hallucinated file or fact.
