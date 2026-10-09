const { app, BrowserWindow, dialog, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

const { setting, userDataDirectory, databasePath } = require('./branding.cjs');
const APP_NAME = 'Mossentry';
const appIcon = path.join(__dirname, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('Mossentry');
let backend;
let mainWindow;
let quitting = false;
let backendFailure;
const desktopToken = crypto.randomBytes(32).toString('hex');
const dataHome = userDataDirectory(app.getPath('appData'));
fs.mkdirSync(dataHome, { recursive: true, mode: 0o700 });
app.setPath('userData', dataHome);
const hasInstanceLock = app.requestSingleInstanceLock();

if (!hasInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function backendDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(__dirname, '..', 'backend');
}

function pythonExecutable() {
  if (setting('PYTHON')) return setting('PYTHON');
  const local = path.join(__dirname, '..', '.venv', 'bin', 'python');
  if (fs.existsSync(local)) return local;
  return 'python3';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function isHealthy(port) {
  return new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${port}/health`, {
      headers: { 'X-Desktop-Token': desktopToken },
    }, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(500, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function waitForBackend(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await isHealthy(port)) return;
    if (backendFailure || !backend || backend.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('The local service could not start. Install the Python dependencies and check the terminal output.');
}

function stopBackend() {
  if (!backend || backend.exitCode !== null) return;
  try {
    if (process.platform === 'win32') backend.kill();
    else process.kill(-backend.pid, 'SIGTERM');
  } catch {
    backend.kill();
  }
}

function createWindow(origin) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 650,
    autoHideMenuBar: true,
    title: APP_NAME,
    icon: appIcon,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : {
      titleBarOverlay: { color: '#ffffff', symbolColor: '#17233b', height: 64 },
    }),
    backgroundColor: '#f5f7fb',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  mainWindow.loadURL(origin);
  mainWindow.on('closed', () => { mainWindow = null; });
}

if (hasInstanceLock) app.whenReady().then(async () => {
  try {
    if (process.platform === 'darwin') app.dock.setIcon(appIcon);
    app.setAboutPanelOptions({ applicationName: APP_NAME, iconPath: appIcon });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const dataDirectory = path.join(app.getPath('userData'), 'data');
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
      details.requestHeaders['X-Desktop-Token'] = desktopToken;
      callback({ requestHeaders: details.requestHeaders });
    });
    backend = spawn(pythonExecutable(), [
      '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port),
    ], {
      cwd: backendDirectory(),
      env: {
        ...process.env,
        MOSSENTRY_DATA_DIR: dataDirectory,
        MOSSENTRY_DB_PATH: databasePath(dataDirectory),
        MOSSENTRY_DESKTOP_TOKEN: desktopToken,
      },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    backend.stderr.on('data', chunk => process.stderr.write(chunk));
    backend.on('error', error => {
      backendFailure = error;
      process.stderr.write(`${error.message}\n`);
    });
    backend.on('exit', () => {
      if (!quitting && mainWindow) {
        dialog.showErrorBox(`${APP_NAME} — Service stopped`, 'The local service exited unexpectedly. Check the terminal output.');
        app.quit();
      }
    });
    await waitForBackend(port);
    createWindow(origin);
  } catch (error) {
    dialog.showErrorBox(`${APP_NAME} — Startup failed`, error.message);
    app.quit();
  }
});

app.on('before-quit', () => {
  quitting = true;
  stopBackend();
});

app.on('window-all-closed', () => app.quit());

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    quitting = true;
    stopBackend();
    app.quit();
  });
}
process.on('exit', stopBackend);
