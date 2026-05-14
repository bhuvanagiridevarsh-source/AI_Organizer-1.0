/**
 * beforeBuild.js — electron-builder hook that installs the correct
 * platform-specific esbuild binary before the app is packed.
 *
 * WHY THIS EXISTS
 * ───────────────
 * tsx (used to run .ts services at runtime) depends on esbuild internally.
 * When building on macOS for Windows (cross-compile), npm only installs
 * @esbuild/darwin-arm64, never @esbuild/win32-x64.  The resulting Windows
 * installer is therefore missing the esbuild binary and crashes on launch.
 *
 * This hook runs right before electron-builder packs node_modules.  It
 * detects the target platform/arch and npm-installs the matching @esbuild
 * package so it ends up in app.asar.unpacked alongside the main package.
 *
 * electron-builder.yml: beforeBuild: scripts/beforeBuild.js
 */

const { execSync } = require("child_process");
const path = require("path");
const fs   = require("fs");

// Map of [electron-builder platform string] → @esbuild package names
// NOTE: electron-builder passes platform.name as "windows" / "mac" / "linux"
// (not "win") — verify with: console.log(platform.name) in the hook.
const ESBUILD_PLATFORM_PKGS = {
  windows: {
    x64:   "@esbuild/win32-x64",
    arm64: "@esbuild/win32-arm64",
    ia32:  "@esbuild/win32-ia32",
  },
  mac:   {
    x64:   "@esbuild/darwin-x64",
    arm64: "@esbuild/darwin-arm64",
  },
  linux: {
    x64:   "@esbuild/linux-x64",
    arm64: "@esbuild/linux-arm64",
  },
};

// electron-builder passes { appDir, electronVersion, platform, arch }
module.exports = async function beforeBuild({ appDir, platform, arch }) {
  const platformStr = platform.name; // 'win', 'mac', 'linux'
  const archStr     = arch;          // 'x64', 'arm64', 'ia32'

  const pkgMap = ESBUILD_PLATFORM_PKGS[platformStr];
  if (!pkgMap) {
    console.log(`[beforeBuild] Unknown platform "${platformStr}" — skipping esbuild install`);
    return;
  }

  const pkg = pkgMap[archStr] || pkgMap["x64"]; // fall back to x64
  if (!pkg) {
    console.log(`[beforeBuild] No esbuild package known for ${platformStr}/${archStr}`);
    return;
  }

  // Find the esbuild version already installed (transitive dep of tsx)
  let esbuildVersion = "latest";
  try {
    const esbuildPkg = JSON.parse(
      fs.readFileSync(path.join(appDir, "node_modules", "esbuild", "package.json"), "utf-8")
    );
    esbuildVersion = esbuildPkg.version;
  } catch {
    console.warn("[beforeBuild] Could not read esbuild version — will install 'latest'");
  }

  const pkgWithVersion = `${pkg}@${esbuildVersion}`;
  const installPath    = path.join(appDir, "node_modules", ...pkg.split("/"));

  if (fs.existsSync(installPath)) {
    console.log(`[beforeBuild] ${pkgWithVersion} already installed — skipping`);
    return;
  }

  console.log(`[beforeBuild] Installing ${pkgWithVersion} for ${platformStr}/${archStr} …`);
  try {
    execSync(
      `npm install --no-save --ignore-scripts "${pkgWithVersion}"`,
      { cwd: appDir, stdio: "inherit" }
    );
    console.log(`[beforeBuild] ✓ ${pkgWithVersion} installed`);
  } catch (err) {
    console.error(`[beforeBuild] Failed to install ${pkgWithVersion}:`, err.message);
    // Non-fatal: the build continues; the binary may already exist for the host platform
  }
};
