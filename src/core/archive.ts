import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FetchFn } from './device.ts';
import { AppError, msg } from './errors.ts';
import { readJson, writeJson, type Paths } from './paths.ts';
import { majorVersions, targetRelease, type Release } from './releases.ts';
import type { Settings } from './settings.ts';
import { readZipEntries } from './zip.ts';

// Where the ELRS Configurator gets its firmware: index.json maps tags to commits, each commit has a
// firmware.zip with the firmware of all devices.
const BASE = 'https://artifactory.expresslrs.org/ExpressLRS';
const SAFE_TAG = /^\d+\.\d+\.\d+(-RC\d+)?$/i;

export interface ArchiveInfo {
  tag: string;
  commit: string;
  size: number;
  downloaded: string;
}

const folderOf = (p: Paths, tag: string) => join(p.firmware, tag);
export const archivePath = (p: Paths, tag: string) => join(folderOf(p, tag), 'firmware.zip');

async function getOk(url: string, fetchFn: FetchFn): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { 'User-Agent': 'elrs-auto-flash' } });
  } catch {
    throw new AppError(msg('downloadOffline'), 'download');
  }
  if (!res.ok) throw new AppError(msg('downloadStatus', { status: res.status, url }), 'download');
  return res;
}

export async function commitOf(tag: string, fetchFn: FetchFn = fetch): Promise<string> {
  const index = (await (await getOk(`${BASE}/index.json`, fetchFn)).json()) as { tags?: Record<string, string> };
  const commit = index.tags?.[tag];
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new AppError(msg('downloadNoFirmware', { tag }), 'download');
  return commit;
}

const TARGETS_NAME = 'firmware/hardware/targets.json';

// The archive of one version, downloaded first when it is not there yet; returns its path.
export async function ensureArchive(
  p: Paths,
  tag: string,
  fetchFn: FetchFn = fetch,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  if (!SAFE_TAG.test(tag)) throw new AppError(msg('notAVersion', { tag }));
  const path = archivePath(p, tag);
  const info = await readJson<ArchiveInfo>(join(folderOf(p, tag), 'archive.json'));
  if (info && (await stat(path).catch(() => undefined))?.size === info.size) return path;

  const commit = await commitOf(tag, fetchFn);
  const res = await getOk(`${BASE}/${commit}/firmware.zip`, fetchFn);
  if (!res.body) throw new AppError(msg('downloadEmpty', { tag }), 'download');
  await mkdir(folderOf(p, tag), { recursive: true });
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const counted = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream).on('data', (chunk: Buffer) => {
    done += chunk.length;
    onProgress?.(done, total);
  });
  // a file of its own per process, so two downloads at once never write into each other
  const part = `${path}.${process.pid}.part`;
  try {
    await pipeline(counted, createWriteStream(part));
    // complete only once it opens as the archive a flash reads: a download cut short or another answer
    // fails here, not at every flash after; its size says little (fetch unpacks a packed download)
    if (!(await readZipEntries(part, (n) => n === TARGETS_NAME)).has(TARGETS_NAME)) throw new Error('no targets.json');
  } catch {
    await rm(part, { force: true });
    throw new AppError(msg('downloadBroken', { tag }), 'download');
  }
  await rename(part, path);
  await writeJson(join(folderOf(p, tag), 'archive.json'), { tag, commit, size: done, downloaded: new Date().toISOString() });
  return path;
}

// The versions whose archives stay: per major version the newest release and, with release candidates
// on, the newest of all.
export function archivesToKeep(releases: Release[], s: Settings): string[] {
  const keep = new Set<string>();
  for (const m of majorVersions(releases)) {
    const final = targetRelease(releases, m, false);
    if (final) keep.add(final.tag);
    const rc = s.releaseCandidates ? targetRelease(releases, m, true) : undefined;
    if (rc) keep.add(rc.tag);
  }
  return [...keep];
}

// Deletes the archives of all other versions; returns the versions removed.
export async function pruneArchives(p: Paths, keep: string[]): Promise<string[]> {
  const names = await readdir(p.firmware).catch(() => [] as string[]);
  const gone: string[] = [];
  for (const n of names.filter((n) => SAFE_TAG.test(n) && !keep.includes(n))) {
    // a folder in use (e.g. open on Windows) stays for next time: tidying up never stops a flash
    await rm(folderOf(p, n), { recursive: true, force: true }).then(
      () => gone.push(n),
      () => {},
    );
  }
  return gone;
}

// One product of firmware/hardware/targets.json.
export interface Product {
  product_name: string;
  lua_name?: string;
  layout_file?: string;
  overlay?: Record<string, unknown>;
  upload_methods?: string[];
  platform: string; // esp8285, esp32, esp32-s3, esp32-c3, stm32 ...
  firmware: string; // e.g. Unified_ESP32_2400_RX
  logo_file?: string;
  prior_target_name?: string;
}

export interface FirmwareFiles {
  product: Product;
  folder: 'FCC' | 'LBT';
  file: string; // path inside the archive
  firmware: Buffer;
  hardware?: Record<string, unknown>; // layout with the product's overlay
  logo?: Buffer;
  esp8285: boolean;
}

// The product entry for what a device reports: same firmware (target) and same product name.
export function findProduct(targets: unknown, target: string, productName: string): Product | undefined {
  for (const vendor of Object.values((targets ?? {}) as Record<string, unknown>)) {
    for (const kind of Object.values((vendor ?? {}) as Record<string, unknown>)) {
      if (typeof kind !== 'object' || kind === null) continue;
      for (const product of Object.values(kind as Record<string, unknown>)) {
        const p = product as Partial<Product>;
        if (typeof p?.firmware === 'string' && p.firmware.toUpperCase() === target.toUpperCase() && p.product_name === productName) {
          return p as Product;
        }
      }
    }
  }
  return undefined;
}

// Reads what a flash of this device needs from the archive: the firmware for its target and domain
// (CE_LBT from LBT/, everything else from FCC/), its product entry, layout and logo.
export async function firmwareFor(zipPath: string, device: { target: string; product: string; domainHigh?: string }): Promise<FirmwareFiles> {
  const targetsFile = (await readZipEntries(zipPath, (n) => n === TARGETS_NAME)).get(TARGETS_NAME);
  if (!targetsFile) throw new AppError(msg('archiveNoTargets'), 'download');
  const product = findProduct(JSON.parse(targetsFile.toString('utf8')), device.target, device.product);
  if (!product) throw new AppError(msg('noProduct', { product: device.product, target: device.target }), 'unsupported');
  if (!product.upload_methods?.includes('wifi')) throw new AppError(msg('noWifiUpload', { product: device.product }), 'unsupported');
  if (!product.platform.startsWith('esp')) throw new AppError(msg('notEsp', { product: device.product }), 'unsupported');

  const folder = device.domainHigh === 'CE_LBT' ? 'LBT' : 'FCC';
  const file = `firmware/${folder}/${product.firmware}/firmware.bin`;
  const layout = product.layout_file ? `firmware/hardware/${product.firmware.includes('_TX') ? 'TX' : 'RX'}/${product.layout_file}` : undefined;
  const logo = product.logo_file ? `firmware/hardware/logo/${product.logo_file}` : undefined;
  const files = await readZipEntries(zipPath, (n) => n === file || n === layout || n === logo);
  const firmware = files.get(file);
  if (!firmware) throw new AppError(msg('archiveNoFirmware', { folder, firmware: product.firmware }), 'unsupported');
  let hardware: Record<string, unknown> | undefined;
  if (layout) {
    const data = files.get(layout);
    if (!data) throw new AppError(msg('archiveNoLayout', { file: product.layout_file! }), 'unsupported');
    hardware = { ...(JSON.parse(data.toString('utf8')) as Record<string, unknown>), ...product.overlay };
  }
  if (logo && !files.get(logo)) throw new AppError(msg('archiveNoLogo', { file: product.logo_file! }), 'unsupported');
  return { product, folder, file, firmware, hardware, logo: logo ? files.get(logo) : undefined, esp8285: product.platform === 'esp8285' };
}
