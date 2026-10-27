import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archivePath, archivesToKeep, ensureArchive, findProduct, firmwareFor, pruneArchives } from '../src/core/archive.ts';
import type { FetchFn } from '../src/core/device.ts';
import { paths } from '../src/core/paths.ts';
import { fetchReleases } from '../src/core/releases.ts';
import { fixture, tempDir, TARGETS, testArchive } from './helpers.ts';

const COMMIT = 'a9d4a9cb5b5687c4c9d7e9e7fbdf44ad93651da6';

// The ExpressLRS download server: index.json and one firmware.zip; length cuts the zip short.
// `body` replaces what is sent, `announced` the size the server gives for it.
function server(zip: Buffer, length = zip.length, body?: Buffer, announced = zip.length): { fetchFn: FetchFn; urls: string[] } {
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    urls.push(url);
    if (url.endsWith('/index.json')) return new Response(JSON.stringify({ tags: { '4.1.0': COMMIT } }));
    if (url.endsWith(`/${COMMIT}/firmware.zip`)) return new Response(body ?? zip.subarray(0, length), { headers: { 'content-length': String(announced) } });
    return new Response('', { status: 404 });
  }) as unknown as FetchFn;
  return { fetchFn, urls };
}

describe('findProduct', () => {
  it('finds the product by target in any case and by product name', () => {
    expect(findProduct(TARGETS, 'UNIFIED_ESP32_2400_RX', 'RadioMaster RP4TD True Diversity 2.4GHz RX')?.lua_name).toBe('RM RP4TD 2400');
    expect(findProduct(TARGETS, 'UNIFIED_ESP32_2400_RX', 'RadioMaster RP1 2.4GHz RX')).toBeUndefined();
    expect(findProduct(TARGETS, 'UNIFIED_ESP8285_2400_RX', 'Unknown')).toBeUndefined();
    expect(findProduct(null, 'X', 'Y')).toBeUndefined();
  });
});

describe('firmwareFor', () => {
  async function zipFile(): Promise<string> {
    const path = join(await tempDir(), 'firmware.zip');
    await writeFile(path, testArchive());
    return path;
  }

  it('takes the FCC file for ISM2G4 and the LBT file for CE_LBT, with the layout and its overlay', async () => {
    const zip = await zipFile();
    const rp4td = { target: 'UNIFIED_ESP32_2400_RX', product: 'RadioMaster RP4TD True Diversity 2.4GHz RX' };
    const fcc = await firmwareFor(zip, { ...rp4td, domainHigh: 'ISM2G4' });
    expect(fcc).toMatchObject({ folder: 'FCC', file: 'firmware/FCC/Unified_ESP32_2400_RX/firmware.bin', esp8285: false });
    expect(fcc.hardware).toEqual({ serial_rx: 3, led_rgb: 22, power_max: 3 });
    expect(fcc.firmware.includes('LBT')).toBe(false);
    const lbt = await firmwareFor(zip, { ...rp4td, domainHigh: 'CE_LBT' });
    expect(lbt.folder).toBe('LBT');
    expect(lbt.firmware.includes('LBT')).toBe(true);
    expect((await firmwareFor(zip, rp4td)).folder).toBe('FCC');
  });

  it('reads logo and earlier target name of an ESP8285 product', async () => {
    const files = await firmwareFor(await zipFile(), { target: 'UNIFIED_ESP8285_2400_RX', product: 'RadioMaster RP1 2.4GHz RX' });
    expect(files.esp8285).toBe(true);
    expect(files.logo).toEqual(Buffer.from([9, 8, 7]));
    expect(files.product.prior_target_name).toBe('RM_RP1_2400_RX');
  });

  it('refuses unknown products and products without WiFi upload', async () => {
    const zip = await zipFile();
    await expect(firmwareFor(zip, { target: 'UNIFIED_ESP32_2400_RX', product: 'Nope' })).rejects.toThrow('has no firmware for "Nope"');
    await expect(firmwareFor(zip, { target: 'UNIFIED_ESP8285_2400_RX', product: 'Some UART RX' })).rejects.toThrow('cannot be updated over WiFi');
  });
});

describe('ensureArchive', () => {
  it('downloads the archive of a version once, with progress', async () => {
    const p = paths(await tempDir());
    const zip = testArchive();
    const gh = server(zip);
    const progress: number[] = [];
    const path = await ensureArchive(p, '4.1.0', gh.fetchFn, (done) => progress.push(done));
    expect(path).toBe(archivePath(p, '4.1.0'));
    expect(await readFile(path)).toEqual(zip);
    expect(progress.at(-1)).toBe(zip.length);
    expect(gh.urls).toEqual([
      'https://artifactory.expresslrs.org/ExpressLRS/index.json',
      `https://artifactory.expresslrs.org/ExpressLRS/${COMMIT}/firmware.zip`,
    ]);
    expect(JSON.parse(await readFile(join(p.firmware, '4.1.0', 'archive.json'), 'utf8'))).toMatchObject({ tag: '4.1.0', commit: COMMIT, size: zip.length });
    await ensureArchive(p, '4.1.0', gh.fetchFn);
    expect(gh.urls).toHaveLength(2);
  });

  it('refuses unknown and invalid versions and keeps no half download', async () => {
    const p = paths(await tempDir());
    const zip = testArchive();
    await expect(ensureArchive(p, '9.9.9', server(zip).fetchFn)).rejects.toThrow('has no firmware for 9.9.9');
    await expect(ensureArchive(p, '../4.1.0', server(zip).fetchFn)).rejects.toThrow('Not a version');
    await expect(ensureArchive(p, '4.1.0', server(zip, 100).fetchFn)).rejects.toThrow('incomplete or damaged');
    expect(await readdir(join(p.firmware, '4.1.0'))).toEqual([]);
    // another answer than the archive, of the announced size all the same
    await expect(ensureArchive(p, '4.1.0', server(zip, zip.length, Buffer.alloc(zip.length, '<html>')).fetchFn)).rejects.toThrow('incomplete or damaged');
    expect(await readdir(join(p.firmware, '4.1.0'))).toEqual([]);
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as FetchFn;
    await expect(ensureArchive(p, '4.1.0', offline)).rejects.toThrow('No connection to the ExpressLRS download server');
  });

  it('takes an archive that came packed, whose size differs from the announced one', async () => {
    const p = paths(await tempDir());
    const zip = testArchive();
    // fetch unpacks such a download on the way: more bytes arrive than the server announced
    const packed = server(zip, zip.length, zip, zip.length - 100);
    expect(await readFile(await ensureArchive(p, '4.1.0', packed.fetchFn))).toEqual(zip);
  });

  it('downloads into a file of its own, so another download of the same version cannot mix in', async () => {
    const p = paths(await tempDir());
    const zip = testArchive();
    const other = join(p.firmware, '4.1.0', 'firmware.zip.99999.part');
    await mkdir(join(p.firmware, '4.1.0'), { recursive: true });
    await writeFile(other, 'half of another download');
    const path = await ensureArchive(p, '4.1.0', server(zip).fetchFn);
    expect(await readFile(path)).toEqual(zip);
    expect(await readFile(other, 'utf8')).toBe('half of another download');
  });
});

describe('archivesToKeep and pruneArchives', () => {
  it('keeps the newest release of each major version, with the switch also the newest release candidate', async () => {
    const body = JSON.stringify(await fixture('github-releases-2026-10-25.json'));
    const releases = await fetchReleases((async () => new Response(body)) as unknown as FetchFn);
    expect(archivesToKeep(releases, { autoUpdate: false, releaseCandidates: false }).sort()).toEqual(['3.6.4', '4.1.0']);
    const withRc = [...releases, { tag: '4.2.0-RC1', prerelease: true, published: '2026-10-20T00:00:00Z' }];
    expect(archivesToKeep(withRc, { autoUpdate: false, releaseCandidates: true }).sort()).toEqual(['3.6.4', '4.1.0', '4.2.0-RC1']);
  });

  it('deletes the archives of other versions and leaves other folders alone', async () => {
    const p = paths(await tempDir());
    for (const name of ['4.0.1', '4.1.0', '3.6.4', 'notes']) await mkdir(join(p.firmware, name), { recursive: true });
    expect(await pruneArchives(p, ['4.1.0', '3.6.4'])).toEqual(['4.0.1']);
    expect((await readdir(p.firmware)).sort()).toEqual(['3.6.4', '4.1.0', 'notes']);
    expect(await pruneArchives(paths(await tempDir()), [])).toEqual([]);
  });

  it('leaves a folder that cannot be deleted for next time, without stopping', async () => {
    const p = paths(await tempDir());
    for (const name of ['4.0.1', '4.1.0']) await mkdir(join(p.firmware, name, 'x'), { recursive: true });
    // a folder in use, e.g. open on Windows: here one whose files cannot be removed
    await chmod(join(p.firmware, '4.0.1'), 0o555);
    try {
      expect(await pruneArchives(p, ['4.1.0'])).toEqual([]);
    } finally {
      await chmod(join(p.firmware, '4.0.1'), 0o755);
    }
    expect(await pruneArchives(p, ['4.1.0'])).toEqual(['4.0.1']);
  });
});
