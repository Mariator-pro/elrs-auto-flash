import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Device } from '../src/core/discovery.ts';
import { AppError } from '../src/core/errors.ts';
import {
  dismiss,
  findKnown,
  knownState,
  loadKnown,
  MAX_FAILURES,
  recordError,
  recordResult,
  rename,
  seen,
  STALE_MS,
  updateKnown,
  type KnownDevice,
} from '../src/core/known.ts';
import { paths, writeJson } from '../src/core/paths.ts';
import { targetRelease } from '../src/core/releases.ts';
import { deviceLabel } from '../src/server/api.ts';
import { tempDir } from './helpers.ts';

const RP4TD = 'RadioMaster RP4TD True Diversity 2.4GHz RX';
const dev = (o: Partial<Device>): Device => ({ ip: '192.168.1.50', via: ['scan'], product: RP4TD, target: 'UNIFIED_ESP32_2400_RX', version: '4.0.1', ...o });
const target = (tag: string) => targetRelease([{ tag, prerelease: false, published: '2026-07-17T00:00:00Z' }], Number(tag[0]), false);
const at = (min: number) => new Date(Date.UTC(2026, 9, 25, 12, min));

describe('seen', () => {
  it('keeps a device by its MAC and follows it to a new address', () => {
    const list: KnownDevice[] = [];
    expect(seen(list, dev({ mac: 'A1B2C3D4E5F6', via: ['mdns'] }), at(0)).isNew).toBe(true);
    const again = seen(list, dev({ ip: '192.168.1.77', mac: 'A1B2C3D4E5F6', domainHigh: 'ISM2G4' }), at(5));
    expect(again.isNew).toBe(false);
    expect(list).toEqual([
      expect.objectContaining({ key: 'A1B2C3D4E5F6', ip: '192.168.1.77', mac: 'A1B2C3D4E5F6', domainHigh: 'ISM2G4', lastSeen: at(5).toISOString() }),
    ]);
  });

  it('keeps a device found only by the scan under its address and takes it over once its MAC shows up', () => {
    const list: KnownDevice[] = [];
    seen(list, dev({}), at(0));
    expect(list[0]!.key).toBe('192.168.1.50');
    seen(list, dev({ mac: 'A1B2C3D4E5F6', via: ['mdns'] }), at(1));
    expect(list.map((d) => d.key)).toEqual(['A1B2C3D4E5F6']);
    // later scans without MAC still find it by its address
    expect(seen(list, dev({ version: '4.1.0' }), at(2)).isNew).toBe(false);
    expect(list).toHaveLength(1);
    expect(list[0]!.version).toBe('4.1.0');
  });

  it('takes another product at a known address for another device', () => {
    const list: KnownDevice[] = [];
    seen(list, dev({ mac: 'A1B2C3D4E5F6' }), at(0));
    expect(seen(list, dev({ product: 'RadioMaster RP1 2.4GHz RX' }), at(1)).isNew).toBe(true);
    expect(list.map((d) => d.key)).toEqual(['A1B2C3D4E5F6', '192.168.1.50']);
  });

  it('confirms an unconfirmed flash when the device is back with the new version, else counts a failure', () => {
    const list: KnownDevice[] = [];
    const { device } = seen(list, dev({ mac: 'A' }), at(0));
    recordResult(device, '4.1.0', { result: 'unconfirmed' }, at(1));
    expect(knownState(device, target('4.1.0'))).toBe('unconfirmed');
    expect(seen(list, dev({ mac: 'A', version: '4.1.0' }), at(9)).confirmed).toEqual({ to: '4.1.0', result: { result: 'done', version: '4.1.0' } });
    expect(knownState(device, target('4.1.0'))).toBe('current');

    recordResult(device, '4.1.1', { result: 'unconfirmed' }, at(10));
    expect(seen(list, dev({ mac: 'A', version: '4.1.0' }), at(19)).confirmed).toEqual({
      to: '4.1.1',
      result: { result: 'wrong-version', version: '4.1.0' },
    });
    expect(device.failures).toEqual({ tag: '4.1.1', count: 1 });
    expect(knownState(device, target('4.1.1'))).toBe('update');
  });

  it('leaves the old version right after the upload for a later sighting, the new one confirms at once', () => {
    const list: KnownDevice[] = [];
    const { device } = seen(list, dev({ mac: 'A' }), at(0));
    const upload = at(1);
    recordResult(device, '4.1.0', { result: 'unconfirmed', check: 'later' }, upload);
    const soon = new Date(upload.getTime() + STALE_MS - 1000);
    expect(seen(list, dev({ mac: 'A', version: '4.0.1' }), soon).confirmed).toBeUndefined();
    expect(device.failures).toBeUndefined();
    expect(knownState(device, target('4.1.0'))).toBe('unconfirmed');
    expect(seen(list, dev({ mac: 'A', version: '4.1.0' }), soon).confirmed).toEqual({ to: '4.1.0', result: { result: 'done', version: '4.1.0' } });

    recordResult(device, '4.1.1', { result: 'unconfirmed', check: 'later' }, upload);
    const later = new Date(upload.getTime() + STALE_MS);
    expect(seen(list, dev({ mac: 'A', version: '4.1.0' }), later).confirmed?.result).toEqual({ result: 'wrong-version', version: '4.1.0' });
  });
});

describe('results', () => {
  it(`stops after ${MAX_FAILURES} failed attempts at one version until dismissed; a new version starts counting anew`, () => {
    const d: KnownDevice = { key: 'A', ip: '1.2.3.4', version: '4.0.1', lastSeen: at(0).toISOString() };
    recordResult(d, '4.1.0', { result: 'failed', message: 'connection lost' });
    recordResult(d, '4.1.0', { result: 'wrong-version', version: '4.0.1' });
    expect(knownState(d, target('4.1.0'))).toBe('update');
    recordResult(d, '4.1.0', { result: 'failed', message: 'connection lost (ECONNRESET)' });
    expect(knownState(d, target('4.1.0'))).toBe('failed');
    expect(d.notice).toMatchObject({ kind: 'failed', message: 'connection lost (ECONNRESET)' });
    dismiss(d);
    expect(knownState(d, target('4.1.0'))).toBe('update');
    expect(d.failures).toBeUndefined();

    recordResult(d, '4.1.0', { result: 'failed', message: 'x' });
    recordResult(d, '4.1.0', { result: 'failed', message: 'x' });
    recordResult(d, '4.1.1', { result: 'failed', message: 'x' });
    expect(d.failures).toEqual({ tag: '4.1.1', count: 1 });
    recordResult(d, '4.1.1', { result: 'done', version: '4.1.1' });
    expect(d.failures).toBeUndefined();
    expect(knownState(d, target('4.1.1'))).toBe('current');
  });

  it('marks a refused target at once, and an own check that failed the same way', () => {
    const d: KnownDevice = { key: 'A', ip: '1.2.3.4', version: '4.0.1', lastSeen: at(0).toISOString() };
    recordResult(d, '4.1.0', { result: 'mismatch', message: 'Current target: X. Uploaded image: Y.' });
    expect(knownState(d, target('4.1.0'))).toBe('mismatch');
    dismiss(d);
    recordError(d, '4.1.0', new AppError('The firmware file does not carry the target', 'target'));
    expect(knownState(d, target('4.1.0'))).toBe('mismatch');
  });

  it('keeps a version that cannot be flashed onto a device as unsupported for that version only', () => {
    const d: KnownDevice = { key: 'A', ip: '1.2.3.4', version: '4.0.1', lastSeen: at(0).toISOString() };
    recordError(d, '4.1.0', new AppError('This version has no firmware for "X"', 'unsupported'));
    recordError(d, '4.1.0', new AppError('No ELRS device answers', 'gone'));
    expect(knownState(d, target('4.1.0'))).toBe('unsupported');
    expect(knownState(d, target('4.1.1'))).toBe('update');
  });
});

describe('devices.json', () => {
  it('is written and read back, keeps no options and skips broken entries', async () => {
    const p = paths(await tempDir());
    expect(await loadKnown(p)).toEqual([]);
    await updateKnown(p, (list) => {
      seen(list, { ...dev({ mac: 'A' }), options: { 'wifi-password': 'secret' } } as Device, at(0));
    });
    expect(await readFile(p.devices, 'utf8')).not.toContain('secret');
    expect((await loadKnown(p)).map((d) => d.key)).toEqual(['A']);
    await writeJson(p.devices, [{ key: 'B' }, ...(await loadKnown(p))]);
    expect((await loadKnown(p)).map((d) => d.key)).toEqual(['A']);
    await writeJson(p.devices, { not: 'a list' });
    expect(await loadKnown(p)).toEqual([]);
  });

  it('keeps an own name, cleaned up and cut short, and keeps it when the device is seen again', () => {
    const list: KnownDevice[] = [];
    const { device } = seen(list, dev({ mac: 'A1B2C3D4E5F6', device: 'RM RP4TD 2400' }), at(0));
    expect(deviceLabel(device)).toBe('RM RP4TD 2400 · E5F6');
    rename(device, '  5 inch\nfreestyle \t ', 40);
    expect(device.name).toBe('5 inch freestyle');
    seen(list, dev({ mac: 'A1B2C3D4E5F6', device: 'RM RP4TD 2400' }), at(1));
    expect(deviceLabel(device)).toBe('5 inch freestyle (RM RP4TD 2400)');
    expect(findKnown(list, '5 Inch Freestyle')).toHaveLength(1);
    rename(device, 'x'.repeat(50), 40);
    expect(device.name).toHaveLength(40);
    rename(device, '   ', 40);
    expect(device.name).toBeUndefined();
    expect(deviceLabel({ ip: '1.2.3.4' })).toBe('1.2.3.4');
    expect(deviceLabel({ ip: '1.2.3.4', product: 'Some RX' })).toBe('Some RX');
  });

  it('finds devices by address, MAC with or without colons, Lua name or product name', () => {
    const list: KnownDevice[] = [];
    seen(list, dev({ mac: 'A1B2C3D4E5F6', device: 'RM RP4TD 2400' }), at(0));
    seen(list, dev({ ip: '192.168.1.60', mac: '112233445566', product: 'RadioMaster RP1 2.4GHz RX' }), at(0));
    expect(findKnown(list, '192.168.1.60').map((d) => d.key)).toEqual(['112233445566']);
    expect(findKnown(list, 'a1:b2:c3:d4:e5:f6').map((d) => d.key)).toEqual(['A1B2C3D4E5F6']);
    expect(findKnown(list, 'rm rp4td 2400')).toHaveLength(1);
    expect(findKnown(list, 'radiomaster rp1 2.4ghz rx')).toHaveLength(1);
    expect(findKnown(list, 'nothing')).toEqual([]);
  });
});
