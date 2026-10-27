import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { paths } from '../src/core/paths.ts';
import { noteFlasher, runningFlasher } from '../src/server/running.ts';
import { tempDir } from './helpers.ts';

describe('flasher note', () => {
  it('tells of watch or update in another process that still runs, not of this one or a killed one', async () => {
    const p = paths(await tempDir());
    expect(await runningFlasher(p.flasher)).toBeUndefined();
    const forget = await noteFlasher(p.flasher, 'watch');
    expect(await runningFlasher(p.flasher)).toBeUndefined(); // this process itself
    // the parent process runs, so it stands in for another terminal
    await writeFile(p.flasher, JSON.stringify({ command: 'update', pid: process.ppid }));
    expect(await runningFlasher(p.flasher)).toEqual({ command: 'update', pid: process.ppid });
    // the note of the other one stays
    await forget();
    expect(await runningFlasher(p.flasher)).toEqual({ command: 'update', pid: process.ppid });
    await writeFile(p.flasher, JSON.stringify({ command: 'watch', pid: 2 ** 22 + 1 }));
    expect(await runningFlasher(p.flasher)).toBeUndefined();
    await writeFile(p.flasher, 'not json');
    expect(await runningFlasher(p.flasher)).toBeUndefined();
  });
});
