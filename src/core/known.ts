import type { DeviceType } from './device.ts';
import type { Device } from './discovery.ts';
import { msg, toMsg, type AppError, type Msg } from './errors.ts';
import { STALE_MS, type FlashResult } from './flash.ts';
import { readJson, writeJson, type Paths } from './paths.ts';
import type { VersionedRelease } from './releases.ts';
import { deviceState, type DeviceState } from './state.ts';
import { compareVersions, parseVersion } from './version.ts';

// Failed attempts at one target version before a device waits for its notice to be dismissed.
export const MAX_FAILURES = 3;

// A device ever found, as kept in devices.json. Never holds the device's options.
export interface KnownDevice {
  key: string; // MAC (upper case, no colons) once seen via mDNS, else the IP address
  ip: string;
  mac?: string;
  name?: string; // given by the user, to tell devices of the same kind apart
  type?: DeviceType;
  target?: string;
  product?: string;
  device?: string;
  version?: string;
  domainHigh?: string;
  domainLow?: string;
  lastSeen: string;
  failures?: { tag: string; count: number }; // failed attempts at this target version
  notice?: Msg & { kind: 'mismatch' | 'failed'; at: string }; // no more attempts until dismissed
  unconfirmed?: { tag: string; at: string }; // flashed to this version, not seen again since
  unsupported?: { tag: string; reason: string; code?: Msg['code']; params?: Msg['params'] }; // this version cannot be flashed onto it
}

export type KnownState = DeviceState | 'unconfirmed' | 'mismatch' | 'failed';

export async function loadKnown(p: Paths): Promise<KnownDevice[]> {
  const list = await readJson<unknown>(p.devices);
  if (!Array.isArray(list)) return [];
  return list.filter((d): d is KnownDevice => typeof d?.key === 'string' && typeof d?.ip === 'string' && typeof d?.lastSeen === 'string');
}

// The last job queued per file: within one process reads and updates run one after the other, so
// none reads the list while another one still writes it.
const updating = new Map<string, Promise<unknown>>();

function inTurn<T>(p: Paths, job: () => Promise<T>): Promise<T> {
  const run = (updating.get(p.devices) ?? Promise.resolve()).then(job);
  updating.set(p.devices, run.catch(() => {}));
  return run;
}

// The list once the updates queued before are written, e.g. the result of a flash that just ended.
export function loadKnownInTurn(p: Paths): Promise<KnownDevice[]> {
  return inTurn(p, () => loadKnown(p));
}

// Reads the list, lets fn change it and writes it back right away, so changes made meanwhile by
// another command (dismiss, forget) are not lost.
export function updateKnown<T>(p: Paths, fn: (list: KnownDevice[]) => T): Promise<{ list: KnownDevice[]; value: T }> {
  return inTurn(p, async () => {
    const list = await loadKnown(p);
    const value = fn(list);
    await writeJson(p.devices, list);
    return { list, value };
  });
}

const sameVersion = (version: string | undefined, tag: string) => {
  const a = version ? parseVersion(version) : undefined;
  const b = parseVersion(tag);
  return !!a && !!b && compareVersions(a, b) === 0;
};

function addFailure(d: KnownDevice, tag: string, m: Msg, now: Date): void {
  const count = d.failures?.tag === tag ? d.failures.count + 1 : 1;
  d.failures = { tag, count };
  if (count >= MAX_FAILURES) d.notice = { kind: 'failed', ...m, at: now.toISOString() };
}

const FIELDS = ['type', 'target', 'product', 'device', 'version', 'domainHigh', 'domainLow'] as const;

// Takes in a device just found. It is recognized by its MAC, else by its IP address as long as the
// product does not differ; a device known only by its IP address is taken over once its MAC shows up
// there. A device back after a flash that was not confirmed counts as done with the new version,
// else as a failed attempt; the old version within STALE_MS of the upload may still stem from before
// the restart and is left for a later sighting.
export function seen(list: KnownDevice[], d: Device, now = new Date()): { device: KnownDevice; isNew: boolean; confirmed?: { to: string; result: FlashResult } } {
  const fits = (k: KnownDevice) => k.ip === d.ip && (!k.product || !d.product || k.product === d.product);
  let rec = d.mac ? list.find((k) => k.key === d.mac) : undefined;
  const byIp = list.filter((k) => k.key === k.ip && fits(k));
  if (d.mac) {
    if (!rec && byIp[0]) {
      rec = byIp.shift()!;
      rec.key = d.mac;
    }
    for (const dup of byIp) list.splice(list.indexOf(dup), 1);
  } else {
    rec = list.filter(fits).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))[0];
  }
  const isNew = !rec;
  if (!rec) {
    rec = { key: d.mac ?? d.ip, ip: d.ip, lastSeen: now.toISOString() };
    list.push(rec);
  }
  rec.ip = d.ip;
  if (d.mac) rec.mac = d.mac;
  for (const f of FIELDS) if (d[f] !== undefined) (rec as unknown as Record<string, unknown>)[f] = d[f];
  rec.lastSeen = now.toISOString();

  let confirmed: { to: string; result: FlashResult } | undefined;
  const stale = rec.unconfirmed && now.getTime() - Date.parse(rec.unconfirmed.at) < STALE_MS;
  if (rec.unconfirmed && rec.version && !(stale && !sameVersion(rec.version, rec.unconfirmed.tag))) {
    const { tag } = rec.unconfirmed;
    delete rec.unconfirmed;
    if (sameVersion(rec.version, tag)) {
      delete rec.failures;
      confirmed = { to: tag, result: { result: 'done', version: rec.version } };
    } else {
      addFailure(rec, tag, msg('stillRuns', { version: rec.version, to: tag }), now);
      confirmed = { to: tag, result: { result: 'wrong-version', version: rec.version } };
    }
  }
  return { device: rec, isNew, confirmed };
}

// Notes the outcome of a flash to `tag`.
export function recordResult(d: KnownDevice, tag: string, r: FlashResult, now = new Date()): void {
  switch (r.result) {
    case 'done':
      d.version = r.version;
      d.lastSeen = now.toISOString();
      delete d.failures;
      delete d.notice;
      delete d.unconfirmed;
      break;
    case 'unconfirmed':
      d.unconfirmed = { tag, at: now.toISOString() };
      break;
    case 'wrong-version':
      d.version = r.version;
      d.lastSeen = now.toISOString();
      addFailure(d, tag, msg('stillRuns', { version: r.version, to: tag }), now);
      break;
    case 'failed':
      addFailure(d, tag, { message: r.message, ...(r.code && { code: r.code }), ...(r.params && { params: r.params }) }, now);
      break;
    case 'mismatch':
      d.notice = { kind: 'mismatch', message: r.message, at: now.toISOString() };
      break;
  }
}

// Notes why a flash to `tag` stopped before the upload; only some reasons stay with the device.
export function recordError(d: KnownDevice, tag: string, e: AppError, now = new Date()): void {
  if (e.kind === 'unsupported') {
    const { message, ...code } = toMsg(e);
    d.unsupported = { tag, reason: message, ...code };
  }
  if (e.kind === 'target') d.notice = { kind: 'mismatch', ...toMsg(e), at: now.toISOString() };
}

// The user's own name for a device; an empty one removes it. Line breaks and control characters
// are dropped and the name is cut to max characters.
export function rename(d: KnownDevice, name: string, max: number): void {
  const clean = name.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  if (clean) d.name = clean;
  else delete d.name;
}

export function dismiss(d: KnownDevice): void {
  delete d.notice;
  delete d.failures;
}

// Where a known device stands against the target version, including what its last flash left.
export function knownState(d: KnownDevice, target: VersionedRelease | undefined): KnownState {
  if (d.notice) return d.notice.kind;
  const state = deviceState(d.version, target?.version);
  if (!target || state === 'current' || state === 'newer') return state;
  if (d.unconfirmed?.tag === target.tag) return 'unconfirmed';
  if (d.unsupported?.tag === target.tag) return 'unsupported';
  return state;
}

// The known devices meant by an IP address, MAC, own name, Lua name or product name.
export function findKnown(list: KnownDevice[], name: string): KnownDevice[] {
  const mac = name.replace(/[:-]/g, '').toUpperCase();
  const lower = name.toLowerCase();
  return list.filter(
    (d) => d.ip === name || d.mac === mac || d.name?.toLowerCase() === lower || d.device?.toLowerCase() === lower || d.product?.toLowerCase() === lower,
  );
}
