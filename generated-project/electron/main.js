'use strict';

/**
 * Desktop shell for Space Fractions. Opens the existing game server (scripts/dev-server.js -
 * the same in-memory, no-Docker boot path npm run dev already uses) inside a native window
 * instead of requiring a browser tab. The server and all game logic are untouched - this only
 * changes how it's presented, from "open a browser at localhost:4000" to a real desktop app.
 *
 *   npm run desktop
 */
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { app, BrowserWindow } = require('electron');

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const HOST = '127.0.0.1';

let serverProcess = null;
let mainWindow = null;

function startServer() {
  serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'dev-server.js')], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
  });
}

function waitForServer(timeoutMs = 15000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    (function attempt() {
      const socket = net.createConnection(PORT, HOST);
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Space Fractions server did not start within ${timeoutMs}ms`));
          return;
        }
        setTimeout(attempt, 200);
      });
    })();
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 720,
    minHeight: 600,
    title: 'Space Fractions',
    autoHideMenuBar: true,
    backgroundColor: '#05060f',
  });

  await waitForServer();
  await mainWindow.loadURL(`http://${HOST}:${PORT}/`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  startServer();
  try {
    await createWindow();
  } catch (err) {
    console.error('Failed to start Space Fractions desktop app:', err);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
}

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopServer);
