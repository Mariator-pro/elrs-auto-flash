import { mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { archivePath } from '../src/core/archive.ts';
import { uploadFirmware } from '../src/core/device.ts';
import { prepareFlash, runFlash } from '../src/core/flash.ts';
import { paths, type Paths } from '../src/core/paths.ts';
import { fakeDevice, tempDir, testArchive } from './helpers.ts';

const OPTIONS = {
  uid: [199, 1, 2, 3, 4, 5],
  'wifi-on-interval': 60,
  'wifi-ssid': 'HomeNet',
  'wifi-password': 'secret-wifi-password',
  'rcvr-uart-baud': 420000,
  domain: 0,
  customised: false,
  'flash-discriminator': 987654321,
};

interface Upload {
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

type Answer = 'ok' | 'mismatch' | 'error';

// A receiver on the network: answers /config, /options.json and /hardware.json, takes an upload and
// afterwards reports `after` as its version, or nothing at all when `after` is undefined.
async function receiver(opts: { version?: string; product?: string; target?: string; domain?: string; custom?: boolean; answer?: Answer; after?: string; restartMs?: number }) {
  const uploads: Upload[] = [];
  const asked: string[] = [];
  let version = opts.version ?? '4.0.1';
  let gone = false;
  const dev = await fakeDevice(async (req, res) => {
    asked.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/config' && !gone) {
      res.end(
        JSON.stringify({
          options: OPTIONS,
          settings: {
            product_name: opts.product ?? 'RadioMaster RP4TD True Diversity 2.4GHz RX',
            lua_name: 'RM RP4TD 2400',
            target: opts.target ?? 'UNIFIED_ESP32_2400_RX',
            version,
            'module-type': 'RX',
            reg_domain_high: opts.domain ?? 'ISM2G4',
            custom_hardware: !!opts.custom,
          },
        }),
      );
    } else if (req.url === '/options.json') {
      res.end(JSON.stringify(OPTIONS));
    } else if (req.url === '/hardware.json') {
      res.end(JSON.stringify({ serial_rx: 9, own: true }));
    } else if (req.method === 'POST' && req.url === '/update') {
      uploads.push({ url: req.url, headers: req.headers, body: await buffer(req) });
      const answer = opts.answer ?? 'ok';
      res.end(JSON.stringify({ status: answer, msg: answer === 'mismatch' ? '<b>Current target:</b> X.<br>Uploaded image: Y.' : 'Done' }));
      if (answer === 'ok') {
        const after = opts.after;
        if (after === undefined) gone = true;
        // a restart that takes a while: the old version answers until then
        else if (opts.restartMs) setTimeout(() => (version = after), opts.restartMs);
        else version = after;
      }
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  closers.push(dev.close);
  return { host: dev.host, uploads, asked };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

// A data folder with the archive of 4.1.0 already downloaded, so nothing goes to the internet.
async function withArchive(): Promise<Paths> {
  const p = paths(await tempDir());
  const zip = testArchive();
  await mkdir(join(p.firmware, '4.1.0'), { recursive: true });
  await writeFile(archivePath(p, '4.1.0'), zip);
  await writeFile(join(p.firmware, '4.1.0', 'archive.json'), JSON.stringify({ tag: '4.1.0', commit: 'x', size: zip.length }));
  return p;
}

const noInternet = (async () => {
  throw new Error('no internet in tests');
}) as unknown as typeof fetch;
const local = (url: string | URL | Request, init?: RequestInit) =>
  String(url).startsWith('http://127.0.0.1') ? fetch(url, init) : noInternet(url, init);

// The file part of a multipart body.
function filePart(body: Buffer): { header: string; data: Buffer } {
  const boundary = body.subarray(0, body.indexOf('\r\n')).toString();
  const start = body.indexOf('\r\n\r\n') + 4;
  const end = body.indexOf(`\r\n${boundary}`, start);
  return { header: body.subarray(0, start).toString(), data: body.subarray(start, end) };
}

describe('prepareFlash', () => {
  it('builds the file from the archive with the device options unchanged and sends nothing', async () => {
    const p = await withArchive();
    const dev = await receiver({});
    const plan = await prepareFlash(p, dev.host, '4.1.0', false, { fetchFn: local as typeof fetch });
    expect(plan).toMatchObject({
      to: '4.1.0',
      folder: 'FCC',
      archiveFile: 'firmware/FCC/Unified_ESP32_2400_RX/firmware.bin',
      productName: 'RadioMaster RP4TD True Diversity 2.4GHz RX',
      luaName: 'RM RP4TD 2400',
      hardwareFrom: 'targets',
      esp8285: false,
    });
    expect(plan.optionNames).toEqual(Object.keys(OPTIONS).sort());
    expect(plan.upload.name).toBe('firmware.bin');
    expect(plan.upload.data.includes(JSON.stringify(OPTIONS))).toBe(true);
    expect(plan.upload.data.includes(JSON.stringify({ serial_rx: 3, led_rgb: 22, power_max: 3 }))).toBe(true);
    expect(dev.asked.some((a) => a.startsWith('POST'))).toBe(false);
    const { upload: _upload, ...rest } = plan;
    expect(JSON.stringify(rest)).not.toContain('secret-wifi-password');
    expect(JSON.stringify(rest)).not.toContain('199');
  });

  it('takes the LBT file for CE_LBT, the device layout when changed by hand, and gzip for ESP8285', async () => {
    const p = await withArchive();
    const lbt = await prepareFlash(p, (await receiver({ domain: 'CE_LBT', custom: true })).host, '4.1.0', false, { fetchFn: local as typeof fetch });
    expect(lbt.folder).toBe('LBT');
    expect(lbt.hardwareFrom).toBe('device');
    expect(lbt.upload.data.includes('{"serial_rx":9,"own":true}')).toBe(true);
    const rp1 = await receiver({ product: 'RadioMaster RP1 2.4GHz RX', target: 'UNIFIED_ESP8285_2400_RX' });
    const gz = await prepareFlash(p, rp1.host, '4.1.0', false, { fetchFn: local as typeof fetch });
    expect(gz.upload.name).toBe('firmware.bin.gz');
    expect(gunzipSync(gz.upload.data).includes(JSON.stringify(OPTIONS))).toBe(true);
  });

  it('refuses devices that are current, newer or own builds, and own builds only by hand', async () => {
    const p = await withArchive();
    const f = { fetchFn: local as typeof fetch };
    await expect(prepareFlash(p, (await receiver({ version: '4.1.0' })).host, '4.1.0', false, f)).rejects.toThrow('already runs 4.1.0');
    await expect(prepareFlash(p, (await receiver({ version: '4.1.1' })).host, '4.1.0', true, f)).rejects.toThrow('never takes a device back to an older version');
    await expect(prepareFlash(p, (await receiver({ version: '2.5.2' })).host, '4.1.0', true, f)).rejects.toThrow("doesn't support");
    await expect(prepareFlash(p, (await receiver({ version: 'master' })).host, '4.1.0', false, f)).rejects.toThrow('custom build');
    expect((await prepareFlash(p, (await receiver({ version: 'master' })).host, '4.1.0', true, f)).to).toBe('4.1.0');
  });

  it('sends nothing when the file does not match the device target', async () => {
    const p = await withArchive();
    const dev = await receiver({ target: 'UNIFIED_ESP32_900_RX', product: 'Mislabeled 900 RX' });
    await expect(prepareFlash(p, dev.host, '4.1.0', false, { fetchFn: local as typeof fetch })).rejects.toThrow(
      "doesn't match the device's target (UNIFIED_ESP32_900_RX). The app sent nothing.",
    );
    expect(dev.asked.some((a) => a.startsWith('POST'))).toBe(false);
  });

  it('stops when nothing answers', async () => {
    const p = await withArchive();
    await expect(prepareFlash(p, '127.0.0.1:1', '4.1.0', false, { fetchFn: local as typeof fetch })).rejects.toThrow('No ELRS device answers');
  });
});

describe('uploadFirmware', () => {
  it('posts the file in the field "data" with X-FileSize, and never a force field', async () => {
    const dev = await receiver({});
    const data = Buffer.from('firmware bytes');
    expect(await uploadFirmware(dev.host, { name: 'firmware.bin', data })).toEqual({ status: 'ok', message: 'Done' });
    const [up] = dev.uploads;
    expect(up!.url).toBe('/update');
    expect(up!.headers['x-filesize']).toBe(String(data.length));
    const part = filePart(up!.body);
    expect(part.header).toContain('name="data"; filename="firmware.bin"');
    expect(part.data).toEqual(data);
    expect(up!.body.toString('latin1')).not.toMatch(/name="force"/);
  });

  it('turns the HTML of a mismatch into plain text and a lost connection into an error', async () => {
    const dev = await receiver({ answer: 'mismatch' });
    expect(await uploadFirmware(dev.host, { name: 'firmware.bin', data: Buffer.from('x') })).toEqual({
      status: 'mismatch',
      message: 'Current target: X. Uploaded image: Y.',
    });
    expect((await uploadFirmware('127.0.0.1:1', { name: 'firmware.bin', data: Buffer.from('x') })).status).toBe('error');
  });
});

describe('runFlash', () => {
  const quick = { waitMs: 400, pollMs: 20 };

  async function planFor(dev: { host: string }) {
    return prepareFlash(await withArchive(), dev.host, '4.1.0', false, { fetchFn: local as typeof fetch });
  }

  it('uploads and confirms the new version when the device is back', async () => {
    const dev = await receiver({ after: '4.1.0' });
    const steps: string[] = [];
    const plan = await planFor(dev);
    expect(await runFlash(plan, { ...quick, onStep: (s) => steps.push(s) })).toEqual({ result: 'done', version: '4.1.0' });
    expect(steps).toEqual(['upload', 'reboot']);
    expect(filePart(dev.uploads[0]!.body).data).toEqual(plan.upload.data);
  });

  it('does not wait for a transmitter module, whose WiFi is off after the restart', async () => {
    const dev = await receiver({ after: '4.1.0' });
    const plan = await planFor(dev);
    const steps: string[] = [];
    const asked = dev.asked.length;
    const tx = { ...plan, device: { ...plan.device, type: 'tx' as const } };
    expect(await runFlash(tx, { ...quick, onStep: (s) => steps.push(s) })).toEqual({ result: 'unconfirmed', check: 'wifi-off' });
    expect(steps).toEqual(['upload']);
    expect(dev.asked.slice(asked).filter((a) => !a.startsWith('POST'))).toEqual([]);
  });

  it('with wait off returns right after the upload', async () => {
    const dev = await receiver({ after: '4.1.0' });
    const plan = await planFor(dev);
    const steps: string[] = [];
    expect(await runFlash(plan, { ...quick, wait: false, onStep: (s) => steps.push(s) })).toEqual({ result: 'unconfirmed', check: 'later' });
    expect(steps).toEqual(['upload']);
  });

  it('takes the old version right after the upload for one from before the restart, and asks again', async () => {
    const slow = await receiver({ after: '4.1.0', restartMs: 150 });
    expect(await runFlash(await planFor(slow), { waitMs: 2000, pollMs: 20, staleMs: 400 })).toEqual({ result: 'done', version: '4.1.0' });
    // still the old version once that time is over: no need to wait for the rest
    const old = await receiver({ after: '4.0.1' });
    const start = Date.now();
    expect(await runFlash(await planFor(old), { waitMs: 5000, pollMs: 20, staleMs: 100 })).toEqual({ result: 'wrong-version', version: '4.0.1' });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('tells a device still on the old version, one not seen again, a mismatch and an error apart', async () => {
    expect(await runFlash(await planFor(await receiver({ after: '4.0.1' })), quick)).toEqual({ result: 'wrong-version', version: '4.0.1' });
    expect(await runFlash(await planFor(await receiver({})), quick)).toEqual({ result: 'unconfirmed' });
    expect(await runFlash(await planFor(await receiver({ answer: 'mismatch' })), quick)).toMatchObject({ result: 'mismatch' });
    expect(await runFlash(await planFor(await receiver({ answer: 'error' })), quick)).toEqual({ result: 'failed', message: 'Done' });
  });
});
