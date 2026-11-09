'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const ff = require('./ffmpeg');

// Keep Chromium's disk cache tiny. The app never needs it, and this stops it from growing without limit.
app.commandLine.appendSwitch('disk-cache-size', String(8 * 1024 * 1024));

const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'm4v', 'avi', 'webm', 'mts', 'm2ts', 'ts', 'wmv', 'flv', '3gp', 'mpg', 'mpeg'];

let win = null;
let dirty = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#18171d',
    title: 'ClipCut',
    icon: path.join(__dirname, 'renderer', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#18171d', symbolColor: '#c9c7d4', height: 48 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Dropping a file outside the drop zones would otherwise navigate the window to it, and nothing may open new windows.
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  win.on('close', e => {
    if (ff.isExporting()) {
      const r = dialog.showMessageBoxSync(win, {
        type: 'warning', buttons: ['Keep exporting', 'Cancel export and quit'], defaultId: 0, cancelId: 0,
        title: 'Export in progress', message: 'An export is still running. Quit anyway?',
      });
      e.preventDefault();
      if (r === 0) return;
      // Stop the export and let it clean up (partial output file, temp folder) before the window goes away.
      dirty = false;
      ff.cancelExport();
      const poll = setInterval(() => { if (!ff.isExporting()) { clearInterval(poll); win.destroy(); } }, 100);
    } else if (dirty) {
      const r = dialog.showMessageBoxSync(win, {
        type: 'question', buttons: ['Stay', 'Quit without exporting'], defaultId: 0, cancelId: 0,
        title: 'Quit ClipCut?', message: "Your edit hasn't been exported yet. Quit anyway?",
      });
      if (r === 0) e.preventDefault();
    }
  });
}

ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Import media',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Videos', extensions: VIDEO_EXT }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('probe', async (_e, file) => {
  const info = await ff.probe(file);
  return { ...info, fileUrl: pathToFileURL(file).href };
});

ipcMain.handle('encoders', () => ff.detectEncoders());

ipcMain.handle('save-dialog', async (_e, defaultPath) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Export video',
    defaultPath,
    filters: [
      { name: 'MP4 video', extensions: ['mp4'] },
      { name: 'QuickTime video', extensions: ['mov'] },
      { name: 'Matroska video', extensions: ['mkv'] },
    ],
  });
  return r.canceled ? null : r.filePath;
});

// The page is our own code, but what it sends ends up on ffmpeg's command line, so check it anyway.
function validatePlan(plan) {
  const absolute = p => typeof p === 'string' && path.isAbsolute(p) && !p.startsWith('-');
  const ok = plan && absolute(plan.output) && Array.isArray(plan.segments) && plan.segments.length > 0 &&
    plan.segments.every(s => s && absolute(s.path) && s.in >= 0 && s.out > s.in && s.info &&
      s.info.fps > 0 && s.info.displayWidth > 0 && s.info.displayHeight > 0);
  if (!ok) throw new Error('Invalid export request');
}

ipcMain.handle('export-start', async (_e, plan) => {
  try {
    validatePlan(plan);
    await ff.exportVideo(plan, p => { if (win && !win.isDestroyed()) win.webContents.send('export-progress', p); });
    return { ok: true };
  } catch (err) {
    return { ok: false, cancelled: !!err.cancelled, error: err.message };
  }
});

ipcMain.handle('export-cancel', () => ff.cancelExport());
ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));
ipcMain.on('set-dirty', (_e, d) => { dirty = !!d; });

app.setName('ClipCut');
app.setAppUserModelId('ClipCut.VideoEditor');

app.whenReady().then(async () => {
  const tc = await ff.checkToolchain();
  if (!tc.ok) {
    dialog.showErrorBox('ClipCut needs ffmpeg',
      `ClipCut uses ffmpeg and ffprobe to read and export video, but they could not be started (${tc.error}).\n\n` +
      'Run Setup.bat in the ClipCut folder to download them, or install ffmpeg and add it to your PATH, then start ClipCut again.');
    app.quit();
    return;
  }
  if (tc.major < 6 || !tc.cpu.h264 || !tc.cpu.hevc) {
    dialog.showMessageBoxSync({
      type: 'warning', title: 'ffmpeg', buttons: ['Continue anyway'],
      message: tc.major < 6
        ? `ffmpeg ${tc.version} is older than ClipCut was tested with (6.0 or newer). Exports may fail. Run Setup.bat to get a current one.`
        : `This ffmpeg (${tc.ffmpeg}) was built without ${!tc.cpu.h264 ? 'libx264' : 'libx265'}, so "Exact cuts" on the CPU won't work. Run Setup.bat to get a full build.`,
    });
  }
  ff.cleanupTemp();
  ff.detectEncoders(); // warm up so the export dialog opens instantly
  createWindow();
  // Developer hook used by `npm test`: CLIPCUT_TEST=<path to a module exporting (win, ctl) => {}> drives the window.
  if (process.env.CLIPCUT_TEST) require(path.resolve(process.env.CLIPCUT_TEST))(win, { setDirty: d => { dirty = d; } });
});

app.on('window-all-closed', () => app.quit());
