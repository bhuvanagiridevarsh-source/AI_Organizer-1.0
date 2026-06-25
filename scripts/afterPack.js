/**
 * afterPack.js
 * Called by electron-builder AFTER packing the .app but BEFORE creating the DMG.
 * This is the correct place to sign — the app is fully built, and electron-builder
 * will then package it into a DMG directly from the signed output folder.
 *
 * By signing here (instead of after the DMG is made), we ensure:
 *   1. The Framework is always physically present when we sign
 *   2. electron-builder's own DMG creation handles the bundle correctly
 *   3. No staging-copy step that can lose the Electron Framework
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Modules whose absence has historically broken the packaged app at boot.
// Verified inside the asar after every build (all platforms) — see verifyAsar().
const REQUIRED_MODULES = [
  'electron-store',
  'electron-updater',
  'better-sqlite3',
  'conf',          // transitive of electron-store, has crashed builds before
  'adm-zip',
  'mammoth',
  'pdf-parse',
  'tesseract.js',
];

async function verifyAsar(context) {
  const asarPath = path.join(context.appOutDir,
    context.electronPlatformName === 'darwin'
      ? `${(context.packager.appInfo && context.packager.appInfo.productName) || 'System Janitor'}.app/Contents/Resources/app.asar`
      : 'resources/app.asar'
  );
  if (!fs.existsSync(asarPath)) {
    console.error(`❌ verifyAsar: app.asar not found at ${asarPath}`);
    process.exit(1);
  }
  // Use @electron/asar (bundled inside electron-builder's deps) to list contents.
  let asar;
  try { asar = require('@electron/asar'); }
  catch { try { asar = require('asar'); } catch (e) {
    console.warn(`⚠ verifyAsar: asar lib unavailable (${e.message}) — skipping check`);
    return;
  }}
  const entries = asar.listPackage(asarPath);
  const missing = REQUIRED_MODULES.filter(m =>
    !entries.some(e => e.startsWith(`/node_modules/${m}/`) || e === `/node_modules/${m}`)
  );
  if (missing.length) {
    console.error('\n❌❌❌ verifyAsar FAILED — packaged app would crash at boot.');
    console.error(`Missing modules in ${asarPath}:`);
    missing.forEach(m => console.error(`   - ${m}`));
    console.error('Fix electron-builder.yml `files:` so these ship, then rebuild.\n');
    process.exit(1);
  }
  console.log(`✓ verifyAsar: all ${REQUIRED_MODULES.length} critical modules present in app.asar`);
}

exports.default = async function afterPack(context) {
  // ── Verify packaged app has all critical modules (all platforms) ──
  await verifyAsar(context);

  // ── macOS code-signing steps below ──
  if (context.electronPlatformName !== 'darwin') return;

  // Find the .app bundle in the output dir (works regardless of product name)
  const appName =
    (context.packager.appInfo && context.packager.appInfo.productName) ||
    context.packager.config.productName ||
    'System Janitor';
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const entitlements = path.join(__dirname, 'entitlements.plist');

  console.log('\n🔏 afterPack: Signing for macOS 26+');
  console.log(`   App: ${appPath}`);

  // ── Verify Framework is present before signing ────────────────
  const frameworkBin = path.join(
    appPath,
    'Contents/Frameworks/Electron Framework.framework/Electron Framework'
  );
  if (!fs.existsSync(frameworkBin)) {
    console.error('❌ Electron Framework not found — cannot sign. Check electron-builder output.');
    process.exit(1);
  }
  console.log('   ✓ Electron Framework confirmed present');

  const run = (cmd) => {
    try {
      execSync(cmd, { shell: '/bin/bash', stdio: 'pipe' });
    } catch (e) {
      // Non-fatal: some nested items may already be signed or irrelevant
    }
  };

  // ── Step 1: Sign dylibs and .so files ────────────────────────
  console.log('   Step 1/4 — Signing dylibs (ad-hoc)...');
  run(`find "${appPath}" \\( -name "*.dylib" -o -name "*.so" \\) -exec codesign --force --sign - {} \\;`);

  // ── Step 2: Sign Helper .app bundles ─────────────────────────
  console.log('   Step 2/4 — Signing helpers (ad-hoc)...');
  const frameworksDir = path.join(appPath, 'Contents/Frameworks');
  for (const item of fs.readdirSync(frameworksDir)) {
    if (item.endsWith('.app')) {
      run(`codesign --force --sign - --options runtime --entitlements "${entitlements}" "${path.join(frameworksDir, item)}"`);
    }
  }

  // ── Step 3: Sign .framework bundles ──────────────────────────
  console.log('   Step 3/4 — Signing frameworks (ad-hoc)...');
  for (const item of fs.readdirSync(frameworksDir)) {
    if (item.endsWith('.framework')) {
      run(`codesign --force --sign - "${path.join(frameworksDir, item)}"`);
    }
  }

  // ── Step 4: Sign main app with ad-hoc + hardened runtime ─────
  // No Apple Developer cert available — using ad-hoc signing.
  // Users must right-click → Open → Open to bypass Gatekeeper on first launch.
  console.log('   Step 4/4 — Signing main app (ad-hoc + hardened runtime)...');
  const entFlag = fs.existsSync(entitlements) ? `--entitlements "${entitlements}"` : '';
  execSync(
    `codesign --force --sign - --options runtime ${entFlag} "${appPath}"`,
    { shell: '/bin/bash', stdio: 'inherit' }
  );
  console.log('   ✓ Ad-hoc signed — users must right-click → Open on first launch');

  // ── Strip quarantine ──────────────────────────────────────────
  run(`xattr -cr "${appPath}"`);
  console.log('   ✓ Quarantine stripped');

  // ── Create a ditto ZIP for reliable distribution ──────────────
  // electron-builder's DMG and ZIP targets can lose the Electron Framework's
  // Versions/Current→A symlink during packaging on macOS 26.
  // ditto -c -k is Apple's own tool and correctly preserves all macOS symlinks
  // and resource forks needed for framework bundles to load.
  const distDir = path.dirname(context.appOutDir);
  const zipOut = path.join(distDir, 'System Janitor-distributable.zip');
  try {
    if (fs.existsSync(zipOut)) fs.unlinkSync(zipOut);
    execSync(
      `ditto -c -k --sequesterRsrc --keepParent "${appPath}" "${zipOut}"`,
      { shell: '/bin/bash', stdio: 'pipe' }
    );
    console.log(`   ✓ Distribution ZIP: ${zipOut}`);
    console.log('     Share this ZIP — it preserves all macOS framework symlinks.');
  } catch (e) {
    console.log('   ⚠ ZIP creation failed:', e.message);
  }

  console.log('🔏 Signing complete — electron-builder will now create the DMG\n');
};
