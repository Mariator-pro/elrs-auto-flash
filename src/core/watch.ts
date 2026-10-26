import { archivesToKeep, pruneArchives } from './archive.ts';
import { browseMdns, looksBlocked, scanNetworks, type Device, type Discovery } from './discovery.ts';
import { AppError, toMsg, type ErrorKind, type Msg } from './errors.ts';
import { prepareFlash, runFlash, type FlashPlan, type FlashResult } from './flash.ts';
import { knownState, loadKnown, recordError, recordResult, seen, updateKnown, type KnownDevice, type KnownState } from './known.ts';
import type { Paths } from './paths.ts';
import { currentReleases, targetRelease, type ReleaseList, type VersionedRelease } from './releases.ts';
import { loadSettings, type Settings } from './settings.ts';

export type WatchState = KnownState | 'queued' | 'flashing';

export type FlashOutcome = FlashResult | (Msg & { result: 'stopped'; kind?: ErrorKind });

export type WatchEvent =
  // settings, releases or the target version changed (also once at the start)
  | { kind: 'setup'; settings: Settings; releases?: ReleaseList; target?: VersionedRelease }
  // a device was found, came back, left the network or changed its state
  | { kind: 'device'; device: KnownDevice; state: WatchState; online: boolean; before?: { state: WatchState; online: boolean } }
  | { kind: 'removed'; key: string }
  | { kind: 'scanned'; at: string } // a scan of the networks ended
  | { kind: 'step'; device: KnownDevice; step: 'prepare' | 'download' | 'upload' | 'reboot'; percent?: number }
  // how a flash ended, or what a device reported when seen again after an unconfirmed one
  | { kind: 'result'; device: KnownDevice; to: string; outcome: FlashOutcome; later?: boolean }
  // a problem appeared, or went away again (no message)
  | { kind: 'problem'; problem: 'releases' | 'blocked' | 'download' | 'error'; message?: Msg };

export interface WatchDeps {
  browse?: (onDevice: (d: Device) => void) => { stop: () => void };
  scan?: () => Promise<Discovery>;
  releases?: () => Promise<{ list?: ReleaseList; error?: Msg }>;
  prepare?: (ip: string, tag: string, onDownload: (done: number, total: number) => void, manual: boolean) => Promise<FlashPlan>;
  run?: (plan: FlashPlan, onStep: (step: 'upload' | 'reboot') => void) => Promise<FlashResult>;
  now?: () => number;
  tickMs?: number; // how often found devices are taken in and the queue is looked at
  scanEveryMs?: number; // how often the networks are scanned and the releases looked at
  offlineAfterMs?: number; // not seen for this long: off the network
  retryAfterMs?: number; // pause after a failed attempt or download
  recheckAfterMs?: number; // a scan that looks blocked is repeated this soon before the hint shows
}

// Keeps looking for devices and, with auto update on, flashes those with an update one at a time,
// in the order they got it; request() adds one by hand (its button), an own build too. tick() does
// one round; start() runs them until stop().
export function createWatcher(p: Paths, onEvent: (e: WatchEvent) => void, deps: WatchDeps = {}) {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? 5000;
  const scanEveryMs = deps.scanEveryMs ?? 60_000;
  const offlineAfterMs = deps.offlineAfterMs ?? 120_000;
  const retryAfterMs = deps.retryAfterMs ?? 60_000;
  const recheckAfterMs = deps.recheckAfterMs ?? 5000;
  const scan = deps.scan ?? (() => scanNetworks());
  const releasesNow = deps.releases ?? (() => currentReleases(p));
  const prepare = deps.prepare ?? ((ip, tag, onDownload, manual) => prepareFlash(p, ip, tag, manual, { onDownload }));
  const run = deps.run ?? ((plan, onStep) => runFlash(plan, { onStep, wait: false })); // the next one goes on right after the upload

  const pending: Device[] = [];
  const shown = new Map<string, { state: WatchState; online: boolean }>();
  const queue: string[] = [];
  const retryAt = new Map<string, number>();
  const requested = new Set<string>();
  const problems = new Map<string, string>(); // the text of each problem now
  let releases: ReleaseList | undefined;
  let lastScan = -Infinity;
  let scanning: Promise<void> | undefined;
  let flashing: { key: string; done: Promise<void> } | undefined;
  let pausedUntil = 0;
  let setup = '';
  let stopped = false;
  let browser: { stop: () => void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let ticking = false;
  let again = false;
  let blockedOnce = false; // the last scan looked blocked

  const problem = (kind: 'releases' | 'blocked' | 'download' | 'error', message?: Msg) => {
    if (problems.get(kind) === message?.message) return;
    if (message === undefined) problems.delete(kind);
    else problems.set(kind, message.message);
    onEvent({ kind: 'problem', problem: kind, message });
  };

  async function lookAround(): Promise<void> {
    const found = await scan();
    pending.push(...found.devices);
    onEvent({ kind: 'scanned', at: new Date(now()).toISOString() });
    refresh(); // take in what was found right away
    if (!looksBlocked(found)) {
      blockedOnce = false;
      problem('blocked');
    } else if (blockedOnce || problems.has('blocked')) {
      problem('blocked', { message: 'blocked' });
    } else {
      // a single scan can be turned away for a moment although access is allowed (seen right after
      // the start on macOS): the hint only shows when the next scan, soon, looks blocked as well
      blockedOnce = true;
      lastScan = now() - scanEveryMs + recheckAfterMs;
    }
  }

  async function flash(d: KnownDevice, tag: string, settings: Settings, manual: boolean): Promise<void> {
    const step = (s: 'prepare' | 'download' | 'upload' | 'reboot', percent?: number) => onEvent({ kind: 'step', device: d, step: s, percent });
    let outcome: FlashOutcome;
    try {
      step('prepare');
      let quarter = -1;
      const plan = await prepare(
        d.ip,
        tag,
        (done, total) => {
          const q = total ? Math.floor((done / total) * 4) : -1;
          if (q !== quarter) step('download', q >= 0 ? q * 25 : undefined);
          quarter = q;
        },
        manual,
      );
      problem('download');
      if (releases) await pruneArchives(p, archivesToKeep(releases.releases, settings));
      outcome = await run(plan, (s) => step(s));
      const r = outcome;
      await updateKnown(p, (list) => {
        const rec = list.find((k) => k.key === d.key);
        if (rec) recordResult(rec, tag, r, new Date(now()));
      });
      if (r.result === 'failed' || r.result === 'wrong-version') retryAt.set(d.key, now() + retryAfterMs);
    } catch (e) {
      const err = e instanceof AppError ? e : undefined;
      outcome = { result: 'stopped', ...toMsg(e), ...(err?.kind && { kind: err.kind }) };
      if (err?.kind === 'download') {
        pausedUntil = now() + retryAfterMs;
        problem('download', toMsg(err));
      } else if (err?.kind === 'unsupported' || err?.kind === 'target') {
        await updateKnown(p, (list) => {
          const rec = list.find((k) => k.key === d.key);
          if (rec) recordError(rec, tag, err, new Date(now()));
        });
      } else {
        retryAt.set(d.key, now() + retryAfterMs);
      }
    }
    onEvent({ kind: 'result', device: d, to: tag, outcome });
  }

  async function tick(): Promise<void> {
    const t = now();
    if (t - lastScan >= scanEveryMs) {
      const r = await releasesNow();
      releases = r.list ?? releases;
      problem('releases', r.error);
      if (!scanning && !stopped) {
        lastScan = t;
        scanning = lookAround()
          .catch((e: unknown) => problem('error', toMsg(e)))
          .finally(() => (scanning = undefined));
      }
    }
    const settings = await loadSettings(p);
    const target = settings.targetMajor === undefined || !releases ? undefined : targetRelease(releases.releases, settings.targetMajor, settings.releaseCandidates);
    const current = JSON.stringify([settings, target?.tag, !!releases]);
    if (current !== setup) {
      setup = current;
      onEvent({ kind: 'setup', settings, releases, target });
    }

    const found = pending.splice(0);
    const later: { device: KnownDevice; to: string; result: FlashResult }[] = [];
    // written only when something was found, so changes from another command are rarely in the way
    const list = !found.length
      ? await loadKnown(p)
      : (
          await updateKnown(p, (known) => {
            for (const d of found) {
              const r = seen(known, d, new Date(t));
              if (r.confirmed) later.push({ device: r.device, ...r.confirmed });
            }
          })
        ).list;
    for (const l of later) onEvent({ kind: 'result', device: l.device, to: l.to, outcome: l.result, later: true });

    const keys = new Set(list.map((d) => d.key));
    for (const key of [...shown.keys()]) {
      if (keys.has(key)) continue;
      shown.delete(key);
      requested.delete(key);
      onEvent({ kind: 'removed', key });
    }
    for (let i = queue.length - 1; i >= 0; i--) if (!keys.has(queue[i]!)) queue.splice(i, 1);

    for (const d of list) {
      const online = t - Date.parse(d.lastSeen) < offlineAfterMs;
      let state: WatchState = knownState(d, target);
      // by hand: an update, or an own build (its button is the one way to flash it)
      const byHand = requested.has(d.key) && (state === 'update' || state === 'custom-build');
      if (requested.has(d.key) && (!byHand || !online) && flashing?.key !== d.key) requested.delete(d.key);
      const auto = state === 'update' && settings.autoUpdate && (retryAt.get(d.key) ?? 0) <= t;
      const wanted = online && !!target && (auto || byHand);
      const at = queue.indexOf(d.key);
      if (wanted && at < 0) queue.push(d.key);
      if (!wanted && at >= 0 && flashing?.key !== d.key) queue.splice(at, 1);
      if (flashing?.key === d.key) state = 'flashing';
      else if (queue.includes(d.key)) state = 'queued';
      const before = shown.get(d.key);
      if (!before || before.state !== state || before.online !== online) {
        shown.set(d.key, { state, online });
        onEvent({ kind: 'device', device: d, state, online, before });
      }
    }

    if (!flashing && !stopped && target && t >= pausedUntil && queue[0]) {
      const d = list.find((k) => k.key === queue[0])!;
      const key = d.key;
      shown.set(key, { state: 'flashing', online: true });
      onEvent({ kind: 'device', device: d, state: 'flashing', online: true, before: { state: 'queued', online: true } });
      flashing = {
        key,
        done: flash(d, target.tag, settings, requested.has(key)).finally(() => {
          queue.splice(queue.indexOf(key), 1);
          requested.delete(key);
          flashing = undefined;
          refresh();
        }),
      };
    }
  }

  async function loop(): Promise<void> {
    ticking = true;
    try {
      await tick();
    } catch (e) {
      problem('error', toMsg(e));
    }
    ticking = false;
    if (!stopped) timer = setTimeout(() => void loop(), again ? 0 : tickMs);
    again = false;
  }

  // A round right away, e.g. after a click; with rescan also a new scan and a fresh look at the releases.
  function refresh(rescan = false): void {
    if (rescan) lastScan = -Infinity;
    if (!started || stopped) return;
    if (ticking) again = true;
    else {
      clearTimeout(timer);
      void loop();
    }
  }

  return {
    tick,
    refresh,
    // Flashes this device as soon as it is its turn, also with auto update off or as an own build.
    request(key: string): void {
      requested.add(key);
      refresh();
    },
    start(): void {
      started = true;
      browser = (deps.browse ?? ((cb) => browseMdns(cb, 10_000)))((d) => {
        pending.push(d);
        // an answer over mDNS means the network is open now (e.g. macOS just asked for the permission),
        // without waiting up to a minute for the next scan
        blockedOnce = false;
        problem('blocked');
      });
      void loop();
    },
    flashing: (): boolean => !!flashing,
    // Waits for a running scan and flash to end (used by tests).
    async settled(): Promise<void> {
      while (scanning || flashing) await Promise.all([scanning, flashing?.done]);
    },
    // Stops looking and starting flashes; resolves once a running flash has ended.
    async stop(): Promise<void> {
      stopped = true;
      clearTimeout(timer);
      browser?.stop();
      await flashing?.done;
    },
  };
}
