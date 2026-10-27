import { ensureArchive, firmwareFor } from './archive.ts';
import { readConfig, readHardware, readOptions, uploadFirmware, type DeviceInfo, type FetchFn } from './device.ts';
import { AppError, msg, type MsgCode, type MsgParams } from './errors.ts';
import { buildImage, hasTarget, uploadFile } from './image.ts';
import type { Paths } from './paths.ts';
import { deviceState } from './state.ts';
import { compareVersions, parseVersion } from './version.ts';

export interface FlashPlan {
  ip: string;
  device: DeviceInfo;
  to: string; // version tag
  folder: 'FCC' | 'LBT';
  archiveFile: string; // the firmware's path inside the archive
  productName: string;
  luaName: string;
  hardwareFrom: 'targets' | 'device';
  esp8285: boolean;
  optionNames: string[]; // which options are carried over; their values are never shown
  upload: { name: string; data: Buffer };
}

export interface FlashDeps {
  fetchFn?: FetchFn;
  onDownload?: (done: number, total: number) => void;
}

// Everything up to the upload, without sending anything to the device: reads its settings and options,
// takes the firmware for its target and domain from the archive, appends the options unchanged and
// checks that the file carries the device's target. `manual` allows an own build (its own button).
export async function prepareFlash(p: Paths, ip: string, to: string, manual: boolean, deps: FlashDeps = {}): Promise<FlashPlan> {
  const fetchFn = deps.fetchFn ?? fetch;
  let reason = '';
  const device = await readConfig(ip, fetchFn, 5000, (r) => (reason = r));
  if (!device && reason === 'not-elrs') throw new AppError(msg('notElrs', { ip }));
  if (!device) throw new AppError(msg('noDevice', { ip }), 'gone');
  const target = parseVersion(to);
  if (!target) throw new AppError(msg('notAVersion', { tag: to }));
  const state = deviceState(device.version, target);
  if (state === 'current') throw new AppError(msg('alreadyCurrent', { to }));
  if (state === 'newer') throw new AppError(msg('newerThanTarget', { version: device.version!, to }));
  if (state === 'unsupported') throw new AppError(msg('tooOld'), 'unsupported');
  if (state === 'custom-build' && !manual) throw new AppError(msg('ownBuild'));

  const options = await readOptions(ip, fetchFn);
  const hardware = device.customHardware ? await readHardware(ip, fetchFn) : undefined;
  const zip = await ensureArchive(p, to, fetchFn, deps.onDownload);
  const files = await firmwareFor(zip, device);
  const image = buildImage(files.firmware, {
    productName: files.product.product_name,
    luaName: files.product.lua_name ?? '',
    options,
    hardware: hardware ?? files.hardware,
    logo: files.logo,
    priorTargetName: files.product.prior_target_name,
  });
  // devices skip their own check for gzip files (ESP8285), so it is always done here
  if (!hasTarget(image, device.target)) {
    throw new AppError(msg('targetMissing', { target: device.target }), 'target');
  }
  return {
    ip,
    device,
    to,
    folder: files.folder,
    archiveFile: files.file,
    productName: files.product.product_name,
    luaName: files.product.lua_name ?? '',
    hardwareFrom: hardware ? 'device' : 'targets',
    esp8285: files.esp8285,
    optionNames: Object.keys(options).sort(),
    upload: uploadFile(image, files.esp8285),
  };
}

export type FlashResult =
  | { result: 'done'; version: string } // back on the network with the new version
  // not seen again in time, e.g. because its transmitter is on; or not waited for (check): a transmitter
  // module, whose WiFi is off after the restart, or a device left to be confirmed when it is seen again
  | { result: 'unconfirmed'; check?: 'wifi-off' | 'later' }
  | { result: 'wrong-version'; version: string } // back, but still another version
  | { result: 'mismatch'; message: string } // the device refused the file for its target
  | { result: 'failed'; message: string; code?: MsgCode; params?: MsgParams }; // upload error or connection lost

// Right after the upload a device may still answer with its old version, from before its restart.
export const STALE_MS = 30_000;

export interface RunDeps {
  fetchFn?: FetchFn;
  onStep?: (step: 'upload' | 'reboot') => void;
  waitMs?: number; // how long to wait for the device after the upload (default 3 minutes)
  pollMs?: number;
  staleMs?: number; // an old version within this time of the upload is asked again (default STALE_MS)
  wait?: boolean; // false: done after the upload, the device is confirmed once it is seen again
}

// Uploads the prepared file and waits for the device to come back: it restarts, and its WiFi comes on
// again after its "WiFi on interval" (60 s by default) as long as its transmitter is off. A transmitter
// module restarts with its WiFi off until it is turned on in the radio's menu, so it is not waited for;
// neither is any device with `wait: false`.
export async function runFlash(plan: FlashPlan, deps: RunDeps = {}): Promise<FlashResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  deps.onStep?.('upload');
  const up = await uploadFirmware(plan.ip, plan.upload, fetchFn);
  if (up.status === 'mismatch') return { result: 'mismatch', message: up.message };
  if (up.status === 'error') return { result: 'failed', message: up.message, ...(up.code && { code: up.code }), ...(up.params && { params: up.params }) };

  if (plan.device.type === 'tx') return { result: 'unconfirmed', check: 'wifi-off' };
  if (deps.wait === false) return { result: 'unconfirmed', check: 'later' };

  deps.onStep?.('reboot');
  const waitMs = deps.waitMs ?? 180_000;
  const pollMs = deps.pollMs ?? 5000;
  const staleMs = deps.staleMs ?? STALE_MS;
  const target = parseVersion(plan.to)!;
  const uploaded = Date.now();
  const until = uploaded + waitMs;
  let old: string | undefined;
  await new Promise((r) => setTimeout(r, Math.min(pollMs * 2, waitMs)));
  while (Date.now() < until) {
    const info = await readConfig(plan.ip, fetchFn, 3000);
    if (info) {
      const v = parseVersion(info.version);
      if (v && compareVersions(v, target) === 0) return { result: 'done', version: info.version };
      if (Date.now() - uploaded >= staleMs) return { result: 'wrong-version', version: info.version };
      old = info.version;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return old ? { result: 'wrong-version', version: old } : { result: 'unconfirmed' };
}
