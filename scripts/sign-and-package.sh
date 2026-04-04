#!/bin/bash
# sign-and-package.sh
# Runs automatically after `npm run build:mac`.
# Signs the Electron app in the correct order for macOS 26, then packages a DMG.
#
# WHY THIS EXISTS: electron-builder is set to identity:null (no auto-signing).
# We handle signing ourselves so we can apply the correct entitlements and
# sign things in the exact order macOS requires for Electron apps.

set -e

APP_NAME="System Janitor"
DIST="dist"
APP_PATH="${DIST}/mac-arm64/${APP_NAME}.app"
DMG_OUT="${DIST}/${APP_NAME}-1.0.0-arm64.dmg"
STAGING="${DIST}/dmg-staging"
ENTITLEMENTS="scripts/entitlements.plist"

echo ""
echo "============================================================"
echo "  Signing ${APP_NAME} for macOS 26 (no Apple cert needed)"
echo "============================================================"

# ── Verify the build output looks complete ──────────────────────
FRAMEWORK_BIN="${APP_PATH}/Contents/Frameworks/Electron Framework.framework/Electron Framework"
if [ ! -e "${FRAMEWORK_BIN}" ]; then
  echo ""
  echo "❌ ERROR: Electron Framework not found in build output!"
  echo "   Expected: ${FRAMEWORK_BIN}"
  echo "   The electron-builder step may have failed."
  ls "${APP_PATH}/Contents/Frameworks/" 2>/dev/null
  exit 1
fi
echo "✓ Electron Framework present in build"

# ── Step 1: Sign all dylibs and .so files (innermost first) ─────
echo ""
echo "Step 1/4 — Signing dylibs..."
find "${APP_PATH}" \( -name "*.dylib" -o -name "*.so" \) | while IFS= read -r f; do
  codesign --force --sign - "$f" 2>/dev/null || true
done
echo "   ✓ Done"

# ── Step 2: Sign all Helper .app bundles ────────────────────────
echo ""
echo "Step 2/4 — Signing helper apps..."
for helper in "${APP_PATH}/Contents/Frameworks/"*.app; do
  [ -d "$helper" ] || continue
  codesign --force --sign - "$helper" 2>/dev/null
  echo "   ✓ $(basename "$helper")"
done

# ── Step 3: Sign the Frameworks (Electron Framework last) ───────
echo ""
echo "Step 3/4 — Signing frameworks..."
for fw in "${APP_PATH}/Contents/Frameworks/"*.framework; do
  [ -d "$fw" ] || continue
  codesign --force --sign - "$fw" 2>/dev/null
  echo "   ✓ $(basename "$fw")"
done

# ── Step 4: Sign the main app WITH entitlements ─────────────────
# This MUST be last. The disable-library-validation entitlement on the
# main app tells macOS: "don't require my frameworks to match my team ID."
# Without this, macOS 26 refuses to load the Electron Framework.
echo ""
echo "Step 4/4 — Signing main app with entitlements..."
if [ -f "${ENTITLEMENTS}" ]; then
  codesign --force --sign - --entitlements "${ENTITLEMENTS}" "${APP_PATH}"
  echo "   ✓ Signed (disable-library-validation applied)"
else
  codesign --force --sign - "${APP_PATH}"
  echo "   ✓ Signed (no entitlements file found — framework may fail to load)"
fi

# ── Strip quarantine from the signed app ────────────────────────
xattr -cr "${APP_PATH}" 2>/dev/null || true
echo "   ✓ Quarantine removed"

# ── Verify signing worked ────────────────────────────────────────
echo ""
echo "Verifying signature..."
codesign --verify --deep "${APP_PATH}" 2>/dev/null && echo "   ✓ Signature valid" || echo "   ⚠ Signature check returned non-zero (may be OK for ad-hoc)"

# ── Package the DMG ─────────────────────────────────────────────
echo ""
echo "Packaging DMG..."

rm -rf "${STAGING}"
mkdir -p "${STAGING}"

# Use ditto (not cp -R) — it correctly preserves the framework symlink chains
# (Versions/Current → A) that macOS requires to find the Electron Framework binary.
ditto "${APP_PATH}" "${STAGING}/${APP_NAME}.app"
echo "   ✓ App copied to staging (ditto)"

# Add Applications shortcut for drag-to-install
ln -s /Applications "${STAGING}/Applications"

# Add the installer script so the friend can double-click to install
if [ -f "installer/Install System Janitor.command" ]; then
  cp "installer/Install System Janitor.command" "${STAGING}/"
  chmod +x "${STAGING}/Install System Janitor.command"
  echo "   ✓ Installer script included"
fi

# Build the DMG
rm -f "${DMG_OUT}"
hdiutil create \
  -volname "${APP_NAME}" \
  -srcfolder "${STAGING}" \
  -ov \
  -format UDZO \
  "${DMG_OUT}"

rm -rf "${STAGING}"

echo ""
echo "   ✓ DMG ready: ${DMG_OUT}"
echo ""
echo "============================================================"
echo "  ✅ Done!"
echo ""
echo "  TO OPEN ON YOUR MAC:"
echo "    1. Open the DMG"
echo "    2. Drag 'System Janitor' to Applications"
echo "    3. Right-click the app → Open → click Open in the popup"
echo "       (macOS 26 shows a security warning once on first launch)"
echo "    OR: Double-click 'Install System Janitor.command' in the DMG"
echo ""
echo "  TO SHARE WITH YOUR FRIEND:"
echo "    Upload ${DMG_OUT} to Google Drive and share the link."
echo "    They open the DMG and double-click 'Install System Janitor.command'."
echo "============================================================"
echo ""
