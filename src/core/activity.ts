import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { deviceLabel, ACTIVITY_DAYS, ACTIVITY_MAX, type ActivityEntry, type FlashOutcome, type WatchState } from '../server/api.ts';
import type { KnownDevice } from './known.ts';
import type { Paths } from './paths.ts';
import type { WatchEvent } from './watch.ts';

// A line of "Activity" as stored: without its number, which each start gives anew.
export type StoredEntry = ActivityEntry extends infer T ? (T extends unknown ? Omit<T, 'id'> : never) : never;
// A line before it gets its time.
export type NewEntry = StoredEntry extends infer T ? (T extends unknown ? Omit<T, 'at'> : never) : never;

// The lines of the last days in activity.jsonl, oldest first. Older and broken lines are dropped from
// the file, so it never grows past what the page shows.
export async function loadActivity(p: Paths, now = Date.now()): Promise<StoredEntry[]> {
  const text = await readFile(p.activity, 'utf8').catch(() => '');
  const from = now - ACTIVITY_DAYS * 86_400_000;
  const rows = text.split('\n').filter(Boolean);
  const kept: StoredEntry[] = [];
  for (const row of rows) {
    try {
      const e = JSON.parse(row) as StoredEntry;
      if (typeof e?.type === 'string' && Date.parse(e.at) >= from) kept.push(e);
    } catch {
      // half a line from a crash
    }
  }
  const list = kept.slice(-ACTIVITY_MAX);
  if (list.length !== rows.length) {
    // a file that can't be written stays as it is; starting goes on all the same
    const tmp = `${p.activity}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, list.map((e) => `${JSON.stringify(e)}\n`).join(''));
      await rename(tmp, p.activity);
    } catch (e) {
      console.error('Old activity not removed:', e);
    }
  }
  return list;
}

// Appends lines in the order they come; a failed write is reported but never stops the caller.
export function activityFile(p: Paths) {
  let chain = Promise.resolve();
  const queue = (job: () => Promise<unknown>) => {
    chain = chain.then(job).then(
      () => {},
      (e: unknown) => console.error('Activity not saved:', e),
    );
    return chain;
  };
  return {
    append: (e: StoredEntry) =>
      queue(async () => {
        await mkdir(dirname(p.activity), { recursive: true });
        await appendFile(p.activity, `${JSON.stringify(e)}\n`);
      }),
    clear: () => queue(() => rm(p.activity, { force: true })),
    flushed: () => chain,
  };
}

// Turns what the watcher reports into lines of "Activity": short, and only what says something new.
export function activityLines(onLine: (e: NewEntry) => void): (e: WatchEvent) => void {
  const named = (d: KnownDevice) => ({ key: d.key, name: deviceLabel(d) });
  let target: string | undefined;
  let setupSeen = false;
  // What a result already says, so the line for the state it leads to is left out: the state a device
  // is expected in next, and devices whose return the result line already reports.
  const expected = new Map<string, WatchState>();
  const backSaid = new Set<string>();
  const leadsTo = (o: FlashOutcome): WatchState => {
    if (o.result === 'done') return 'current';
    if (o.result === 'unconfirmed' || o.result === 'mismatch') return o.result;
    if (o.result === 'stopped' && o.kind === 'unsupported') return 'unsupported';
    if (o.result === 'stopped' && o.kind === 'target') return 'mismatch';
    return 'update';
  };

  return (e) => {
    switch (e.kind) {
      case 'setup':
        if (setupSeen && e.target?.tag !== target) onLine({ type: 'target', to: e.target?.tag });
        setupSeen = true;
        target = e.target?.tag;
        break;
      case 'device': {
        const { device: d, state: now, online, before } = e;
        if (!before) {
          if (online) onLine({ ...named(d), type: 'found', version: d.version, state: now, to: target });
        } else if (online && !before.online) {
          if (!backSaid.delete(d.key)) onLine({ ...named(d), type: 'back', version: d.version, state: now, to: target });
        } else if (!online && before.online) onLine({ ...named(d), type: 'left' });
        // waiting and flashing show on the card; the flash gets its own start line
        else if (now !== before.state && now !== 'flashing' && now !== 'queued' && expected.get(d.key) !== now) {
          onLine({ ...named(d), type: 'state', state: now, to: target });
        }
        if (now !== 'flashing' && now !== before?.state) expected.delete(d.key);
        break;
      }
      case 'step':
        if (e.step === 'prepare' && target) onLine({ ...named(e.device), type: 'start', to: target, from: e.device.version });
        break;
      case 'result':
        expected.set(e.device.key, leadsTo(e.outcome));
        if (e.later) backSaid.add(e.device.key);
        onLine({ ...named(e.device), type: 'result', to: e.to, outcome: e.outcome, later: e.later });
        break;
      case 'problem':
        if (e.message !== undefined && e.problem !== 'download') onLine({ type: 'problem', problem: e.problem, ...e.message });
        break;
    }
  };
}
