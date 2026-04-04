/**
 * appMenu.js — Application menu bar with keyboard shortcuts.
 *
 * Provides standard macOS/Windows/Linux menus:
 *   File, Edit, View, Window, Help
 *
 * Keyboard shortcuts:
 *   Cmd/Ctrl+O  → Open files
 *   Cmd/Ctrl+Shift+O → Open folder
 *   Cmd/Ctrl+Z  → Undo
 *   Cmd/Ctrl+Shift+Z → Redo
 *   Cmd/Ctrl+,  → Settings
 *   Cmd/Ctrl+N  → New Category
 *   Cmd/Ctrl+F  → Focus search
 *   Cmd/Ctrl+Shift+S → Sync to cloud
 */

const { app, Menu, shell, BrowserWindow } = require("electron");

const isMac = process.platform === "darwin";

/**
 * Build and set the application menu.
 * Call once from app.whenReady() after mainWindow is created.
 *
 * @param {BrowserWindow} mainWindow
 */
function buildAppMenu(mainWindow) {
  /** Helper: send an action to the renderer via IPC */
  function sendAction(action) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("menu:action", action);
    }
  }

  const template = [
    // ── App menu (macOS only) ──
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            {
              label: "Settings...",
              accelerator: "Cmd+,",
              click: () => sendAction("open-settings"),
            },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }]
      : []),

    // ── File ──
    {
      label: "File",
      submenu: [
        {
          label: "Open Files...",
          accelerator: "CmdOrCtrl+O",
          click: () => sendAction("open-files"),
        },
        {
          label: "Open Folder...",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => sendAction("open-folder"),
        },
        { type: "separator" },
        {
          label: "New Category",
          accelerator: "CmdOrCtrl+N",
          click: () => sendAction("new-category"),
        },
        { type: "separator" },
        {
          label: "Sync to Cloud",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => sendAction("cloud-sync"),
        },
        { type: "separator" },
        ...(isMac ? [{ role: "close" }] : [{ role: "quit" }]),
      ],
    },

    // ── Edit ──
    {
      label: "Edit",
      submenu: [
        {
          label: "Undo File Move",
          accelerator: "CmdOrCtrl+Z",
          click: () => sendAction("undo"),
        },
        {
          label: "Redo File Move",
          accelerator: "CmdOrCtrl+Shift+Z",
          click: () => sendAction("redo"),
        },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        {
          label: "Find in Files",
          accelerator: "CmdOrCtrl+F",
          click: () => sendAction("focus-search"),
        },
        ...(!isMac
          ? [
              { type: "separator" },
              {
                label: "Settings...",
                accelerator: "Ctrl+,",
                click: () => sendAction("open-settings"),
              },
            ]
          : []),
      ],
    },

    // ── View ──
    {
      label: "View",
      submenu: [
        {
          label: "Personal Mode",
          accelerator: "CmdOrCtrl+1",
          click: () => sendAction("mode-personal"),
        },
        {
          label: "Work Mode",
          accelerator: "CmdOrCtrl+2",
          click: () => sendAction("mode-work"),
        },
        { type: "separator" },
        {
          label: "Ask AI",
          accelerator: "CmdOrCtrl+Shift+A",
          click: () => sendAction("open-chat"),
        },
        {
          label: "Dashboard",
          accelerator: "CmdOrCtrl+D",
          click: () => sendAction("open-dashboard"),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },

    // ── Window ──
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [{ type: "separator" }, { role: "front" }]
          : [{ role: "close" }]),
      ],
    },

    // ── Help ──
    {
      label: "Help",
      submenu: [
        {
          label: "Getting Started",
          click: () => sendAction("show-onboarding"),
        },
        {
          label: "Keyboard Shortcuts",
          click: () => sendAction("show-shortcuts"),
        },
        { type: "separator" },
        {
          label: "Privacy Policy",
          click: () => sendAction("show-privacy"),
        },
        {
          label: "Terms of Service",
          click: () => sendAction("show-terms"),
        },
        { type: "separator" },
        {
          label: "Report an Issue...",
          click: () => shell.openExternal("mailto:support@systemjanitor.app?subject=Bug%20Report"),
        },
        ...(isMac
          ? []
          : [{ type: "separator" }, { role: "about" }]),
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

module.exports = { buildAppMenu };
