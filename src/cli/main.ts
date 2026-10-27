#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { archivesToKeep, pruneArchives } from '../core/archive.ts';
import { discover, looksBlocked, type Device } from '../core/discovery.ts';
import { AppError } from '../core/errors.ts';
import { prepareFlash, runFlash, type FlashPlan, type FlashResult } from '../core/flash.ts';
import {
  dismiss as dismissNotice,
  findKnown,
  rename,
  knownState,
  loadKnown,
  MAX_FAILURES,
  recordError,
  recordResult,
  seen,
  updateKnown,
  type KnownDevice,
} from '../core/known.ts';
import { paths, type Paths } from '../core/paths.ts';
import { checkReleases, currentReleases, majorVersions, targetRelease, type ReleaseList, type VersionedRelease } from '../core/releases.ts';
import { loadSettings, saveSettings, type Settings } from '../core/settings.ts';
import { deviceState } from '../core/state.ts';
import { compareVersions, MIN_MAJOR } from '../core/version.ts';
import { createWatcher, type WatchEvent, type WatchState } from '../core/watch.ts';
import { deviceLabel, MAX_NAME } from '../server/api.ts';
import { noteRunning, running, type Runner } from '../server/running.ts';
import { startServer } from '../server/server.ts';

const HELP = `Usage: elrs-auto-flash <command> [options]

Commands:
  ui         open the browser interface: keeps looking for devices and, with auto update on,
             flashes them, like watch
  list       look for ELRS receivers and transmitter modules on the network and show them,
             with their state against the target version
  releases   check GitHub for ExpressLRS releases and show the newest of each major version
  update <device>
             flash one device to the target version, keeping its binding phrase, regulatory
             domain and WiFi; <device> is its IP address, MAC, own name, Lua name or product name
  watch      keep looking for devices until Ctrl+C; with auto update on, flash every device
             with an update, one at a time
  dismiss <device>
             clear the notice of a device whose target was refused or that failed 3 times,
             so it is flashed again
  forget <device>
             remove a device from the list of known devices
  rename <device> <name>
             give a device its own name, to tell devices of the same kind apart ("" removes it)
  settings   show the settings, or change them with the options below

Options:
  --time <seconds>               list, update: how long to listen for devices (default 10)
  --dry-run                      update: prepare the file and show what would happen, send nothing
  --yes                          update: flash without asking
  --target-major <n|none>        settings: major version all devices are kept on, e.g. 4
  --auto-update <on|off>         settings: let watch flash devices with an update without asking
  --release-candidates <on|off>  settings: also bring devices to release candidates
`;

const NOTHING_FOUND = `No ELRS devices found.
A device is only on the network while its WiFi is on: power it without its transmitter and wait about
a minute, or turn on WiFi in the ELRS Lua script. To join your home network instead of opening its own
"ExpressLRS RX" network, the home network must be set up once in the device's web page.`;

const BLOCKED =
  process.platform === 'darwin'
    ? `Almost every address on the network answered "no route to host" at once: macOS does not let this
terminal into the local network. Allow it in System Settings, Privacy & Security, Local Network (for
example Terminal, iTerm or Visual Studio Code), then quit the app and open it again.`
    : `Almost every address on the network answered "no route to host" at once: the system or a firewall
seems to block this program from the local network.`;

class UserError extends Error {}

const via = (d: Device) => d.via.map((v) => (v === 'mdns' ? 'mDNS' : 'scan')).join(', ');
// Local date and time, e.g. 2026-10-25 15:04
const when = (iso: string) => {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
const onOff = (b: boolean) => (b ? 'on' : 'off');

function target(s: Settings, list: ReleaseList | undefined): VersionedRelease | undefined {
  return s.targetMajor === undefined || !list ? undefined : targetRelease(list.releases, s.targetMajor, s.releaseCandidates);
}

// What the target version is, and whether a newer major version is out.
function targetLines(s: Settings, list: ReleaseList | undefined, t: VersionedRelease | undefined): string[] {
  if (s.targetMajor === undefined) return ['No target version set, so nothing would be updated. Choose one, e.g.: settings --target-major 4'];
  if (!list) return [`Target: major version ${s.targetMajor}, but no list of releases yet (run "releases").`];
  if (!t) return [`Target: major version ${s.targetMajor}, but ExpressLRS has no release of it.`];
  const lines = [`Target version: ${t.tag} (newest ${s.releaseCandidates ? 'release incl. release candidates' : 'release'} of ${s.targetMajor}.x)`];
  const newest = majorVersions(list.releases)[0];
  if (newest !== undefined && newest > s.targetMajor) {
    lines.push(`ExpressLRS ${newest}.x is out. Transmitters and receivers need the same major version: switch with "settings --target-major ${newest}" once your transmitters are on ${newest}.x.`);
  }
  return lines;
}

function stateLine(d: Partial<KnownDevice>, state: WatchState, t: VersionedRelease | undefined): string {
  switch (state) {
    case 'current':
      return 'up to date';
    case 'update':
      return `update available: ${d.version} → ${t!.tag}`;
    case 'newer':
      return `newer than the target version ${t!.tag}, left as it is`;
    case 'custom-build':
      return 'custom build (branch name instead of a version), only updated by hand';
    case 'no-target-version':
      return 'no target version';
    case 'unsupported':
      if (d.unsupported && d.unsupported.tag === t?.tag) return `cannot be flashed with ${t.tag}: ${d.unsupported.reason}`;
      return d.version ? `not supported: below ExpressLRS ${MIN_MAJOR}.0` : 'not supported: no version reported';
    case 'unconfirmed':
      return d.type === 'tx'
        ? `flashed to ${d.unconfirmed?.tag}, not seen since; confirmed once its WiFi is turned on again in the radio's ExpressLRS menu`
        : `flashed to ${d.unconfirmed?.tag}, not seen since; confirmed once it is back on the network`;
    case 'mismatch':
      return `firmware does not match its target, nothing flashed, never forced: ${d.notice?.message}
            Check the device, then "dismiss ${d.mac ?? d.ip}" to let it be flashed again.`;
    case 'failed':
      return `${MAX_FAILURES} attempts failed, the last: ${d.notice?.message}
            Check the device, then "dismiss ${d.mac ?? d.ip}" to let it be flashed again.`;
    case 'queued':
      return 'waiting to be flashed';
    case 'flashing':
      return 'being flashed';
  }
}


async function list(p: Paths, seconds: number): Promise<void> {
  const s = await loadSettings(p);
  const { list: releases, error } = await currentReleases(p);
  if (error) console.log(`Could not check for releases: ${error.message}${releases ? ` (using the list from ${when(releases.checked)})` : ''}`);
  const t = target(s, releases);
  targetLines(s, releases, t).forEach((l) => console.log(l));
  console.log(`\nLooking for ELRS devices for ${seconds} s ...`);
  const found = await discover({ seconds });
  const { devices } = found;
  const { list: all, value: records } = await updateKnown(p, (l) => devices.map((d) => seen(l, d).device));
  const away = all.filter((k) => !records.includes(k));
  if (devices.length === 0) console.log(looksBlocked(found) ? BLOCKED : NOTHING_FOUND);
  else console.log(`${devices.length} ${devices.length === 1 ? 'device' : 'devices'} found:\n`);
  devices.forEach((d, i) => {
    const rec = records[i]!;
    const kind = d.type === 'tx' ? 'transmitter module' : d.type === 'rx' ? 'receiver' : 'unknown type';
    console.log(`${deviceLabel(rec)}  (${kind})`);
    if (d.product && d.product !== d.device) console.log(`  Product   ${d.product}`);
    console.log(`  Version   ${d.version ?? 'unknown'}`);
    console.log(`  State     ${stateLine(rec, knownState(rec, t), t)}`);
    console.log(`  Target    ${d.target ?? 'unknown'}`);
    const domain = [d.domainHigh, d.domainLow].filter(Boolean).join(', ');
    console.log(`  Domain    ${domain || 'unknown'}`);
    console.log(`  Address   ${d.ip}${d.mac ? `  MAC ${d.mac}` : ''}  (found via ${via(d)})\n`);
  });
  if (away.length > 0) {
    console.log(`${devices.length ? '' : '\n'}Known, but not on the network now:\n`);
    for (const k of away) {
      console.log(`${deviceLabel(k)}  (last seen ${when(k.lastSeen)} at ${k.ip}${k.mac ? `, MAC ${k.mac}` : ''})`);
      console.log(`  Version   ${k.version ?? 'unknown'}`);
      console.log(`  State     ${stateLine(k, knownState(k, t), t)}\n`);
    }
  }
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/; // a port only for test devices

// The address of the device meant by an IP, MAC, own name, Lua name or product name; anything but an
// IP is looked up on the network and must match exactly one device. An own name stands for the MAC
// of the known device that carries it.
async function findDevice(p: Paths, name: string, seconds: number): Promise<string> {
  if (IPV4.test(name)) return name;
  const lower = name.toLowerCase();
  const own = (await loadKnown(p)).filter((k) => k.name?.toLowerCase() === lower && k.mac);
  const mac = own.length === 1 ? own[0]!.mac! : name.replace(/[:-]/g, '').toUpperCase();
  console.log(`Looking for "${name}" for ${seconds} s ...`);
  const found = await discover({ seconds });
  if (found.devices.length === 0) throw new UserError(looksBlocked(found) ? BLOCKED : NOTHING_FOUND);
  const matches = found.devices.filter(
    (d) => d.mac === mac || d.device?.toLowerCase() === lower || d.product?.toLowerCase() === lower,
  );
  const line = (d: Device) => `  ${d.ip}  ${d.mac ?? '            '}  ${d.device ?? '-'}  ${d.product ?? 'Unknown product'}  ${d.version ?? ''}`;
  if (matches.length === 1) return matches[0]!.ip;
  if (matches.length === 0) {
    throw new UserError(`No device matches "${name}". Found:\n${found.devices.map(line).join('\n')}\nName one by its IP address, MAC, own name, Lua name or product name.`);
  }
  throw new UserError(`${matches.length} devices match "${name}":\n${matches.map(line).join('\n')}\nName one by its IP address or MAC.`);
}

function showPlan(plan: FlashPlan): void {
  const d = plan.device;
  const kind = d.type === 'tx' ? 'transmitter module' : 'receiver';
  const mb = (plan.upload.data.length / 1e6).toFixed(1);
  console.log(`\nDevice      ${d.product} (${kind}) at ${plan.ip}`);
  console.log(`Version     ${d.version} → ${plan.to}`);
  console.log(`Target      ${d.target}, regulatory domain ${[d.domainHigh, d.domainLow].filter(Boolean).join(', ') || 'unknown'}`);
  console.log(`Firmware    ${plan.archiveFile} (${plan.folder} file) from the archive of ${plan.to}`);
  console.log(`Upload      ${plan.upload.name}, ${mb} MB${plan.esp8285 ? ', packed with gzip (ESP8285)' : ''}`);
  console.log(`Names       product "${plan.productName}", Lua "${plan.luaName}"`);
  console.log(
    `Hardware    ${plan.hardwareFrom === 'device' ? "the device's own layout (changed in its web page), unchanged" : `layout of this product from ${plan.to}`}`,
  );
  console.log(`Options     carried over unchanged: ${plan.optionNames.join(', ')}`);
  if (plan.optionNames.includes('flash-discriminator')) {
    console.log('            flash-discriminator unchanged, so the device keeps its binding and settings');
  }
  console.log('Checked     the file carries the target of the device');
  if (deviceState(d.version, undefined) === 'custom-build') {
    console.log(`\nThe device runs a custom build (${d.version}). If that build is newer than ${plan.to}, flashing can reset`);
    console.log('its settings (e.g. model match, outputs, protocol); the options above, binding phrase and WiFi, stay.');
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

function resultLines(r: FlashResult, to: string): { ok: boolean; text: string } {
  switch (r.result) {
    case 'done':
      return { ok: true, text: `Done: the device is back and runs ${r.version}.` };
    case 'unconfirmed':
      if (r.check === 'wifi-off') {
        return {
          ok: true,
          text: `Uploaded. A transmitter module restarts with its WiFi off, so ${to} is not confirmed yet.
Turn its WiFi on again in the radio's ExpressLRS menu, then check with "list".`,
        };
      }
      return {
        ok: true,
        text: `Uploaded, but the device did not come back within 3 minutes, so ${to} is not confirmed yet.
Leave its transmitter off: after a restart its WiFi comes on again after about 60 s. Then check with "list".`,
      };
    case 'wrong-version':
      return { ok: false, text: `The device is back, but still runs ${r.version} instead of ${to}. The update did not take.` };
    case 'mismatch':
      return {
        ok: false,
        text: `The device refused the file because it is not for its target: ${r.message}
Nothing was flashed. This is never forced.`,
      };
    case 'failed':
      return { ok: false, text: `The upload failed: ${r.message}\nCheck the device with "list" before trying again.` };
  }
}

async function update(p: Paths, name: string, opts: { seconds: number; dryRun: boolean; yes: boolean }): Promise<void> {
  const other = await running(p.server);
  if (other) {
    const button = other.kind === 'app' || other.kind === 'browser' ? `\nOr use the device's button there.` : '';
    throw new UserError(`${busy(other)}.${button}`);
  }
  const forget = await noteRunning(p.server, { kind: 'update' });
  try {
    await updateDevice(p, name, opts);
  } finally {
    await forget();
  }
}

async function updateDevice(p: Paths, name: string, opts: { seconds: number; dryRun: boolean; yes: boolean }): Promise<void> {
  const s = await loadSettings(p);
  const { list: releases, error } = await currentReleases(p);
  if (error) console.log(`Could not check for releases: ${error.message}${releases ? ` (using the list from ${when(releases.checked)})` : ''}`);
  const t = target(s, releases);
  if (!t || !releases) throw new UserError(targetLines(s, releases, t).join('\n'));
  const ip = await findDevice(p, name, opts.seconds);
  const noticed = (await loadKnown(p)).find((k) => k.ip === ip && k.notice);
  if (noticed) throw new UserError(`${noticed.product ?? 'The device'}: ${stateLine(noticed, knownState(noticed, t), t)}`);

  let shown = -1;
  const plan = await prepareFlash(p, ip, t.tag, true, {
    onDownload: (done, total) => {
      const pct = total ? Math.floor((done / total) * 100) : -1;
      if (pct === shown || !process.stdout.isTTY) return;
      shown = pct;
      process.stdout.write(`\rDownloading the firmware of ${t.tag} ... ${pct >= 0 ? `${pct} %` : `${(done / 1e6).toFixed(0)} MB`}`);
    },
  })
    .catch(async (e: unknown) => {
      if (e instanceof AppError) await updateKnown(p, (l) => l.filter((k) => k.ip === ip).forEach((k) => recordError(k, t.tag, e)));
      throw e;
    })
    .finally(() => shown !== -1 && process.stdout.write('\n'));
  const { value: key } = await updateKnown(p, (l) => seen(l, { ...plan.device, ip, via: [] }).device.key);
  for (const gone of await pruneArchives(p, archivesToKeep(releases.releases, s))) console.log(`Removed the firmware archive of ${gone}.`);
  showPlan(plan);

  if (opts.dryRun) {
    console.log('\nDry run: nothing was sent to the device.');
    return;
  }
  if (!opts.yes && !(await confirm('\nFlash this device now? [y/N] '))) {
    console.log(process.stdin.isTTY ? 'Not flashed.' : '\nNot flashed: add --yes to flash without asking.');
    return;
  }
  const r = await runFlash(plan, {
    onStep: (step) =>
      console.log(step === 'upload' ? '\nUploading ...' : 'Uploaded. The device restarts; waiting up to 3 minutes for it to come back ...'),
  });
  await updateKnown(p, (l) => l.filter((k) => k.key === key).forEach((k) => recordResult(k, plan.to, r)));
  const { ok, text } = resultLines(r, plan.to);
  console.log(text);
  if (!ok) process.exitCode = 1;
}

// The known device meant by name, from the list kept on this computer (no search on the network).
async function knownDevice(p: Paths, name: string): Promise<KnownDevice> {
  const all = await loadKnown(p);
  const matches = findKnown(all, name);
  const line = (k: KnownDevice) => `  ${k.ip}  ${k.mac ?? '            '}  ${deviceLabel(k)}  ${k.product ?? 'Unknown product'}`;
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new UserError(
      all.length ? `No known device matches "${name}". Known:\n${all.map(line).join('\n')}` : 'No devices known yet. Find them with "list" or "watch".',
    );
  }
  throw new UserError(`${matches.length} known devices match "${name}":\n${matches.map(line).join('\n')}\nName one by its IP address or MAC.`);
}

async function dismissCommand(p: Paths, name: string): Promise<void> {
  const { key, product, notice } = await knownDevice(p, name);
  if (!notice) {
    console.log(`${product ?? 'The device'} has no notice to dismiss.`);
    return;
  }
  await updateKnown(p, (l) => l.filter((k) => k.key === key).forEach(dismissNotice));
  console.log(`Dismissed the notice of ${product ?? 'the device'}. It is flashed again by auto update or "update".`);
}

async function forget(p: Paths, name: string): Promise<void> {
  const { key, product } = await knownDevice(p, name);
  // gone or moved to its MAC since it was looked up (e.g. by the running app): then nothing is removed
  const { value: removed } = await updateKnown(p, (l) => {
    const at = l.findIndex((k) => k.key === key);
    return at >= 0 && l.splice(at, 1).length > 0;
  });
  if (!removed) throw new UserError(`${product ?? 'The device'} changed in the list meanwhile; nothing was removed. Try again.`);
  console.log(`Removed ${product ?? 'the device'} from the known devices. It is added again when it is found.`);
}

async function renameCommand(p: Paths, which: string, name: string): Promise<void> {
  const { key } = await knownDevice(p, which);
  const { list } = await updateKnown(p, (l) => l.filter((k) => k.key === key).forEach((k) => rename(k, name, MAX_NAME)));
  const d = list.find((k) => k.key === key)!;
  console.log(d.name ? `Named it "${d.name}": shown as ${deviceLabel(d)}.` : `Removed its own name: shown as ${deviceLabel(d)}.`);
}

const clock = () => new Date().toTimeString().slice(0, 8);
const named = (d: KnownDevice) => `${deviceLabel(d)} (${d.ip})`;

// The target version of the running watch, for the state lines of its devices.
let watchTarget: VersionedRelease | undefined;
const stateLineFor = (e: Extract<WatchEvent, { kind: 'device' }>) => stateLine(e.device, e.state, watchTarget).replace(/\n\s+/g, ' ');

function watchLine(e: WatchEvent): string | undefined {
  switch (e.kind) {
    case 'setup':
      return [
        ...targetLines(e.settings, e.releases, e.target),
        e.settings.autoUpdate
          ? 'Auto update is on: devices with an update are flashed one at a time.'
          : 'Auto update is off: devices are only shown. Turn it on with "settings --auto-update on" (also while this runs).',
      ].join('\n');
    case 'device': {
      const { device: d, state, online, before } = e;
      if (state === 'flashing') return undefined;
      if (!online) return before?.online ? `${named(d)}: left the network` : `${named(d)}: known, not on the network (last seen ${when(d.lastSeen)}), ${stateLineFor(e)}`;
      if (!before?.online) return `${named(d)}: ${before ? 'back' : 'found'}, ${d.version ?? 'no version'}, ${stateLineFor(e)}`;
      return `${named(d)}: ${stateLineFor(e)}`;
    }
    case 'step':
      if (e.step === 'prepare') return `${named(e.device)}: preparing the firmware`;
      if (e.step === 'download') return `${named(e.device)}: downloading the firmware archive${e.percent !== undefined ? ` ... ${e.percent} %` : ''}`;
      if (e.step === 'upload') return `${named(e.device)}: uploading`;
      return `${named(e.device)}: uploaded; the device restarts, waiting up to 3 minutes for it to come back`;
    case 'result': {
      const o = e.outcome;
      const n = named(e.device);
      if (o.result === 'stopped') {
        if (o.kind === 'gone') return `${n}: no longer answers; tried again when it is back`;
        if (o.kind === 'download') return `${n}: ${o.message} Trying again in a minute.`;
        if (o.kind === 'unsupported') return `${n}: cannot be flashed with ${e.to}: ${o.message}`;
        return `${n}: ${o.message}`;
      }
      if (e.later && o.result === 'done') return `${n}: back with ${o.version}, update confirmed`;
      if (e.later && o.result === 'wrong-version') return `${n}: back, but still runs ${o.version}; tried again (at most ${MAX_FAILURES} times)`;
      if (o.result === 'done') return `${n}: done, runs ${o.version}`;
      if (o.result === 'unconfirmed' && o.check === 'later') return `${n}: uploaded; confirmed once it is back on the network`;
      if (o.result === 'unconfirmed' && o.check === 'wifi-off') return `${n}: uploaded; turn its WiFi on again in the radio's ExpressLRS menu to confirm the update`;
      if (o.result === 'unconfirmed') return `${n}: not back within 3 minutes; confirmed once it shows up again`;
      if (o.result === 'wrong-version') return `${n}: still runs ${o.version} after the update; tried again in a minute (at most ${MAX_FAILURES} times)`;
      if (o.result === 'failed') return `${n}: upload failed: ${o.message}; tried again in a minute (at most ${MAX_FAILURES} times)`;
      return `${n}: refused the firmware as not for its target: ${o.message} It is never forced.`;
    }
    case 'problem':
      if (e.message === undefined || e.problem === 'download') return undefined; // gone again, or reported with the device
      if (e.problem === 'blocked') return BLOCKED;
      if (e.problem === 'releases') return `Could not check for releases: ${e.message.message}`;
      return `Error: ${e.message.message}`;
    case 'removed':
    case 'scanned':
      return undefined;
  }
}

const REPO_ROOT = resolve(import.meta.dirname, '../..');

function openBrowser(url: string): void {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

// Only one thing flashes devices at a time: what runs already, and how to end it.
function busy(r: Runner & { pid: number }): string {
  switch (r.kind) {
    case 'app':
      return 'The ELRS Auto Flash app runs and flashes devices; quit it first';
    case 'browser':
      return `The browser interface runs at ${r.url} and flashes devices; stop it first (Ctrl+C in the terminal where it runs)`;
    case 'watch':
      return `watch runs in another terminal (process ${r.pid}) and flashes devices; stop it first (Ctrl+C there)`;
    case 'update':
      return `update flashes a device in another terminal (process ${r.pid}); wait until it is done`;
  }
}

async function ui(p: Paths): Promise<void> {
  const staticDir = join(REPO_ROOT, 'dist', 'ui');
  if (!existsSync(join(staticDir, 'index.html'))) throw new UserError('Build the interface first: npm run build');
  const other = await running(p.server);
  if (other?.kind === 'app' || other?.kind === 'browser') {
    console.log(`ELRS Auto Flash already runs at ${other.url}`);
    openBrowser(other.url);
    return;
  }
  if (other) throw new UserError(`${busy(other)}.`);
  // a free port; a second start finds this one through the note, so two servers never flash the same devices
  const server = await startServer({ paths: p, port: 0, staticDir });
  const forget = await noteRunning(p.server, { kind: 'browser', url: server.open });
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(130);
    stopping = true;
    if (server.flashing()) console.log('\nA device is being flashed: stopping once it is done. Press Ctrl+C again to quit right away.');
    void server.close().finally(() => void forget().finally(() => process.exit(0)));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`ELRS Auto Flash runs at ${server.open} (Ctrl+C to stop)`);
  openBrowser(server.open);
}

async function watch(p: Paths): Promise<void> {
  const other = await running(p.server);
  if (other) throw new UserError(`${busy(other)}.`);
  const forget = await noteRunning(p.server, { kind: 'watch' });
  console.log('Watching for ELRS devices (mDNS, and a scan of the network every minute). Ctrl+C to stop.\n');
  const w = createWatcher(p, (e) => {
    if (e.kind === 'setup') watchTarget = e.target;
    const line = watchLine(e);
    if (line) console.log(e.kind === 'setup' ? `${line}\n` : `${clock()}  ${line}`);
  });
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    if (w.flashing()) console.log('\nA device is being flashed: stopping once it is done. Press Ctrl+C again to quit right away.');
    void w.stop().finally(() => void forget().finally(() => process.exit(0)));
  });
  w.start();
}

async function releases(p: Paths): Promise<void> {
  const s = await loadSettings(p);
  const list = await checkReleases(p);
  console.log(`ExpressLRS releases (checked ${when(list.checked)}):`);
  for (const major of majorVersions(list.releases)) {
    const final = targetRelease(list.releases, major, false)!;
    const rc = targetRelease(list.releases, major, true)!;
    const rcNote = compareVersions(rc.version, final.version) > 0 ? `, release candidate ${rc.tag}` : '';
    const mark = major === s.targetMajor ? '   <- target' : '';
    console.log(`  ${major}.x  ${final.tag} (${final.published.slice(0, 10)})${rcNote}${mark}`);
  }
}

function parseOnOff(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'on' || value === 'off') return value === 'on';
  throw new UserError(`--${name} needs "on" or "off".`);
}

async function settings(p: Paths, opts: { targetMajor?: string; autoUpdate?: string; releaseCandidates?: string }): Promise<void> {
  const s = await loadSettings(p);
  const autoUpdate = parseOnOff('auto-update', opts.autoUpdate);
  const releaseCandidates = parseOnOff('release-candidates', opts.releaseCandidates);
  let changed = autoUpdate !== undefined || releaseCandidates !== undefined;
  if (autoUpdate !== undefined) s.autoUpdate = autoUpdate;
  if (releaseCandidates !== undefined) s.releaseCandidates = releaseCandidates;
  if (opts.targetMajor === 'none') {
    delete s.targetMajor;
    changed = true;
  } else if (opts.targetMajor !== undefined) {
    const major = Number(opts.targetMajor);
    if (!Number.isInteger(major) || major < MIN_MAJOR) throw new UserError(`--target-major needs a major version from ${MIN_MAJOR} on, e.g. 4, or "none".`);
    const { list } = await currentReleases(p);
    if (list && !majorVersions(list.releases).includes(major)) {
      throw new UserError(`ExpressLRS has no release of ${major}.x. Known: ${majorVersions(list.releases).map((m) => `${m}.x`).join(', ')}.`);
    }
    s.targetMajor = major;
    changed = true;
  }
  if (changed) await saveSettings(p, s);
  console.log(`Target major version  ${s.targetMajor === undefined ? 'none' : `${s.targetMajor}.x`}`);
  console.log(`Auto update           ${onOff(s.autoUpdate)}`);
  console.log(`Release candidates    ${onOff(s.releaseCandidates)}`);
  if (changed) {
    const { list } = await currentReleases(p);
    targetLines(s, list, target(s, list)).forEach((l) => console.log(`\n${l}`));
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      time: { type: 'string' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      'target-major': { type: 'string' },
      'auto-update': { type: 'string' },
      'release-candidates': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command] = positionals;
  if (!command || values.help) {
    console.log(HELP);
    return;
  }
  const p = paths();
  const seconds = values.time === undefined ? 10 : Number(values.time);
  if (!Number.isFinite(seconds) || seconds < 1) throw new UserError('--time needs a number of seconds, at least 1.');
  switch (command) {
    case 'ui':
      return ui(p);
    case 'list':
      return list(p, seconds);
    case 'update': {
      const name = positionals[1];
      if (!name || positionals.length > 2) throw new UserError('update needs one device: its IP address, MAC, own name, Lua name or product name (in quotes).');
      return update(p, name, { seconds, dryRun: !!values['dry-run'], yes: !!values.yes });
    }
    case 'watch':
      return watch(p);
    case 'dismiss':
    case 'forget': {
      const name = positionals[1];
      if (!name || positionals.length > 2) throw new UserError(`${command} needs one device: its IP address, MAC, own name, Lua name or product name (in quotes).`);
      return command === 'dismiss' ? dismissCommand(p, name) : forget(p, name);
    }
    case 'rename': {
      const [, which, name] = positionals;
      if (!which || name === undefined || positionals.length > 3) {
        throw new UserError('rename needs a device and a name, e.g.: rename A1B2C3D4E5F6 "5 inch freestyle" ("" removes the name).');
      }
      return renameCommand(p, which, name);
    }
    case 'releases':
      return releases(p);
    case 'settings':
      return settings(p, {
        targetMajor: values['target-major'],
        autoUpdate: values['auto-update'],
        releaseCandidates: values['release-candidates'],
      });
    default:
      throw new UserError(`Unknown command "${command}".\n\n${HELP}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof UserError || e instanceof AppError ? e.message : e);
  process.exitCode = 1;
});
