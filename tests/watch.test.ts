import { describe, expect, it } from 'vitest';
import type { Device } from '../src/core/discovery.ts';
import { AppError } from '../src/core/errors.ts';
import type { FlashPlan, FlashResult } from '../src/core/flash.ts';
import { loadKnown, updateKnown, dismiss } from '../src/core/known.ts';
import { paths } from '../src/core/paths.ts';
import { saveSettings, type Settings } from '../src/core/settings.ts';
import { createWatcher, type WatchEvent } from '../src/core/watch.ts';
import { tempDir } from './helpers.ts';

const RELEASES = ['4.1.0', '4.0.1', '3.6.4'].map((tag) => ({ tag, prerelease: false, published: '2026-07-17T00:00:00Z' }));
const rx = (mac: string, version = '4.0.1', more: Partial<Device> = {}): Device => ({
  ip: `192.168.1.${parseInt(mac.slice(-2), 16)}`,
  mac,
  via: ['mdns'],
  type: 'rx',
  product: 'RadioMaster RP4TD True Diversity 2.4GHz RX',
  target: 'UNIFIED_ESP32_2400_RX',
  version,
  ...more,
});

// A watcher on a clock that only moves when told, with the network, releases and flashing faked:
// `found` is what every scan sees, `results` what the next flashes end with (default done). A device
// flashed with "done" reports the new version from then on, one with "unconfirmed" is gone.
async function watcher(settings: Partial<Settings> = {}) {
  const p = paths(await tempDir());
  await saveSettings(p, { autoUpdate: true, releaseCandidates: false, targetMajor: 4, ...settings });
  let t = Date.UTC(2026, 9, 25, 12, 0);
  const s = {
    p,
    found: [] as Device[],
    results: [] as (FlashResult | AppError)[],
    flashed: [] as string[],
    events: [] as WatchEvent[],
    // two ticks, each scanning, taking in what was found and starting a flash when one is due
    async round(minutes = 0) {
      t += minutes * 60_000;
      await w.tick();
      await w.settled();
      await w.tick();
      await w.settled();
    },
    states: (mac: string) =>
      s.events.flatMap((e) => (e.kind === 'device' && e.device.key === mac ? [e.online ? e.state : `offline ${e.state}`] : [])),
    outcomes: () => s.events.flatMap((e) => (e.kind === 'result' ? [`${e.device.key} ${e.outcome.result}${e.later ? ' later' : ''}`] : [])),
  };
  const w = createWatcher(p, (e) => s.events.push(e), {
    now: () => t,
    scanEveryMs: 0,
    scan: async () => ({ devices: s.found, asked: 254, unreachable: 0 }),
    releases: async () => ({ list: { checked: new Date(t).toISOString(), releases: RELEASES } }),
    prepare: async (ip, tag, _onDownload, manual) => {
      s.flashed.push(`${ip} ${tag}${manual ? ' by hand' : ''}`);
      const next = s.results[0];
      if (next instanceof AppError) throw s.results.shift();
      return { ip } as FlashPlan;
    },
    run: async (plan, onStep) => {
      onStep('upload');
      onStep('reboot');
      const r = (s.results.shift() as FlashResult | undefined) ?? { result: 'done', version: '4.1.0' };
      if (r.result === 'done') s.found = s.found.map((d) => (d.ip === plan.ip ? { ...d, version: r.version } : d));
      if (r.result === 'unconfirmed') s.found = s.found.filter((d) => d.ip !== plan.ip);
      return r;
    },
  });
  return Object.assign(s, { w });
}

describe('watcher', () => {
  it('only shows updates while auto update is off', async () => {
    const s = await watcher({ autoUpdate: false });
    s.found = [rx('A1')];
    await s.round();
    await s.round(1);
    expect(s.flashed).toEqual([]);
    expect(s.states('A1')).toEqual(['update']);
    expect(s.events.find((e) => e.kind === 'setup')).toMatchObject({ settings: { autoUpdate: false }, target: { tag: '4.1.0' } });
  });

  it('flashes devices with an update one at a time, in the order they got it, and remembers them', async () => {
    const s = await watcher();
    s.found = [rx('A1')];
    await s.round();
    s.found.push(rx('A2'));
    expect(s.flashed).toEqual(['192.168.1.161 4.1.0']);
    await s.round();
    expect(s.flashed).toEqual(['192.168.1.161 4.1.0', '192.168.1.162 4.1.0']);
    expect(s.states('A1')).toEqual(['queued', 'flashing', 'current']);
    expect(s.states('A2')).toEqual(['queued', 'flashing', 'current']);
    expect(s.outcomes()).toEqual(['A1 done', 'A2 done']);
    // A2 starts only after A1 has ended
    const at = (key: string, kind: string) =>
      s.events.findIndex((e) => (e.kind === 'device' && e.state === kind) || (e.kind === 'result' && kind === 'result') ? e.device.key === key : false);
    expect(at('A2', 'flashing')).toBeGreaterThan(at('A1', 'result'));
    expect((await loadKnown(s.p)).map((d) => [d.key, d.version])).toEqual([
      ['A1', '4.1.0'],
      ['A2', '4.1.0'],
    ]);
    const steps = s.events.flatMap((e) => (e.kind === 'step' && e.device.key === 'A1' ? [e.step] : []));
    expect(steps).toEqual(['prepare', 'upload', 'reboot']);
  });

  it('never flashes own builds, newer devices or without a target version', async () => {
    const s = await watcher();
    s.found = [rx('B1', 'master'), rx('B2', '4.1.1'), rx('B3', '4.1.0')];
    await s.round();
    expect(s.flashed).toEqual([]);
    expect([s.states('B1'), s.states('B2'), s.states('B3')]).toEqual([['custom-build'], ['newer'], ['current']]);

    const none = await watcher({ targetMajor: undefined });
    none.found = [rx('B4')];
    await none.round();
    expect(none.flashed).toEqual([]);
    expect(none.states('B4')).toEqual(['no-target-version']);
  });

  it('tries again after a pause, stops after three failed attempts and starts again once dismissed', async () => {
    const s = await watcher();
    s.found = [rx('C1')];
    s.results = [
      { result: 'failed', message: 'connection lost' },
      { result: 'wrong-version', version: '4.0.1' },
      { result: 'failed', message: 'connection lost (ECONNRESET)' },
    ];
    await s.round();
    await s.round();
    expect(s.flashed).toHaveLength(1); // waits before trying again
    await s.round(1);
    await s.round(1);
    expect(s.flashed).toHaveLength(3);
    await s.round(5);
    expect(s.flashed).toHaveLength(3);
    expect(s.states('C1').at(-1)).toBe('failed');
    expect((await loadKnown(s.p))[0]!.notice).toMatchObject({ kind: 'failed', message: 'connection lost (ECONNRESET)' });

    await updateKnown(s.p, (list) => dismiss(list[0]!));
    await s.round();
    expect(s.flashed).toHaveLength(4);
    expect(s.outcomes().at(-1)).toBe('C1 done');
  });

  it('never tries again after a refused target, nor for a version that cannot be flashed onto a device', async () => {
    const s = await watcher();
    s.found = [rx('D1'), rx('D2')];
    s.results = [{ result: 'mismatch', message: 'Current target: X.' }, new AppError('This version has no firmware for "X"', 'unsupported')];
    await s.round();
    await s.round();
    await s.round(10);
    expect(s.flashed).toEqual(['192.168.1.209 4.1.0', '192.168.1.210 4.1.0']);
    expect(s.states('D1').at(-1)).toBe('mismatch');
    expect(s.states('D2').at(-1)).toBe('unsupported');
  });

  it('pauses after a failed download without counting it against the device', async () => {
    const s = await watcher();
    s.found = [rx('E1')];
    s.results = [new AppError('No connection to the ExpressLRS download server.', 'download')];
    await s.round();
    await s.round();
    expect(s.flashed).toHaveLength(1);
    expect(s.events).toContainEqual({ kind: 'problem', problem: 'download', message: { message: 'No connection to the ExpressLRS download server.' } });
    await s.round(1);
    expect(s.flashed).toHaveLength(2);
    expect((await loadKnown(s.p))[0]!.failures).toBeUndefined();
  });

  it('waits for a device not seen after its flash and confirms it once it is back', async () => {
    const s = await watcher();
    s.found = [rx('F1')];
    s.results = [{ result: 'unconfirmed' }];
    await s.round();
    await s.round(3);
    expect(s.states('F1')).toEqual(['queued', 'flashing', 'unconfirmed', 'offline unconfirmed']);
    s.found = [rx('F1', '4.1.0')];
    await s.round(30);
    expect(s.states('F1').at(-1)).toBe('current');
    expect(s.outcomes()).toEqual(['F1 unconfirmed', 'F1 done later']);
    expect(s.flashed).toHaveLength(1);
  });

  it('flashes a device asked for by hand with auto update off, an own build too, but nothing else', async () => {
    const s = await watcher({ autoUpdate: false });
    s.found = [rx('A1'), rx('B1', 'master'), rx('B3', '4.1.0')];
    await s.round();
    s.w.request('B1');
    s.w.request('B3');
    await s.round();
    expect(s.flashed).toEqual(['192.168.1.177 4.1.0 by hand']);
    s.w.request('A1');
    await s.round();
    expect(s.flashed).toEqual(['192.168.1.177 4.1.0 by hand', '192.168.1.161 4.1.0 by hand']);
    await s.round(1);
    expect(s.flashed).toHaveLength(2);
  });

  it('reports a forgotten device as removed', async () => {
    const s = await watcher({ autoUpdate: false });
    s.found = [rx('A1')];
    await s.round();
    s.found = [];
    await updateKnown(s.p, (list) => list.splice(0));
    await s.round();
    expect(s.events).toContainEqual({ kind: 'removed', key: 'A1' });
  });

  it('does not flash a device that left the network, and shows it again when it is back', async () => {
    const s = await watcher({ autoUpdate: false });
    s.found = [rx('0A')];
    await s.round();
    s.found = [];
    await s.round(3);
    await saveSettings(s.p, { autoUpdate: true, releaseCandidates: false, targetMajor: 4 });
    await s.round(1);
    expect(s.flashed).toEqual([]);
    expect(s.states('0A')).toEqual(['update', 'offline update']);
    s.found = [rx('0A')];
    await s.round();
    expect(s.flashed).toHaveLength(1);
    expect(s.events.filter((e) => e.kind === 'setup')).toHaveLength(2);
  });

  it('drops the hint on a blocked network as soon as a device answers over mDNS', async () => {
    const p = paths(await tempDir());
    await saveSettings(p, { autoUpdate: false, releaseCandidates: false, targetMajor: 4 });
    const events: WatchEvent[] = [];
    let announce: (d: Device) => void = () => {};
    const w = createWatcher(p, (e) => events.push(e), {
      scanEveryMs: 60_000,
      tickMs: 10,
      recheckAfterMs: 10,
      browse: (cb) => ((announce = cb), { stop() {} }),
      scan: async () => ({ devices: [], asked: 254, unreachable: 254 }),
      releases: async () => ({ list: { checked: '2026-10-25T12:00:00Z', releases: RELEASES } }),
    });
    const blocked = () => events.filter((e) => e.kind === 'problem' && e.problem === 'blocked').map((e) => e.kind === 'problem' && !!e.message);
    w.start();
    for (let i = 0; i < 100 && !blocked().length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(blocked()).toEqual([true]);
    announce(rx('A1'));
    expect(blocked()).toEqual([true, false]);
    await w.stop();
  });

  it('shows the hint on a blocked network only when the scan soon after looks blocked as well', async () => {
    const p = paths(await tempDir());
    await saveSettings(p, { autoUpdate: false, releaseCandidates: false, targetMajor: 4 });
    const run = async (open: boolean[]) => {
      const events: WatchEvent[] = [];
      let scans = 0;
      const w = createWatcher(p, (e) => events.push(e), {
        scanEveryMs: 60_000,
        tickMs: 10,
        recheckAfterMs: 10,
        browse: () => ({ stop() {} }),
        scan: async () => ({ devices: [], asked: 254, unreachable: open[scans++] ?? true ? 0 : 254 }),
        releases: async () => ({ list: { checked: '2026-10-25T12:00:00Z', releases: RELEASES } }),
      });
      w.start();
      for (let i = 0; i < 100 && scans < open.length; i++) await new Promise((r) => setTimeout(r, 10));
      await w.stop();
      return { scans, blocked: events.filter((e) => e.kind === 'problem' && e.problem === 'blocked').map((e) => e.kind === 'problem' && !!e.message) };
    };
    // turned away right after the start, open on the second look: no hint
    expect(await run([false, true])).toEqual({ scans: 2, blocked: [] });
    // blocked twice: the hint shows
    expect(await run([false, false])).toEqual({ scans: 2, blocked: [true] });
  });
});
