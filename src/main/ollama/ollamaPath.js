/**
 * ollamaPath.js — Resolves the white-labeled AI engine binary path.
 *
 * The binary is named "internal-core" (not "ollama") so end-users
 * and enterprise clients only see your brand.
 *
 * Dev:  <project-root>/resources/bin/internal-core
 * Prod: <app.asar>/../resources/bin/internal-core
 */

const path = require("path");
const fs = require("fs");
const { app } = require("electron");

const BINARY_NAME =
  process.platform === "win32" ? "internal-core.exe" : "internal-core";

function getEnginePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "bin", BINARY_NAME);
  }
  return path.join(app.getAppPath(), "resources", "bin", BINARY_NAME);
}

function engineExists() {
  return fs.existsSync(getEnginePath());
}

// Backward-compatible exports — existing code that calls getOllamaPath() still works
module.exports = {
  getEnginePath,
  engineExists,
  getOllamaPath: getEnginePath,
  ollamaExists: engineExists,
};
