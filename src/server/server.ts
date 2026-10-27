import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { AppError } from '../core/errors.ts';
import { dismiss, rename, updateKnown, type KnownDevice } from '../core/known.ts';
import type { Paths } from '../core/paths.ts';
import { checkReleases, majorVersions, targetRelease, type ReleaseList, type VersionedRelease } from '../core/releases.ts';
import { loadSettings, saveSettings, type Settings } from '../core/settings.ts';
import { MIN_MAJOR } from '../core/version.ts';
import { createWatcher, type WatchDeps, type WatchEvent } from '../core/watch.ts';
import {
  deviceLabel,
  MAX_NAME,
  TOKEN_HASH,
  TOKEN_HEADER,
  withPageData,
  type ActivityEntry,
  type AppUpdateView,
  type DeviceView,
  type ErrorCode,
  type FlashOutcome,
  type WatchState,
  type PrefsView,
  type StateView,
} from './api.ts';

export interface ServerOptions {
  paths: Paths;
  port: number;
  staticDir?: string; // built interface; without it only /api is served (Vite serves the page)
  watch?: WatchDeps;
  appUpdates?: AppUpdates; // desktop app only
  desktop?: boolean;
}

// The desktop app's own updates: the newer release found, and installing it where the app can do that itself.
export interface AppUpdates {
  view: () => AppUpdateView | undefined;
  onChange: (fn: () => void) => void;
  install: () => Promise<void>;
}

export interface RunningServer {
  url: string;
  token: string;
  open: string; // the address to open the interface at, with the key behind # (never sent to the server)
  page: (html: string) => string; // the page with this start's key and the stored choices, for Vite in development only
  flashing: () => boolean;
  close: () => Promise<void>; // resolves once a running flash has ended
}

class HttpError extends Error {
  status: number;
  code: ErrorCode;
  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

const MAX_BODY = 64 * 1024;

// The page loads only its own files and the Web Flasher's frame, and no other site may show it in a frame
// of its own (where it could be clicked unseen); the Web Flasher is also asked once whether it answers.
const WEB_FLASHER = 'https://expresslrs.github.io';
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  `connect-src 'self' ${WEB_FLASHER}`,
  `frame-src ${WEB_FLASHER}`,
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const MAX_ACTIVITY = 500;

// The names this computer's browser reaches the server by, on any port (Vite forwards from its own).
const LOCAL_NAMES = ['localhost', '127.0.0.1'];

// The name in a Host header, without the port; empty when there is none or it cannot be read.
function hostName(host: string | undefined): string {
  try {
    return host ? new URL(`http://${host}`).hostname : '';
  } catch {
    return '';
  }
}

// An activity line before it gets its number and time (Omit for each kind of line).
type NewEntry<T = ActivityEntry> = T extends unknown ? Omit<T, 'id' | 'at'> : never;

async function body<T>(req: IncomingMessage): Promise<Partial<T>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'invalidRequest', 'Request too large.');
    chunks.push(c as Buffer);
  }
  try {
    const data: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Partial<T>;
  } catch {
    // answered below
  }
  throw new HttpError(400, 'invalidRequest', 'Not a JSON object.');
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data ?? null));
}

function openFolder(dir: string): void {
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(cmd, [dir], () => {});
}

function deviceView(d: KnownDevice, state: WatchState, online: boolean, step?: DeviceView['step']): DeviceView {
  return {
    key: d.key,
    ip: d.ip,
    mac: d.mac,
    name: d.name,
    label: deviceLabel(d),
    type: d.type,
    target: d.target,
    product: d.product,
    device: d.device,
    version: d.version,
    domain: [d.domainHigh, d.domainLow].filter(Boolean).join(', ') || undefined,
    lastSeen: d.lastSeen,
    online,
    state,
    notice: d.notice && { kind: d.notice.kind, message: d.notice.message, code: d.notice.code, params: d.notice.params },
    unconfirmedTo: d.unconfirmed?.tag,
    unsupportedReason: d.unsupported && { message: d.unsupported.reason, code: d.unsupported.code, params: d.unsupported.params },
    step,
  };
}

// The browser interface's server: runs the watcher (finding and flashing devices), tells the page about
// every change over a live connection, and takes its clicks. Only on 127.0.0.1, with a key per start.
export async function startServer(o: ServerOptions): Promise<RunningServer> {
  const p = o.paths;
  const token = randomBytes(24).toString('base64url');
  const devices = new Map<string, DeviceView>();
  const activity: ActivityEntry[] = [];
  const clients = new Set<ServerResponse>();
  let settings: Settings = await loadSettings(p);
  let releases: ReleaseList | undefined;
  let target: VersionedRelease | undefined;
  let problems: StateView['problems'] = {};
  let checking = false;
  let lastScan: string | undefined;
  let nextId = 1;
  let setupSeen = false;

  const send = (event: string, data: unknown) => {
    for (const c of clients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const state = (): StateView => {
    const majors = releases
      ? majorVersions(releases.releases).map((major) => ({ major, tag: targetRelease(releases!.releases, major, settings.releaseCandidates)!.tag }))
      : [];
    const newest = majors[0]?.major;
    return {
      settings: {
        targetMajor: settings.targetMajor,
        autoUpdate: settings.autoUpdate,
        releaseCandidates: settings.releaseCandidates,
        rememberWebFlasher: !!settings.rememberWebFlasher,
      },
      desktop: !!o.desktop,
      appUpdate: o.appUpdates?.view(),
      target: target?.tag,
      majors,
      newerMajor: newest !== undefined && settings.targetMajor !== undefined && newest > settings.targetMajor ? newest : undefined,
      releasesChecked: releases?.checked,
      checking,
      lastScan,
      problems,
      devices: [...devices.values()],
    };
  };

  // many changes come at once (one per device), so the page gets them together
  let pushTimer: ReturnType<typeof setTimeout> | undefined;
  const pushState = () => {
    pushTimer ??= setTimeout(() => {
      pushTimer = undefined;
      send('state', state());
    }, 50);
  };

  const log = (entry: NewEntry) => {
    const full = { id: nextId++, at: new Date().toISOString(), ...entry } as ActivityEntry;
    activity.unshift(full);
    activity.length = Math.min(activity.length, MAX_ACTIVITY);
    send('activity', full);
  };

  const named = (d: KnownDevice) => ({ key: d.key, name: deviceLabel(d) });

  // What a result already says, so the line for the state it leads to is left out: the state a device
  // is expected in next, and devices whose return the result line already reports.
  const expected = new Map<string, WatchState>();
  const backSaid = new Set<string>();
  const leadsTo = (o: FlashOutcome): WatchState => {
    if (o.result === 'done') return 'current';
    if (o.result === 'unconfirmed' || o.result === 'mismatch') return o.result;
    if (o.result === 'stopped' && o.kind === 'unsupported') return 'unsupported';
    if (o.result === 'stopped' && o.kind === 'target') return 'mismatch';
    return 'update';
  };

  const onEvent = (e: WatchEvent) => {
    switch (e.kind) {
      case 'setup':
        if (setupSeen && e.target?.tag !== target?.tag) log({ type: 'target', to: e.target?.tag });
        setupSeen = true;
        settings = e.settings;
        releases = e.releases;
        target = e.target;
        break;
      case 'device': {
        const { device: d, state: now, online, before } = e;
        const to = target?.tag;
        const view = deviceView(d, now, online, devices.get(d.key)?.step);
        const last = devices.get(d.key)?.lastAttempt;
        if (last && now !== 'current') view.lastAttempt = last;
        devices.set(d.key, view);
        if (!before) {
          if (online) log({ ...named(d), type: 'found', version: d.version, state: now, to });
        } else if (online && !before.online) {
          if (!backSaid.delete(d.key)) log({ ...named(d), type: 'back', version: d.version, state: now, to });
        } else if (!online && before.online) log({ ...named(d), type: 'left' });
        // waiting and flashing show on the card; the flash gets its own start line
        else if (now !== before.state && now !== 'flashing' && now !== 'queued' && expected.get(d.key) !== now) {
          log({ ...named(d), type: 'state', state: now, to });
        }
        if (now !== 'flashing' && now !== before?.state) expected.delete(d.key);
        break;
      }
      case 'removed':
        devices.delete(e.key);
        break;
      case 'step': {
        const view = devices.get(e.device.key);
        if (view) view.step = { step: e.step, percent: e.percent };
        if (view && e.step === 'prepare') delete view.lastAttempt;
        if (e.step === 'prepare' && target) log({ ...named(e.device), type: 'start', to: target.tag, from: e.device.version });
        break;
      }
      case 'result': {
        const view = devices.get(e.device.key);
        if (view) delete view.step;
        const failed = e.outcome.result === 'stopped' || e.outcome.result === 'failed' || e.outcome.result === 'wrong-version';
        if (view && failed) view.lastAttempt = { to: e.to, outcome: e.outcome };
        else if (view) delete view.lastAttempt;
        expected.set(e.device.key, leadsTo(e.outcome));
        if (e.later) backSaid.add(e.device.key);
        log({ ...named(e.device), type: 'result', to: e.to, outcome: e.outcome, later: e.later });
        break;
      }
      case 'problem':
        if (e.problem === 'blocked') problems = { ...problems, blocked: e.message !== undefined || undefined };
        else problems = { ...problems, [e.problem]: e.message };
        if (e.message !== undefined && e.problem !== 'download') log({ type: 'problem', problem: e.problem, ...e.message });
        break;
      case 'scanned':
        lastScan = e.at;
        break;
    }
    pushState();
  };

  const watcher = createWatcher(p, onEvent, o.watch);
  o.appUpdates?.onChange(pushState);

  const device = (key: unknown): DeviceView => {
    const d = typeof key === 'string' ? devices.get(key) : undefined;
    if (!d) throw new HttpError(404, 'unknownDevice', 'No such device.');
    return d;
  };

  const routes: Record<string, (req: IncomingMessage) => Promise<unknown>> = {
    'GET /api/state': async () => state(),
    'GET /api/activity': async () => activity,

    'POST /api/settings': async (req) => {
      const b = await body<{ targetMajor: number | null; autoUpdate: boolean; releaseCandidates: boolean; rememberWebFlasher: boolean }>(req);
      const s = await loadSettings(p);
      if (typeof b.autoUpdate === 'boolean') s.autoUpdate = b.autoUpdate;
      if (typeof b.releaseCandidates === 'boolean') s.releaseCandidates = b.releaseCandidates;
      if (typeof b.rememberWebFlasher === 'boolean') s.rememberWebFlasher = b.rememberWebFlasher;
      if (b.targetMajor === null) delete s.targetMajor;
      else if (b.targetMajor !== undefined) {
        const known = releases ? majorVersions(releases.releases) : [];
        if (!Number.isInteger(b.targetMajor) || b.targetMajor < MIN_MAJOR || !known.includes(b.targetMajor)) {
          throw new HttpError(400, 'invalidMajor', `Not a major version with a release: ${b.targetMajor}`);
        }
        s.targetMajor = b.targetMajor;
      }
      await saveSettings(p, s);
      settings = s;
      watcher.refresh();
      pushState();
    },

    'POST /api/prefs': async (req) => {
      const b = await body<PrefsView>(req);
      const s = await loadSettings(p);
      s.ui = { ...s.ui };
      if (typeof b.lang === 'string' && /^[a-z]{2}$/.test(b.lang)) s.ui.lang = b.lang;
      if (b.theme === 'light' || b.theme === 'dark') s.ui.theme = b.theme;
      await saveSettings(p, s);
      settings = s;
    },

    // asks GitHub now, as "releases" in the terminal does
    'POST /api/check': async () => {
      checking = true;
      pushState();
      try {
        await checkReleases(p);
        problems = { ...problems, releases: undefined };
      } finally {
        checking = false;
        watcher.refresh(true);
        pushState();
      }
    },

    'POST /api/devices/update': async (req) => {
      // the state the card showed, so a click lands only on the button that was seen
      const { key, state } = await body<{ key: string; state: WatchState }>(req);
      const d = device(key);
      if (!target) throw new HttpError(400, 'noTarget', 'No target version set.');
      if (!d.online || d.state !== state || (state !== 'update' && state !== 'custom-build')) {
        throw new HttpError(400, 'notFlashable', 'This device cannot be flashed now.');
      }
      watcher.request(d.key, state);
    },

    'POST /api/devices/dismiss': async (req) => {
      const d = device((await body<{ key: string }>(req)).key);
      await updateKnown(p, (list) => list.filter((k) => k.key === d.key).forEach(dismiss));
      watcher.refresh();
    },

    'POST /api/devices/rename': async (req) => {
      const b = await body<{ key: string; name: string }>(req);
      const d = device(b.key);
      if (typeof b.name !== 'string') throw new HttpError(400, 'invalidRequest', 'No name.');
      const { list } = await updateKnown(p, (all) => all.filter((k) => k.key === d.key).forEach((k) => rename(k, b.name as string, MAX_NAME)));
      const k = list.find((x) => x.key === d.key);
      if (k) devices.set(d.key, { ...d, name: k.name, label: deviceLabel(k) });
      pushState();
    },

    'POST /api/devices/forget': async (req) => {
      const d = device((await body<{ key: string }>(req)).key);
      if (d.state === 'flashing') throw new HttpError(409, 'busyDevice', 'The device is being flashed.');
      await updateKnown(p, (list) => {
        const at = list.findIndex((k) => k.key === d.key);
        if (at >= 0) list.splice(at, 1);
      });
      watcher.refresh();
    },

    // downloads the new release and restarts into it; not while a device is flashed, the restart would cut it off
    'POST /api/app-update': async () => {
      const u = o.appUpdates;
      if (!u?.view()?.installable) throw new HttpError(400, 'invalidRequest', 'No update to install.');
      if (watcher.flashing()) throw new HttpError(409, 'flashRunning', 'A device is being flashed.');
      try {
        await u.install();
      } catch (e) {
        console.error(e);
        throw new HttpError(502, 'appUpdateFailed', 'The app update could not be downloaded.');
      }
    },

    'POST /api/open-firmware-folder': async () => {
      await mkdir(p.firmware, { recursive: true });
      openFolder(p.firmware);
    },
  };

  const page = (html: string) => withPageData(html, settings.ui ?? {}, token);

  const serveStatic = async (res: ServerResponse, urlPath: string) => {
    const root = o.staticDir!;
    let file = normalize(join(root, decodeURIComponent(urlPath)));
    if (!file.startsWith(root + sep) && file !== root) throw new HttpError(404, 'invalidRequest', 'Not found.');
    if (!(await stat(file).catch(() => undefined))?.isFile()) file = join(root, 'index.html');
    if (extname(file) !== '.html') {
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(await readFile(file));
      return;
    }
    // without the key, which comes behind # in the address: any program on this computer, also one of
    // another user, can fetch the page; never cached, it carries the stored choices
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
    res.end(withPageData(await readFile(file, 'utf8'), settings.ui ?? {}));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      // only under its own name: another site whose name was pointed at this computer (DNS rebinding)
      // would count as the same site to the browser and could read the key from the page
      if (!LOCAL_NAMES.includes(hostName(req.headers.host))) throw new HttpError(403, 'invalidRequest', 'Wrong host.');
      if (url.pathname.startsWith('/api/') && (req.headers[TOKEN_HEADER] ?? url.searchParams.get('token')) !== token) {
        throw new HttpError(403, 'invalidRequest', 'Wrong key.');
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        clients.add(res);
        req.on('close', () => clients.delete(res));
        res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
        return;
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) return json(res, (await route(req)) ?? { ok: true });
      if (url.pathname.startsWith('/api/') || !o.staticDir) throw new HttpError(404, 'invalidRequest', 'Not found.');
      await serveStatic(res, url.pathname);
    } catch (e) {
      // the user's to fix: coded errors and AppErrors (their message is meant for the user); else a bug
      if (e instanceof HttpError) return json(res, { error: e.message, code: e.code }, e.status);
      if (e instanceof AppError) return json(res, { error: e.message }, 400);
      json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, '127.0.0.1', resolve);
  });
  watcher.start();
  const address = server.address();
  const url = `http://localhost:${typeof address === 'object' && address ? address.port : o.port}`;
  return {
    url,
    token,
    open: `${url}/#${TOKEN_HASH}=${token}`,
    page,
    flashing: watcher.flashing,
    close: async () => {
      for (const c of clients) c.end();
      server.close();
      await watcher.stop();
    },
  };
}
