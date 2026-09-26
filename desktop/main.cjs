const { app, BrowserWindow, dialog, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

app.setName('Server Manager');
let backend;
let mainWindow;
let quitting = false;
let backendFailure;
const desktopToken = crypto.randomBytes(32).toString('hex');
if (process.env.SRVMGR_USER_DATA_DIR) {
  const userDataDirectory = path.resolve(process.env.SRVMGR_USER_DATA_DIR);
  fs.mkdirSync(userDataDirectory, { recursive: true, mode: 0o700 });
  app.setPath('userData', userDataDirectory);
} else {
  // Reuse data created by earlier builds when the new app directory is empty.
  const previousDirectory = path.join(app.getPath('appData'), 'luo-server-manager-desktop');
  const currentDatabase = path.join(app.getPath('userData'), 'data', 'server_manager.db');
  const previousDatabase = path.join(previousDirectory, 'data', 'server_manager.db');
  if (!fs.existsSync(currentDatabase) && fs.existsSync(previousDatabase)) {
    app.setPath('userData', previousDirectory);
  }
}
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
  if (process.env.SRVMGR_PYTHON) return process.env.SRVMGR_PYTHON;
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
    title: 'Server Manager',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : {
      titleBarOverlay: { color: '#303a58', symbolColor: '#f2f5ff', height: 66 },
    }),
    backgroundColor: '#303a58',
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
        SRVMGR_DATA_DIR: dataDirectory,
        SRVMGR_DB_PATH: path.join(dataDirectory, 'server_manager.db'),
        SRVMGR_DESKTOP_TOKEN: desktopToken,
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
        dialog.showErrorBox('Service stopped', 'The local service exited unexpectedly. Check the terminal output.');
        app.quit();
      }
    });
    await waitForBackend(port);
    createWindow(origin);
  } catch (error) {
    dialog.showErrorBox('Startup failed', error.message);
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
