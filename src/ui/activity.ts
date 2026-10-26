import type { ActivityEntry } from '../server/api.ts';

type Entry<T extends ActivityEntry['type']> = Extract<ActivityEntry, { type: T }>;
export type WaveType = 'found' | 'back' | 'left' | 'state';

// What the "Activity" page shows: one line, or devices that did the same at once (found at the start,
// a new target version) as a single line that opens up.
export type ActivityItem =
  | { kind: 'line'; entry: ActivityEntry; from?: string } // a flash shows as its result, with the version from its start
  | { kind: 'wave'; type: WaveType; target?: Entry<'target'>; entries: Entry<WaveType>[] };

export interface ActivityGroup {
  at: string;
  items: ActivityItem[];
}

// From this many lines of the same kind in one minute on, they are shown as one.
export const WAVE_MIN = 3;

const minute = (a: { at: string }) => Math.floor(Date.parse(a.at) / 60_000);
const isWave = (a: ActivityEntry): a is Entry<WaveType> => a.type === 'found' || a.type === 'back' || a.type === 'left' || a.type === 'state';

// The lines, newest first, as groups of one minute each, newest first. A new target version takes
// the state changes right after it.
export function groupActivity(newestFirst: ActivityEntry[]): ActivityGroup[] {
  const all = [...newestFirst].reverse();
  const from = new Map<number, string | undefined>();
  const ended = new Set<number>();
  const running = new Map<string, Entry<'start'>>();
  for (const a of all) {
    if (a.type === 'start' && a.key) running.set(a.key, a);
    if (a.type === 'result' && !a.later && a.key && running.has(a.key)) {
      const start = running.get(a.key)!;
      ended.add(start.id);
      from.set(a.id, start.from);
      running.delete(a.key);
    }
  }
  const list = all.filter((a) => !ended.has(a.id));

  const items: { at: string; item: ActivityItem }[] = [];
  for (let i = 0; i < list.length; ) {
    const a = list[i]!;
    const type = a.type === 'target' ? 'state' : isWave(a) ? a.type : undefined;
    if (type) {
      const run: Entry<WaveType>[] = [];
      let j = a.type === 'target' ? i + 1 : i;
      for (let b = list[j]; b && isWave(b) && b.type === type && minute(b) === minute(a); b = list[++j]) run.push(b);
      if (a.type === 'target' || run.length >= WAVE_MIN) {
        items.push({ at: a.at, item: { kind: 'wave', type, target: a.type === 'target' ? a : undefined, entries: run } });
        i = j;
        continue;
      }
    }
    items.push({ at: a.at, item: { kind: 'line', entry: a, from: from.get(a.id) } });
    i++;
  }

  const groups: ActivityGroup[] = [];
  for (const x of items) {
    const last = groups.at(-1);
    if (last && minute(last) === minute(x)) last.items.push(x.item);
    else groups.push({ at: x.at, items: [x.item] });
  }
  return groups.reverse().map((g) => ({ ...g, items: g.items.reverse() }));
}
