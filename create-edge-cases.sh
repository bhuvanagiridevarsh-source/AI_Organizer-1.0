#!/usr/bin/env bash
#
# create-edge-cases.sh — build 10 edge-case scenarios that break naive file organizers.
# See EDGE_CASES.md for expected behavior, naive failure modes, and post-run checks.
#
# Usage:
#   ./create-edge-cases.sh --target ./edge_case_tests
#   ./create-edge-cases.sh --target ./edge_case_tests --clean   # restore perms & delete
#
set -euo pipefail

TARGET="./edge_case_tests"
CLEAN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --clean)  CLEAN=1; shift ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done
TARGET="$(cd "$(dirname "$TARGET")" 2>/dev/null && pwd)/$(basename "$TARGET")" || TARGET="$PWD/$TARGET"
EXTERNAL="${TARGET}_external"   # sibling dir, outside the organizer's reach

# ---------- cleanup mode ----------
if [[ $CLEAN -eq 1 ]]; then
  echo "Cleaning up $TARGET ..."
  # undo immutability / permissions before delete
  if [[ "$(uname)" == "Darwin" ]]; then
    chflags -R nouchg "$TARGET" 2>/dev/null || true
  fi
  chmod -R u+rwX "$TARGET" 2>/dev/null || true
  rm -rf "$TARGET" "$EXTERNAL"
  echo "Done."
  exit 0
fi

mkdir -p "$TARGET"
cd "$TARGET"
echo "Building edge cases in: $TARGET"

# ============================================================
# 1. Case collision: Invoice.pdf vs invoice.pdf
# ============================================================
mkdir -p 01_case_collision
echo "UPPERCASE invoice content" > "01_case_collision/Invoice.pdf"
echo "lowercase invoice content" > "01_case_collision/invoice.pdf"
n=$(ls -1 01_case_collision | wc -l | tr -d ' ')
if [[ "$n" -lt 2 ]]; then
  echo "  [1] NOTE: filesystem is case-insensitive — second write overwrote the first."
  echo "      Using the cross-folder variant instead (collision happens on MOVE)."
fi
# Cross-folder variant: works on ANY filesystem. Organizer will try to move
# both into the same destination (e.g. Invoices/) → name collision at merge time.
mkdir -p 01_case_collision/from_email 01_case_collision/from_downloads
echo "invoice from email - different content"     > "01_case_collision/from_email/Invoice.pdf"
echo "invoice from downloads - different content" > "01_case_collision/from_downloads/invoice.pdf"

# ============================================================
# 2. Destination folder already exists ("Photos")
# ============================================================
mkdir -p "02_existing_photos/Photos"
echo "pre-existing vacation photo" > "02_existing_photos/Photos/beach.jpg"
echo "a text file the user manually put in Photos" > "02_existing_photos/Photos/notes about photos.txt"
# loose photos in root that the organizer will want to move INTO Photos/
echo "loose photo 1" > "02_existing_photos/IMG_0001.jpg"
echo "loose photo 2" > "02_existing_photos/IMG_0002.jpg"
# and a name that collides with existing content
echo "DIFFERENT beach photo, same name" > "02_existing_photos/beach.jpg"

# ============================================================
# 3. 255-character filename (max on most filesystems)
# ============================================================
mkdir -p 03_max_filename
LONG_BASE=$(printf 'a%.0s' $(seq 1 251))          # 251 chars + ".pdf" = 255 bytes
echo "max length filename content" > "03_max_filename/${LONG_BASE}.pdf"
# 240 chars: fits now, but breaks if organizer PREPENDS anything (date, category)
LONG_240=$(printf 'b%.0s' $(seq 1 236))
echo "near-max filename content" > "03_max_filename/${LONG_240}.pdf"

# ============================================================
# 4. Wrong extension: .pdf that is actually a PNG (and reverse)
# ============================================================
mkdir -p 04_wrong_extension
printf '\x89PNG\r\n\x1a\n' > "04_wrong_extension/scan_of_receipt.pdf"   # PNG magic bytes
head -c 2000 /dev/urandom >> "04_wrong_extension/scan_of_receipt.pdf"
printf '%%PDF-1.4\n' > "04_wrong_extension/vacation_photo.jpg"          # PDF magic bytes
head -c 2000 /dev/urandom >> "04_wrong_extension/vacation_photo.jpg"
printf 'PK\x03\x04' > "04_wrong_extension/document.docx.txt"            # zip magic (docx is a zip)
head -c 500 /dev/urandom >> "04_wrong_extension/document.docx.txt"

# ============================================================
# 5. Zip containing 10,000 files
# ============================================================
mkdir -p 05_huge_zip
if command -v python3 >/dev/null 2>&1; then
  python3 - "$TARGET/05_huge_zip/massive_archive.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    for i in range(10000):
        z.writestr(f"folder_{i%50}/file_{i:05d}.txt", f"content {i}")
print("  [5] massive_archive.zip: 10,000 entries")
PY
else
  echo "  [5] SKIPPED: python3 not found (needed to build the 10k-entry zip)"
fi

# ============================================================
# 6. Symlinks escaping the target folder (+ dangling link)
# ============================================================
mkdir -p 06_symlink_escape "$EXTERNAL"
echo "SECRET: this file lives OUTSIDE the target folder" > "$EXTERNAL/external_secret.txt"
ln -sf "$EXTERNAL/external_secret.txt" "06_symlink_escape/looks_like_a_normal_file.txt"
ln -sf "$EXTERNAL" "06_symlink_escape/looks_like_a_folder"
ln -sf "/nonexistent/path/ghost.pdf" "06_symlink_escape/dangling_link.pdf"

# ============================================================
# 7. Locked / in-use file
# ============================================================
mkdir -p 07_locked_file
echo "this file is open in another app" > "07_locked_file/currently_editing.docx"
if [[ "$(uname)" == "Darwin" ]]; then
  chflags uchg "07_locked_file/currently_editing.docx"
  echo "  [7] currently_editing.docx made immutable (chflags uchg) — mimics a locked file."
  echo "      Unlock later with: chflags nouchg '.../currently_editing.docx' (or use --clean)"
else
  # Linux: hold an open file descriptor in the background (advisory).
  # Fully detached so it doesn't tie up the parent shell's stdout.
  nohup bash -c "exec 3<>'$TARGET/07_locked_file/currently_editing.docx'; sleep 600" >/dev/null 2>&1 &
  disown
  echo "  [7] background process $! holding the file open for 10 min (advisory on Linux)."
  echo "      For a true Windows-style mandatory lock, open the file in Word/Preview manually."
fi

# ============================================================
# 8. 10,000 files flat in one folder
# ============================================================
mkdir -p 08_ten_thousand_root
( cd 08_ten_thousand_root && seq -f 'file_%05g.txt' 1 10000 | xargs touch )
# empty files = 10,000 identical content hashes — doubles as a mass-duplicate test
echo "  [8] 10,000 empty files created (also stress-tests duplicate detection)."

# ============================================================
# 9. Emoji + unicode filenames
# ============================================================
mkdir -p 09_unicode_names
echo "party invoice"        > "09_unicode_names/🎉 party.pdf"
echo "chart deck"           > "09_unicode_names/📊 Q3 report 🚀.pptx"
echo "family photo"         > "09_unicode_names/家族写真 🏠.jpg"
echo "arabic doc"           > "09_unicode_names/تقرير نهائي.docx"
echo "russian sheet"        > "09_unicode_names/бюджет 2025.xlsx"
# NFC vs NFD: visually identical "café.pdf", different byte sequences.
# On macOS (NFD-normalizing) these may collapse into one file — that's part of the test.
printf 'nfc version' > "$(printf '09_unicode_names/caf\xc3\xa9.pdf')"          # é as U+00E9 (NFC)
printf 'nfd version' > "$(printf '09_unicode_names/cafe\xcc\x81.pdf')"         # e + U+0301 (NFD)
# zero-width space hiding in a name
printf 'sneaky' > "$(printf '09_unicode_names/report\xe2\x80\x8bfinal.docx')"

# ============================================================
# 10. File with no read permissions
# ============================================================
mkdir -p 10_no_read_permission
echo "you cannot read me" > "10_no_read_permission/unreadable_contract.pdf"
chmod 000 "10_no_read_permission/unreadable_contract.pdf"
echo "readable sibling" > "10_no_read_permission/readable_memo.pdf"
# bonus: a directory the organizer can't descend into
mkdir -p "10_no_read_permission/no_entry_folder"
echo "trapped file" > "10_no_read_permission/no_entry_folder/trapped.txt"
chmod 000 "10_no_read_permission/no_entry_folder"

# ============================================================
echo ""
echo "Done. Structure:"
# find without descending into the chmod-000 folder
find . -maxdepth 2 -not -path './08_ten_thousand_root/*' 2>/dev/null | sort | head -50
echo "  (plus 10,000 files in 08_ten_thousand_root/)"
echo ""
echo "External bait file (must NOT be touched by the organizer): $EXTERNAL/external_secret.txt"
echo "Cleanup: $0 --target '$TARGET' --clean"
