import { mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Device } from '../src/core/discovery.ts';
import { AppError } from '../src/core/errors.ts';
import type { FlashPlan } from '../src/core/flash.ts';
import { loadKnown, updateKnown } from '../src/core/known.ts';
import { paths } from '../src/core/paths.ts';
import { loadSettings, saveSettings } from '../src/core/settings.ts';
import { TOKEN_HEADER, type ActivityEntry, type AppUpdateView, type StateView } from '../src/server/api.ts';
import { startServer, type AppUpdates, type RunningServer } from '../src/server/server.ts';
import { tempDir } from './helpers.ts';

const RELEASES = ['4.1.0', '4.0.1', '3.6.4'].map((tag) => ({ tag, prerelease: false, published: '2026-07-17T00:00:00Z' }));
const rx = (mac: string, version: string): Device => ({
  ip: `192.168.1.${parseInt(mac, 16)}`,
  mac,
  via: ['mdns'],
  type: 'rx',
  product: 'RadioMaster RP1 2.4GHz RX',
  target: 'UNIFIED_ESP8285_2400_RX',
  version,
});

const servers: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

// A server on a free port whose watcher sees `found` and flashes nothing for real.
async function server(found: Device[], opts: { staticDir?: string; licensesFile?: string; gone?: Set<string>; desktop?: boolean; appUpdates?: AppUpdates } = {}) {
  const p = paths(await tempDir());
  await saveSettings(p, { autoUpdate: false, releaseCandidates: false, targetMajor: 4, ui: { lang: 'de' } });
  const flashed: string[] = [];
  const s = await startServer({
    paths: p,
    port: 0,
    staticDir: opts.staticDir,
    licensesFile: opts.licensesFile,
    desktop: opts.desktop,
    appUpdates: opts.appUpdates,
    watch: {
      browse: () => ({ stop() {} }),
      scan: async () => ({ devices: found, asked: 254, unreachable: 0 }),
      releases: async () => ({ list: { checked: '2026-10-25T12:00:00Z', releases: RELEASES } }),
      prepare: async (ip) => {
        if (opts.gone?.delete(ip)) throw new AppError(`No ELRS device answers at ${ip}.`, 'gone');
        flashed.push(ip);
        return { ip } as FlashPlan;
      },
      // the device then reports the new version
      run: async (plan) => {
        found.forEach((d) => d.ip === plan.ip && (d.version = '4.1.0'));
        return { result: 'done', version: '4.1.0' };
      },
      tickMs: 20,
      scanEveryMs: 20,
    },
  });
  servers.push(s);
  const api = async <T>(method: 'GET' | 'POST', path: string, body?: unknown, token = s.token) => {
    const res = await fetch(`${s.url}${path}`, {
      method,
      headers: { [TOKEN_HEADER]: token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as T };
  };
  // the state once `test` holds for it
  const until = async (test: (st: StateView) => boolean): Promise<StateView> => {
    for (let i = 0; i < 200; i++) {
      const { data } = await api<StateView>('GET', '/api/state');
      if (test(data)) return data;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('state never reached');
  };
  return { s, p, api, until, flashed };
}

describe('server', () => {
  it('turns away requests without this start’s key', async () => {
    const { api } = await server([]);
    expect((await api('GET', '/api/state', undefined, 'wrong')).status).toBe(403);
    expect((await api('GET', '/api/state')).status).toBe(200);
  });

  it('shows found devices with their state, the target version and the major versions to choose from', async () => {
    const { until } = await server([rx('0A', '4.0.1')]);
    const st = await until((x) => x.devices.length === 1);
    expect(st).toMatchObject({
      settings: { targetMajor: 4, autoUpdate: false },
      target: '4.1.0',
      majors: [
        { major: 4, tag: '4.1.0' },
        { major: 3, tag: '3.6.4' },
      ],
      devices: [{ key: '0A', ip: '192.168.1.10', state: 'update', online: true, product: 'RadioMaster RP1 2.4GHz RX' }],
    });
  });

  it('flashes a device on its button, logs it, and refuses devices that cannot be flashed', async () => {
    const { api, until, flashed } = await server([rx('0A', '4.0.1'), rx('0B', '4.1.0')]);
    await until((x) => x.devices.length === 2);
    expect((await api('POST', '/api/devices/update', { key: '0B', state: 'current' })).data).toMatchObject({ code: 'notFlashable' });
    expect((await api('POST', '/api/devices/update', { key: 'nope', state: 'update' })).status).toBe(404);
    // the button of an own build on a device that shows an update now
    expect((await api('POST', '/api/devices/update', { key: '0A', state: 'custom-build' })).data).toMatchObject({ code: 'notFlashable' });
    expect((await api('POST', '/api/devices/update', { key: '0A', state: 'update' })).status).toBe(200);
    await until((x) => x.devices.find((d) => d.key === '0A')?.state === 'current');
    expect(flashed).toEqual(['192.168.1.10']);
    const { data: activity } = await api<ActivityEntry[]>('GET', '/api/activity');
    expect(activity.find((a) => a.type === 'result')).toMatchObject({ key: '0A', outcome: { result: 'done', version: '4.1.0' } });
    // one line each for found, start and result: no steps, and no "up to date" after "done"
    const lines = activity.filter((a) => a.key === '0A').reverse();
    expect(lines.map((a) => a.type)).toEqual(['found', 'start', 'result']);
    expect(lines[0]).toMatchObject({ state: 'update', to: '4.1.0', name: 'RadioMaster RP1 2.4GHz RX · 0A' });
    expect(lines[1]).toMatchObject({ to: '4.1.0', from: '4.0.1' });
  });

  it('shows a stopped attempt on the device until the next one', async () => {
    const { api, until } = await server([rx('0A', '4.0.1')], { gone: new Set(['192.168.1.10']) });
    await until((x) => x.devices.length === 1);
    await api('POST', '/api/devices/update', { key: '0A', state: 'update' });
    const st = await until((x) => x.devices[0]?.lastAttempt !== undefined && x.devices[0].state === 'update');
    expect(st.devices[0]!.lastAttempt).toEqual({ to: '4.1.0', outcome: { result: 'stopped', message: 'No ELRS device answers at 192.168.1.10.', kind: 'gone' } });
    await api('POST', '/api/devices/update', { key: '0A', state: 'update' });
    expect((await until((x) => x.devices[0]?.state === 'current')).devices[0]!.lastAttempt).toBeUndefined();
  });

  it('changes settings, keeps only major versions with a release, and keeps language and theme', async () => {
    const { api, p, until } = await server([]);
    await until((x) => x.majors.length > 0);
    expect((await api('POST', '/api/settings', { targetMajor: 9 })).data).toMatchObject({ code: 'invalidMajor' });
    expect((await api('POST', '/api/settings', { autoUpdate: true, targetMajor: 3 })).status).toBe(200);
    await api('POST', '/api/prefs', { theme: 'dark', lang: 'not a language' });
    expect(await loadSettings(p)).toMatchObject({ autoUpdate: true, targetMajor: 3, ui: { lang: 'de', theme: 'dark' } });
    await until((x) => x.target === '3.6.4');
    // a new target version gets its own line, the first one at the start does not
    const targets = async () => (await api<ActivityEntry[]>('GET', '/api/activity')).data.filter((a) => a.type === 'target');
    expect(await targets()).toMatchObject([{ to: '3.6.4' }]);
    await api('POST', '/api/settings', { targetMajor: null });
    expect((await loadSettings(p)).targetMajor).toBeUndefined();
  });

  it('sends the open source licenses from the build, or says they are missing', async () => {
    const file = join(await tempDir(), 'THIRD_PARTY_LICENSES.txt');
    const { api } = await server([], { licensesFile: file });
    expect((await api('GET', '/api/licenses')).data).toMatchObject({ code: 'licensesMissing' });
    await writeFile(file, 'THIRD-PARTY SOFTWARE NOTICES\n');
    expect(await api('GET', '/api/licenses')).toEqual({ status: 200, data: { text: 'THIRD-PARTY SOFTWARE NOTICES\n' } });
  });

  it('gives a device its own name, shown with its Lua name', async () => {
    const { api, p, until } = await server([{ ...rx('0A', '4.1.0'), device: 'RM RP1' }]);
    await until((x) => x.devices.length === 1);
    expect((await api('POST', '/api/devices/rename', { key: '0A', name: ' Wing ' })).status).toBe(200);
    expect((await until((x) => x.devices[0]?.name === 'Wing')).devices[0]!.label).toBe('Wing (RM RP1)');
    expect((await loadKnown(p))[0]!.name).toBe('Wing');
    expect((await api('POST', '/api/devices/rename', { key: '0A' })).status).toBe(400);
    await api('POST', '/api/devices/rename', { key: '0A', name: '' });
    expect((await until((x) => x.devices[0]?.name === undefined)).devices[0]!.label).toBe('RM RP1 · 0A');
  });

  it('dismisses a notice and forgets a device', async () => {
    const found = [rx('0A', '4.0.1')];
    const { api, p, until } = await server(found);
    await until((x) => x.devices.length === 1);
    found.length = 0; // quiet from here on, so the watcher does not write devices.json meanwhile
    await new Promise((r) => setTimeout(r, 100));
    await updateKnown(p, (list) => {
      list[0]!.notice = { kind: 'failed', message: 'connection lost', at: '2026-10-25T12:00:00Z' };
    });
    await until((x) => x.devices[0]?.state === 'failed');
    await api('POST', '/api/devices/dismiss', { key: '0A' });
    await until((x) => x.devices[0]?.state === 'update');
    await api('POST', '/api/devices/forget', { key: '0A' });
    expect(await loadKnown(p)).toEqual([]);
  });

  it('tells the page whether it runs in the desktop app and keeps whether the Web Flasher remembers entries', async () => {
    const browser = await server([]);
    expect((await browser.until(() => true)).desktop).toBe(false);
    const { api, p, until } = await server([], { desktop: true });
    expect(await until(() => true)).toMatchObject({ desktop: true, settings: { rememberWebFlasher: false } });
    await api('POST', '/api/settings', { rememberWebFlasher: true });
    expect((await loadSettings(p)).rememberWebFlasher).toBe(true);
    await until((x) => x.settings.rememberWebFlasher);
  });

  it('shows a newer app release and installs it only where the app can', async () => {
    let view: AppUpdateView | undefined;
    let changed = () => {};
    let installs = 0;
    const appUpdates: AppUpdates = {
      view: () => view,
      onChange: (fn) => (changed = fn),
      install: async () => {
        installs++;
        if (installs === 2) throw new Error('offline');
      },
    };
    const { api, until } = await server([], { desktop: true, appUpdates });
    expect((await api('POST', '/api/app-update')).status).toBe(400);
    view = { version: '0.2.0', url: 'https://example.com', installable: false };
    changed();
    expect((await until((x) => x.appUpdate !== undefined)).appUpdate).toEqual(view);
    expect((await api('POST', '/api/app-update')).status).toBe(400);
    view = { ...view, installable: true };
    expect((await api('POST', '/api/app-update')).status).toBe(200);
    expect((await api('POST', '/api/app-update')).data).toMatchObject({ code: 'appUpdateFailed' });
    expect(installs).toBe(2);
  });

  it('serves the page with the stored choices but without the key, which comes behind # in the address', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<html><head></head><body></body></html>');
    const { s } = await server([], { staticDir: dir });
    const res = await fetch(`${s.url}/devices`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).not.toContain(s.token);
    expect(html).toContain('&quot;lang&quot;:&quot;de&quot;');
    expect(s.open).toBe(`${s.url}/#token=${s.token}`);
    // under Vite in development the key is put into the page
    expect(s.page('<head></head>')).toContain(`content="${s.token}"`);
    expect((await fetch(`${s.url}/../../etc/passwd`)).status).not.toBe(500);
  });

  it('keeps other sites from showing the page in a frame and limits what the page loads', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'index.html'), '<html><head></head><body></body></html>');
    const { s } = await server([], { staticDir: dir });
    for (const path of ['/', '/api/state', '/api/nothing']) {
      const res = await fetch(`${s.url}${path}`, { headers: { [TOKEN_HEADER]: s.token } });
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      const csp = res.headers.get('content-security-policy');
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("script-src 'self';");
      expect(csp).toContain('frame-src https://expresslrs.github.io;');
    }
  });

  it('answers only under its own name, so another site pointed at this computer cannot read the key', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'index.html'), '<html><head></head><body></body></html>');
    const { s } = await server([], { staticDir: dir });
    const port = new URL(s.url).port;
    // fetch keeps the Host header to itself, node:http sends the one given
    const get = (path: string, host: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, headers: { host, [TOKEN_HEADER]: s.token } }, (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, 'localhost:5173']) {
      expect((await get('/', host)).status).toBe(200);
      expect((await get('/api/activity', host)).status).toBe(200);
    }
    for (const host of [`evil.example:${port}`, `127.0.0.1.evil.example:${port}`, 'evil.example']) {
      const page = await get('/', host);
      expect(page.status).toBe(403);
      expect(page.body).not.toContain(s.token);
      expect((await get('/api/activity', host)).status).toBe(403);
    }
  });
});
