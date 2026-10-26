import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '../src/server/api.ts';
import { groupActivity } from '../src/ui/activity.ts';

type NewEntry = ActivityEntry extends infer T ? (T extends unknown ? Omit<T, 'id'> : never) : never;

// Lines in the order they happened; the page gets them newest first.
const log = (...lines: NewEntry[]): ActivityEntry[] => lines.map((l, i) => ({ ...l, id: i + 1 }) as ActivityEntry).reverse();
const at = (m: number, s = 0) => `2026-10-26T18:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
const found = (key: string, m: number, state: 'current' | 'update' = 'current'): NewEntry => ({ at: at(m), key, name: key, type: 'found', version: '4.1.0', state, to: '4.1.0' });

describe('groupActivity', () => {
  it('shows devices found in the same minute as one line, fewer one by one', () => {
    const groups = groupActivity(log(found('A', 13), found('B', 13), found('C', 13, 'update'), found('D', 14), found('E', 14)));
    expect(groups.map((g) => g.at)).toEqual([at(14), at(13)]);
    expect(groups[0]!.items.map((i) => i.kind)).toEqual(['line', 'line']);
    expect(groups[1]!.items).toMatchObject([{ kind: 'wave', type: 'found', entries: [{ key: 'A' }, { key: 'B' }, { key: 'C' }] }]);
  });

  it('puts the state changes after a new target version under it, however few', () => {
    const groups = groupActivity(
      log(
        found('A', 13),
        { at: at(20), type: 'target', to: '4.1.0' },
        { at: at(20), key: 'A', name: 'A', type: 'state', state: 'update', to: '4.1.0' },
        { at: at(20), key: 'B', name: 'B', type: 'left' },
      ),
    );
    expect(groups[0]!.items).toMatchObject([
      { kind: 'line', entry: { type: 'left' } },
      { kind: 'wave', type: 'state', target: { to: '4.1.0' }, entries: [{ key: 'A' }] },
    ]);
  });

  it('shows a flash as its result with the version before, a running one as its start', () => {
    const groups = groupActivity(
      log(
        { at: at(41), key: 'A', name: 'A', type: 'start', to: '4.1.0', from: '4.0.1' },
        { at: at(42), key: 'A', name: 'A', type: 'result', to: '4.1.0', outcome: { result: 'unconfirmed', check: 'later' } },
        { at: at(42), key: 'B', name: 'B', type: 'start', to: '4.1.0', from: '3.6.4' },
        { at: at(43), key: 'A', name: 'A', type: 'result', to: '4.1.0', outcome: { result: 'done', version: '4.1.0' }, later: true },
      ),
    );
    expect(groups.map((g) => g.items)).toMatchObject([
      [{ kind: 'line', entry: { type: 'result', later: true }, from: undefined }],
      [
        { kind: 'line', entry: { type: 'start', key: 'B' } },
        { kind: 'line', entry: { type: 'result', key: 'A' }, from: '4.0.1' },
      ],
    ]);
  });
});
