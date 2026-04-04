#!/bin/bash
# Install System Janitor
# Double-click this file to install the app on macOS 26+.

APP_NAME="System Janitor"
APP_SRC="$(dirname "$0")/${APP_NAME}.app"
APP_DEST="/Applications/${APP_NAME}.app"

echo "================================================"
echo "  Installing ${APP_NAME}..."
echo "================================================"
echo ""

# Copy app to /Applications
# Use 'ditto' instead of 'cp -R' to correctly preserve macOS framework
# symlink chains (Versions/Current -> A) that cp -R can silently break.
echo "📂 Copying to Applications folder..."
ditto "${APP_SRC}" "${APP_DEST}" 2>/dev/null || {
  # If permission denied, try with sudo prompt
  sudo ditto "${APP_SRC}" "${APP_DEST}"
}
echo "   ✓ Copied"

# Remove quarantine flag (macOS adds this to all downloaded files)
echo "🔓 Removing macOS security quarantine..."
xattr -cr "${APP_DEST}"
echo "   ✓ Done"

# Ad-hoc sign the app so macOS 26 allows frameworks to load.
# We must include the entitlements inline — without disable-library-validation,
# macOS 26 will refuse to load the Electron Framework and crash on launch.
echo "🔏 Applying security signature..."
TEMP_ENT="$(mktemp /tmp/sj-entitlements.XXXXXX.plist)"
cat > "${TEMP_ENT}" << 'ENTEOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
</dict>
</plist>
ENTEOF
codesign --force --deep --sign "Apple Development: adventureb@icloud.com (UAY5K7JZX3)" --entitlements "${TEMP_ENT}" "${APP_DEST}" 2>/dev/null || \
  codesign --force --deep --sign - --entitlements "${TEMP_ENT}" "${APP_DEST}" 2>/dev/null
rm -f "${TEMP_ENT}"
echo "   ✓ Signed (with library validation disabled)"

echo ""
echo "✅ Installation complete! Opening ${APP_NAME}..."
echo ""
open "${APP_DEST}"
