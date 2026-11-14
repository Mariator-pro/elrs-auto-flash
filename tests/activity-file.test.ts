import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { activityFile, activityLines, loadActivity, type NewEntry } from '../src/core/activity.ts';
import type { KnownDevice } from '../src/core/known.ts';
import { paths } from '../src/core/paths.ts';
import { tempDir } from './helpers.ts';

const day = 86_400_000;
const NOW = Date.parse('2026-11-14T12:00:00Z');
const at = (daysAgo: number) => new Date(NOW - daysAgo * day).toISOString();

describe('activity file', () => {
  it('appends lines in order and reads them back, oldest first', async () => {
    const p = paths(await tempDir());
    const file = activityFile(p);
    void file.append({ at: at(2), type: 'launch', by: 'app' });
    void file.append({ at: at(1), type: 'left', key: 'A1', name: 'A' });
    await file.flushed();
    expect((await loadActivity(p, NOW)).map((e) => e.type)).toEqual(['launch', 'left']);
  });

  it('drops lines older than 30 days and broken ones, also from the file', async () => {
    const p = paths(await tempDir());
    const lines = [{ at: at(31), type: 'launch', by: 'app' }, { at: at(29), type: 'launch', by: 'watch' }];
    await writeFile(p.activity, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{"at":"2026-11`);
    expect(await loadActivity(p, NOW)).toEqual([lines[1]]);
    expect(await readFile(p.activity, 'utf8')).toBe(`${JSON.stringify(lines[1])}\n`);
  });

  it('is empty without a file and after clearing', async () => {
    const p = paths(await tempDir());
    expect(await loadActivity(p)).toEqual([]);
    const file = activityFile(p);
    void file.append({ at: at(0), type: 'launch', by: 'update' });
    await file.clear();
    expect(await loadActivity(p)).toEqual([]);
  });
});

describe('activityLines', () => {
  const device = (version: string) => ({ key: 'A1', ip: '192.168.1.10', mac: 'A1B2C3D4E5F6', product: 'RX', version, lastSeen: at(0) }) as KnownDevice;

  it('writes a flash as start and result, without the state the result leads to', () => {
    const out: NewEntry[] = [];
    const on = activityLines((e) => out.push(e));
    on({ kind: 'setup', settings: {} as never, target: { tag: '4.1.0' } as never });
    on({ kind: 'device', device: device('4.0.1'), state: 'update', online: true });
    on({ kind: 'step', device: device('4.0.1'), step: 'prepare' });
    on({ kind: 'result', device: device('4.1.0'), to: '4.1.0', outcome: { result: 'done', version: '4.1.0' } });
    on({ kind: 'device', device: device('4.1.0'), state: 'current', online: true, before: { state: 'flashing', online: true } });
    expect(out.map((e) => e.type)).toEqual(['found', 'start', 'result']);
    expect(out[1]).toMatchObject({ to: '4.1.0', from: '4.0.1', name: 'RX · E5F6' });
  });
});
