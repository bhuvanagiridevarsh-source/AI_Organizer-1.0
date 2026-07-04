# System Janitor — Edge Case Test Scenarios

Setup: `./create-edge-cases.sh --target ./edge_case_tests`
Cleanup: `./create-edge-cases.sh --target ./edge_case_tests --clean`

Run `snapshot.js` before and `validate.js` after each scenario. The external bait file (`edge_case_tests_external/external_secret.txt`) must be byte-identical and untouched after every run.

---

## 1. Case collision — `Invoice.pdf` vs `invoice.pdf`

**Setup:** Both names in one folder (survives only on case-sensitive filesystems), plus a cross-folder variant (`from_email/Invoice.pdf`, `from_downloads/invoice.pdf`) that triggers the collision at move time on any filesystem. The two files have different content.

**Correct behavior:** Both files survive with both contents intact. When moving both into the same destination, the organizer must detect the collision (case-insensitively on macOS/Windows) and rename one, e.g. `invoice (2).pdf`.

**Naive failure:** Checks existence with an exact-case string compare, concludes "no conflict," and the second move silently overwrites the first — data loss with no error.

**Check after:** Both content hashes exist in the after state (`validate.js` reports 0 lost). Two distinct files exist at the destination.

## 2. Destination folder "Photos" already exists

**Setup:** `Photos/` exists containing `beach.jpg` and a user-placed `notes about photos.txt`; loose `IMG_*.jpg` files in root, plus a root `beach.jpg` with *different* content than `Photos/beach.jpg`.

**Correct behavior:** Reuse the existing folder, merge into it, leave the pre-existing files alone. The incoming `beach.jpg` collides with existing content → rename, don't overwrite. `notes about photos.txt` stays where the user put it (or is moved with clear logging — never deleted).

**Naive failure:** `mkdir` fails (EEXIST) and the app crashes; or it creates `Photos (2)/` splitting photos across two folders; or the incoming `beach.jpg` overwrites the pre-existing one.

**Check after:** Exactly one `Photos` folder. Both `beach.jpg` hashes present. `notes about photos.txt` hash present.

## 3. 255-character filename

**Setup:** One file at exactly 255 bytes (the max on APFS/ext4/NTFS), one at 240 bytes.

**Correct behavior:** Both files move fine as-is. If the organizer renames files by *adding* anything (date prefix, category tag), it must truncate the base name to keep the result ≤255 bytes, preserving the extension.

**Naive failure:** `ENAMETOOLONG` on the rename → unhandled exception, or worse: the copy fails *after* the original was queued for deletion. Path-length limits (Windows 260-char `MAX_PATH`) also break when moving into a nested category folder.

**Check after:** Both hashes present; no crash mid-run (partial state = some files moved, some not, no log).

## 4. Wrong extension — `.pdf` that is actually a PNG

**Setup:** `scan_of_receipt.pdf` (PNG magic bytes), `vacation_photo.jpg` (PDF magic bytes), `document.docx.txt` (zip magic — real docx signature).

**Correct behavior:** Defensible either way — classify by extension *or* by content sniffing — but it must be consistent, documented, and must never corrupt the file. Best-in-class: detect the mismatch and flag it to the user. An AI organizer that reads content to categorize must not crash when the parser fails (PDF library choking on PNG bytes).

**Naive failure:** Content-based categorizer throws on parse failure and aborts the whole run; or it "helpfully" rewrites the extension, breaking the user's references to the file.

**Check after:** Hashes unchanged (content never modified). File landed *somewhere* reasonable; run completed.

## 5. Zip containing 10,000 files

**Setup:** `massive_archive.zip`, 10,000 entries across 50 internal folders.

**Correct behavior:** Treat the zip as a single opaque file and move it to Archives. If the app inspects zip contents for classification, it must cap how many entries it reads and never auto-extract.

**Naive failure:** Auto-extracts to "organize the contents" → 10,000 files explode into the tree; or reads all entries into memory for AI classification → multi-minute hang / OOM on one file.

**Check after:** Zip hash unchanged, still exactly one file, no extracted residue, run time didn't blow up.

## 6. Symlink pointing outside the target folder

**Setup:** `looks_like_a_normal_file.txt` → external file, `looks_like_a_folder` → external directory, `dangling_link.pdf` → nonexistent path.

**Correct behavior:** Never follow symlinks out of the target. Move/skip the *link itself* (or leave links in place, logged). The external target file must remain untouched. Dangling link must not crash the scanner.

**Naive failure:** `stat()` follows the link — organizer reads, classifies, and *moves the external file* (data theft/loss outside its sandbox); recursion follows the dir link and organizes the external folder; `fs.statSync` on the dangling link throws ENOENT and kills the run.

**Check after:** `external_secret.txt` untouched (hash + mtime identical). Links still exist as links (`ls -la` shows `->`). No files from the external dir moved.

## 7. File locked / open in another app

**Setup:** `currently_editing.docx` made immutable via `chflags uchg` on macOS (background fd-holder on Linux). For a true Windows-style mandatory lock, open a file in Word manually before the run.

**Correct behavior:** Move fails → catch the error, skip the file, log it, continue with the rest of the folder. Report "1 file skipped (in use)" to the user.

**Naive failure:** Unhandled EPERM crashes the run halfway, leaving the folder half-organized; or a copy-then-delete implementation copies the file but fails the delete, silently creating a duplicate.

**Check after:** Rest of the folder got organized (crash = fail). Locked file: either in place or cleanly moved — but not duplicated. `validate.js` shows no unexpected duplicates.

## 8. 10,000 files flat in root

**Setup:** `08_ten_thousand_root/` with 10,000 empty files. (All-identical hashes — doubles as a mass-duplicate-detection stress test.)

**Correct behavior:** Completes in reasonable time with bounded memory; UI stays responsive (Electron: work off the main process); progress reporting; batched or streamed directory reads.

**Naive failure:** `readdirSync` + per-file sync stat + AI classification call *per file* → hours-long freeze, renderer-process lockup, or one API rate-limit error aborting at file 4,000 with no resume. Dedup logic doing O(n²) pairwise compares on 10k identical files.

**Check after:** All 10,000 accounted for by the validator, run time acceptable, memory flat, and if interrupted — a resumable/consistent state rather than a half-moved mess.

## 9. Emoji and unicode filenames

**Setup:** `🎉 party.pdf`, CJK + emoji, Arabic (RTL), Cyrillic, an NFC/NFD `café.pdf` pair (visually identical, different bytes), and a filename containing a zero-width space.

**Correct behavior:** Names preserved byte-for-byte through the move. NFC/NFD treated as the collision hazard it is on macOS (HFS+/APFS normalize — the two cafés may collide at the destination → rename, don't overwrite). String operations (truncation from scenario 3!) must not split surrogate pairs — `'🎉'.length === 2` in JavaScript.

**Naive failure:** Filename used in a shell command without escaping → command fails or injects; truncating at a byte/UTF-16 boundary corrupts the emoji producing an invalid name; NFC/NFD collision silently overwrites; the zero-width-space name is "identical" to a clean name in the UI, confusing dedupe-by-name logic.

**Check after:** Every unicode hash present, filenames unchanged (compare byte sequences, not rendered strings), both café contents survived.

## 10. File with no read permissions

**Setup:** `unreadable_contract.pdf` (chmod 000), a readable sibling, and `no_entry_folder/` (chmod 000) containing a trapped file.

**Correct behavior:** Can't hash/classify it → skip with a logged warning, continue. Never chmod the user's files to force access. The unreadable *folder* must not kill the recursive scan.

**Naive failure:** `EACCES` on `readFile` is unhandled → crash; or the app runs `chmod`/asks for elevation to "fix" it (silently changing security posture); a move that succeeds (rename needs only dir perms!) but then a content-verify step fails and the app "rolls back" incorrectly, losing track of the file.

**Check after:** Run completed; readable sibling organized; unreadable file still exists with `000` perms unchanged; skip surfaced in the app's report.

---

## Universal post-run checklist

1. `node validate.js --before before.json --after ./edge_case_tests` → 0 lost, no unexpected duplicates.
2. External bait file untouched.
3. The app produced a log/report mentioning every skipped file — silent skips are bugs too.
4. Re-running the organizer on its own output is a no-op (idempotence).
