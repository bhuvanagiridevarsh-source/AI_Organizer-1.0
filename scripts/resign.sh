#!/bin/bash
# resign.sh — Manually re-sign the built app with your Apple Development certificate.
#
# Run this from the project root AFTER npm run build:mac if the build
# fell back to ad-hoc signing due to keychain access issues:
#
#   bash scripts/resign.sh
#
# This works because interactive terminal sessions have full keychain access,
# unlike child processes spawned by the build script.

set -e

CERT="Apple Development: adventureb@icloud.com (UAY5K7JZX3)"
APP_NAME="System-Janitor"
APP_PATH="dist/mac-arm64/${APP_NAME}.app"
ENTITLEMENTS="scripts/entitlements.plist"
ZIP_OUT="dist/System Janitor-distributable.zip"

if [ ! -d "${APP_PATH}" ]; then
  echo "❌ App not found at ${APP_PATH}"
  echo "   Run 'npm run build:mac' first"
  exit 1
fi

echo "🔏 Re-signing ${APP_PATH} with real Apple Development certificate..."
echo ""

# Step 1: dylibs
echo "   Step 1/4 — Signing dylibs..."
find "${APP_PATH}" \( -name "*.dylib" -o -name "*.so" \) -exec \
  codesign --force --sign "${CERT}" {} \;

# Step 2: Helper apps
echo "   Step 2/4 — Signing helpers..."
FRAMEWORKS="${APP_PATH}/Contents/Frameworks"
for item in "${FRAMEWORKS}"/*.app; do
  [ -d "$item" ] && codesign --force --sign "${CERT}" --options runtime \
    --entitlements "${ENTITLEMENTS}" "$item"
done

# Step 3: Frameworks
echo "   Step 3/4 — Signing frameworks..."
for item in "${FRAMEWORKS}"/*.framework; do
  [ -d "$item" ] && codesign --force --sign "${CERT}" "$item"
done

# Step 4: Main app
echo "   Step 4/4 — Signing main app..."
codesign --force --sign "${CERT}" --options runtime \
  --entitlements "${ENTITLEMENTS}" "${APP_PATH}"

echo ""
echo "✅ Re-signed successfully!"
echo ""

# Verify
echo "🔍 Verifying signature..."
codesign --verify --deep --strict --verbose=2 "${APP_PATH}" 2>&1 | tail -5
echo ""

# Recreate distribution ZIP with the newly signed app
echo "📦 Creating distribution ZIP..."
[ -f "${ZIP_OUT}" ] && rm "${ZIP_OUT}"
ditto -c -k --sequesterRsrc --keepParent "${APP_PATH}" "${ZIP_OUT}"
echo "   ✓ ZIP ready: ${ZIP_OUT}"
echo "   Share this ZIP with your friend — it preserves all macOS framework symlinks."
echo ""
