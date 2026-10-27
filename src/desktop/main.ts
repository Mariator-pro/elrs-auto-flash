import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { app, BrowserWindow, dialog, screen, session, shell, type SerialPort } from 'electron';
import { paths } from '../core/paths.ts';
import { loadSettings } from '../core/settings.ts';
import { noteRunning, running } from '../server/running.ts';
import { startServer, type RunningServer } from '../server/server.ts';
import { TEXTS, type Lang, type Texts } from '../ui/texts.ts';
import { isOwnPage, isWebLink } from './links.ts';
import { appUpdates } from './update.ts';

// Space kept free around the window when it opens, in points.
const WINDOW_MARGIN = 24;
// The only page that may use the serial ports: the embedded ExpressLRS Web Flasher.
const WEB_FLASHER = 'https://expresslrs.github.io';

const p = paths();
let server: RunningServer | undefined;
let forgetNote: (() => Promise<void>) | undefined;
let quitting = false;

// The dialogs of this process in the language the page was last set to.
async function texts(): Promise<Texts['desktop']> {
  const lang = (await loadSettings(p)).ui?.lang;
  return (TEXTS[lang as Lang] ?? TEXTS.en).desktop;
}

// What the Web Flasher keeps in the browser's storage (binding phrase, WiFi name and password) stays on
// this computer only when asked for; the own page keeps nothing there.
async function forgetWebFlasher(): Promise<void> {
  if (!(await loadSettings(p)).rememberWebFlasher) await session.defaultSession.clearStorageData({ storages: ['localstorage'] });
}

// Quitting cuts off a running flash: the device keeps its old firmware and gets the update next time, but ask first.
async function mayQuit(): Promise<boolean> {
  const win = BrowserWindow.getAllWindows()[0];
  if (!server?.flashing() || !win) return true;
  const t = await texts();
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: t.quitFlashing,
    detail: t.quitFlashingText,
    buttons: [t.quit, t.cancel],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

// Electron has no chooser for Web Serial: the Web Flasher gets the port picked in a small dialog.
async function choosePort(win: BrowserWindow, ports: SerialPort[]): Promise<string> {
  const t = await texts();
  if (!ports.length) {
    await dialog.showMessageBox(win, { type: 'info', message: t.noPort, detail: t.noPortText, buttons: [t.ok] });
    return '';
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    message: t.choosePort,
    detail: t.choosePortText,
    buttons: [...ports.map((port) => (port.displayName ? `${port.displayName} (${port.portName})` : port.portName)), t.cancel],
    cancelId: ports.length,
    noLink: true,
  });
  return ports[response]?.portId ?? '';
}

// Downloads of the Web Flasher (firmware file, Lua script) go to the Downloads folder without asking,
// under a free name, and are shown there once saved. Any other file is only saved where the user picks
// in the system's dialog, so no page in the window can put programs or documents there unseen.
const AUTO_SAVE = ['.bin', '.gz', '.lua'];

function saveDownloads(): void {
  session.defaultSession.on('will-download', (_e, item) => {
    const name = basename(item.getFilename());
    const ext = extname(name);
    if (!AUTO_SAVE.includes(ext.toLowerCase())) return;
    const dir = app.getPath('downloads');
    let file = join(dir, name);
    for (let n = 1; existsSync(file); n++) file = join(dir, `${name.slice(0, name.length - ext.length)} (${n})${ext}`);
    item.setSavePath(file);
    item.once('done', (_e, state) => {
      if (state === 'completed') shell.showItemInFolder(file);
    });
  });
}

// No page in the window gets a permission (camera, microphone, location, notifications ...) apart from
// writing to the clipboard, and the Web Flasher the serial ports.
const ALLOWED = ['clipboard-sanitized-write'];

function limitPermissions(): void {
  const ses = session.defaultSession;
  // Electron hands the origin over as a URL, e.g. with a slash at the end
  const isFlasher = (origin: string) => URL.parse(origin)?.origin === WEB_FLASHER;
  const allowed = (permission: string, origin: string) => ALLOWED.includes(permission) || (permission === 'serial' && isFlasher(origin));
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed(permission, origin));
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => callback(allowed(permission, details.requestingUrl)));
  ses.setDevicePermissionHandler((d) => d.deviceType === 'serial' && isFlasher(d.origin));
  ses.on('select-serial-port', (e, ports, wc, callback) => {
    e.preventDefault();
    const win = BrowserWindow.fromWebContents(wc);
    if (!win) return callback('');
    void choosePort(win, ports).then(callback, () => callback(''));
  });
}

// url: the server's own address; open: the address the window opens at, with the key
function openWindow(url: string, open: string): BrowserWindow {
  // At most 1280 × 860, but always inside the free screen area (no menu bar, dock or taskbar) with a margin, centred there.
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(1280, area.width - 2 * WINDOW_MARGIN);
  const height = Math.min(860, area.height - 2 * WINDOW_MARGIN);
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    minWidth: 900,
    minHeight: 600,
    title: 'ELRS Auto Flash',
  });
  // Electron's default menu has nothing the app needs on Windows, and Windows draws a stray white line under it in dark mode;
  // macOS keeps it for Cmd+Q and copy and paste
  if (process.platform !== 'darwin') win.removeMenu();
  // links to GitHub, and the Web Flasher's guides, open in the browser, not in the app; other schemes not at all
  win.webContents.setWindowOpenHandler(({ url: to }) => {
    if (isWebLink(to)) void shell.openExternal(to);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, to) => {
    if (isOwnPage(to, url)) return;
    e.preventDefault();
    if (isWebLink(to)) void shell.openExternal(to);
  });
  // closing the window quits the app, the same way as Cmd+Q
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    app.quit();
  });
  void win.loadURL(open);
  return win;
}

async function start(): Promise<void> {
  // left over when the app did not quit normally last time
  await forgetWebFlasher();
  limitPermissions();
  saveDownloads();
  // The browser interface, watch or update may run already: two of them would flash the same devices, and
  // showing the browser interface's page here would hide what only the app has, so the app asks to quit it first.
  const other = await running(p.server);
  if (other) {
    const t = await texts();
    const [message, detail] = {
      browser: [t.alreadyRunning, t.alreadyRunningText],
      watch: [t.alreadyWatching, t.alreadyWatchingText],
      update: [t.alreadyUpdating, t.alreadyUpdatingText],
      app: [t.alreadyApp, t.alreadyAppText],
    }[other.kind];
    await dialog.showMessageBox({ type: 'info', message, detail, buttons: [t.ok] });
    app.quit();
    return;
  }
  // only the installed app updates itself, not a start from the source folder
  const updates = app.isPackaged ? appUpdates() : undefined;
  server = await startServer({ paths: p, port: 0, appUpdates: updates, desktop: true, staticDir: join(app.getAppPath(), 'dist', 'ui') });
  // the browser interface and the terminal's watch and update find this server through the note
  forgetNote = await noteRunning(p.server, { kind: 'app', url: server.open });
  openWindow(server.url, server.open);
  // without internet or GitHub the app runs on as it is
  updates?.check().catch((e: unknown) => console.error('Update check failed:', e));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  // asks while flashing, then clears the Web Flasher's storage and the server's note, which takes a moment
  let asking = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    if (asking) return;
    asking = true;
    void mayQuit()
      .then(async (ok) => {
        if (!ok) return;
        await Promise.all([forgetWebFlasher(), forgetNote?.()]).catch((err: unknown) => console.error(err));
        quitting = true;
        app.quit();
      })
      .finally(() => {
        asking = false;
      });
  });
  app.whenReady().then(start).catch((e: Error) => {
    console.error(e);
    app.quit();
  });
}
