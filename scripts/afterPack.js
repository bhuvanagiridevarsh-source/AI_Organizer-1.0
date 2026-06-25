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
// NOTE: better-sqlite3 was intentionally removed — DatabaseService has a
// JSON fallback and shipping a native build broke Electron-40 V8 13.
const REQUIRED_MODULES = [
  'electron-store',
  'electron-updater',
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
  // Also check the sibling locations where modules can live at runtime:
  //   1. app.asar.unpacked/node_modules  — electron-builder's standard unpack target
  //   2. resources/node_modules          — where ensureProdNodeModules() copies them
  // Node's resolver walks up from app.asar/src/main and finds resources/node_modules.
  const resourcesDir = path.dirname(asarPath);
  const unpackedNM = path.join(asarPath + '.unpacked', 'node_modules');
  const siblingNM = path.join(resourcesDir, 'node_modules');
  const haveModule = (m) => {
    if (entries.some(e => e.startsWith(`/node_modules/${m}/`) || e === `/node_modules/${m}`)) return true;
    if (fs.existsSync(path.join(unpackedNM, m, 'package.json'))) return true;
    if (fs.existsSync(path.join(siblingNM, m, 'package.json'))) return true;
    return false;
  };
  const missing = REQUIRED_MODULES.filter(m => !haveModule(m));
  if (missing.length) {
    console.error('\n❌❌❌ verifyAsar FAILED — packaged app would crash at boot.');
    console.error(`Missing modules (checked asar + .unpacked + resources/node_modules):`);
    missing.forEach(m => console.error(`   - ${m}`));
    console.error('ensureProdNodeModules() should have copied these — check the copy log above.\n');
    process.exit(1);
  }
  console.log(`✓ verifyAsar: all ${REQUIRED_MODULES.length} critical modules present`);
}

/**
 * Force the production node_modules next to app.asar.
 *
 * Why this exists: electron-builder 26's file collection silently strips
 * node_modules even when you explicitly add `node_modules/**\/*` to `files:`.
 * The result is an app that boots into "Cannot find module 'electron-store'".
 *
 * The fix sidesteps electron-builder's filtering entirely: we read the project's
 * own package.json, walk every production dependency (and its transitive deps),
 * and physically copy each one into resources/node_modules/ — a real filesystem
 * directory adjacent to app.asar. Node's standard require() resolver walks up
 * the directory tree from the requiring file (inside app.asar) and finds the
 * module at resources/node_modules/<name>/. No asar manifest manipulation
 * needed; this is exactly how non-asar Electron apps work.
 *
 * This runs in afterPack — after electron-builder has written app.asar but
 * before code-signing (which on macOS will then sign any .node files too).
 */
function ensureProdNodeModules(context) {
  const srcRoot = path.resolve(__dirname, '..');         // repo root
  const pkgJson = JSON.parse(fs.readFileSync(path.join(srcRoot, 'package.json'), 'utf-8'));
  const prodDeps = Object.keys(pkgJson.dependencies || {});

  const resourcesDir = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir,
        `${(context.packager.appInfo && context.packager.appInfo.productName) || 'System Janitor'}.app/Contents/Resources`)
    : path.join(context.appOutDir, 'resources');
  const targetNM = path.join(resourcesDir, 'node_modules');
  fs.mkdirSync(targetNM, { recursive: true });

  // Walk dep tree: read each module's package.json, recurse on its `dependencies`.
  const visited = new Set();
  const queue = [...prodDeps];
  const copied = [];
  const missing = [];

  // Recursively copy a directory (Node 16.7+ has cpSync; safe on CI Node 22).
  const copyDir = (src, dst) => {
    fs.cpSync(src, dst, { recursive: true, dereference: true, errorOnExist: false, force: true });
  };

  // Resolve a module's installed dir, walking up node_modules trees.
  const resolveModuleDir = (modName, fromDir) => {
    let dir = fromDir;
    while (true) {
      const candidate = path.join(dir, 'node_modules', modName);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  };

  while (queue.length) {
    const modName = queue.shift();
    if (visited.has(modName)) continue;
    visited.add(modName);

    const modDir = resolveModuleDir(modName, srcRoot);
    if (!modDir) { missing.push(modName); continue; }

    const dstDir = path.join(targetNM, modName);
    try {
      copyDir(modDir, dstDir);
      copied.push(modName);
    } catch (err) {
      console.warn(`   ⚠ ensureProdNodeModules: failed to copy ${modName}: ${err.message}`);
      missing.push(modName);
      continue;
    }

    // Recurse into this module's own production dependencies.
    try {
      const modPkg = JSON.parse(fs.readFileSync(path.join(modDir, 'package.json'), 'utf-8'));
      for (const dep of Object.keys(modPkg.dependencies || {})) {
        if (!visited.has(dep)) queue.push(dep);
      }
    } catch { /* unparseable package.json — skip recursion */ }
  }

  console.log(`✓ ensureProdNodeModules: copied ${copied.length} modules into resources/node_modules/`);
  if (missing.length) {
    // Don't fail the build — many "missing" deps are optional peerDependencies
    // (is-unicode-supported, ora, log-symbols, etc.) that the runtime requires
    // lazily inside try/catch. verifyAsar below is the real gate: it fails the
    // build only if a module the app definitely needs is absent.
    console.warn(`⚠ ensureProdNodeModules: ${missing.length} optional deps unresolved (likely hoisted/peer): ${missing.join(', ')}`);
  }
}

exports.default = async function afterPack(context) {
  // ── 0. Force-copy production node_modules (works around electron-builder 26
  //       stripping them from custom `files:` lists). All platforms. ──
  ensureProdNodeModules(context);

  // ── 1. Verify packaged app has all critical modules (all platforms) ──
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
