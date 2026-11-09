// DJ Free desktop (Windows / Linux / macOS) — Electron shell around the shared web UI.
const { app, BrowserWindow, protocol, net, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const WWW = path.join(__dirname, 'www');
const AUDIO_EXT = /\.(mp3|m4a|aac|mp4|wav|wave|flac|ogg|oga|opus|webm|aif|aiff|wma|alac)$/i;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// app:// behaves like https (secure context -> AudioWorklet, fetch, CORS) for the UI.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

function allowedProxyHost(h) {
  h = String(h || '').toLowerCase();
  return h === 'apple.com' || h.endsWith('.apple.com') || h.endsWith('.mzstatic.com') || h.endsWith('.itunes.com');
}

function registerProtocol() {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/__proxy') { // Apple catalog search + preview audio (no CORS headers upstream)
      const target = new URL(u.searchParams.get('url'));
      if (target.protocol !== 'https:' || !allowedProxyHost(target.hostname)) return new Response('Forbidden', { status: 403 });
      const r = await net.fetch(target.toString());
      return new Response(r.body, { status: r.status, headers: { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' } });
    }
    if (u.pathname === '/__file') { // music files the user picked or dropped
      const p = u.searchParams.get('p') || '';
      if (!AUDIO_EXT.test(p) || !fs.existsSync(p)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(p).toString());
    }
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(WWW, rel));
    if (!file.startsWith(WWW) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' } });
  });
}

ipcMain.handle('save-recording', async (_e, bytes, name) => {
  const dir = path.join(app.getPath('music'), 'DJ Free');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name).replace(/[\\/:*?"<>|]/g, '_');
  const file = path.join(dir, safe);
  fs.writeFileSync(file, Buffer.from(bytes));
  return file;
});
ipcMain.handle('show-file', (_e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });
ipcMain.handle('file-exists', (_e, p) => !!p && fs.existsSync(p));

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 720, minWidth: 900, minHeight: 440,
    backgroundColor: '#0B0D12', title: 'DJ Free', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  // The UI is laid out for a ~844x390 landscape screen: scale it to fill any window.
  const fit = () => {
    const [w, h] = win.getContentSize();
    win.webContents.setZoomFactor(Math.max(1, Math.min(w / 844, h / 400, 3)));
  };
  win.on('resize', fit);
  win.webContents.on('did-finish-load', fit);
  // External links (Apple docs etc.) open in the default browser; MusicKit sign-in stays in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/([a-z0-9-]+\.)*apple\.com\//i.test(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true } };
    shell.openExternal(url); return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  win.loadURL('app://dj/index.html');
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerProtocol();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
