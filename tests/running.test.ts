import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { noteRunning, running } from '../src/server/running.ts';
import { fakeDevice, tempDir } from './helpers.ts';

// the parent of the test process stands in for another program that runs; no process has this id
const OTHER = process.ppid;
const GONE = 999_999;

describe('running', () => {
  it('finds watch and update in another process, not in a killed one nor in this one', async () => {
    const file = join(await tempDir(), 'server.json');
    expect(await running(file)).toBeUndefined();
    await writeFile(file, JSON.stringify({ kind: 'watch', pid: OTHER }));
    expect(await running(file)).toEqual({ kind: 'watch', pid: OTHER });
    await writeFile(file, JSON.stringify({ kind: 'update', pid: OTHER }));
    expect(await running(file)).toEqual({ kind: 'update', pid: OTHER });
    await writeFile(file, JSON.stringify({ kind: 'watch', pid: GONE }));
    expect(await running(file)).toBeUndefined();
    await writeFile(file, JSON.stringify({ kind: 'nonsense', pid: OTHER }));
    expect(await running(file)).toBeUndefined();
    await noteRunning(file, { kind: 'watch' });
    expect(await running(file)).toBeUndefined();
  });

  it('counts a server only while it answers, and takes a note without kind for the browser interface', async () => {
    const file = join(await tempDir(), 'server.json');
    const server = await fakeDevice((_req, res) => res.end('ok'));
    const url = `http://${server.host}/`;
    await writeFile(file, JSON.stringify({ kind: 'app', url, pid: OTHER }));
    expect(await running(file)).toEqual({ kind: 'app', url, pid: OTHER });
    await writeFile(file, JSON.stringify({ url, pid: OTHER }));
    expect(await running(file)).toEqual({ kind: 'browser', url, pid: OTHER });
    await writeFile(file, JSON.stringify({ kind: 'browser', pid: OTHER }));
    expect(await running(file)).toBeUndefined();
    await server.close();
    await writeFile(file, JSON.stringify({ kind: 'app', url, pid: OTHER }));
    expect(await running(file)).toBeUndefined();
  });

  it('removes its own note only, not one another process wrote since', async () => {
    const file = join(await tempDir(), 'server.json');
    const forget = await noteRunning(file, { kind: 'update' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ kind: 'update', pid: process.pid });
    await forget();
    await expect(readFile(file)).rejects.toThrow();
    const again = await noteRunning(file, { kind: 'watch' });
    await writeFile(file, JSON.stringify({ kind: 'watch', pid: OTHER }));
    await again();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ kind: 'watch', pid: OTHER });
  });

  it.skipIf(process.platform === 'win32')('lets only this user read the note, which carries the key in the address', async () => {
    const file = join(await tempDir(), 'server.json');
    await writeFile(file, '{}', { mode: 0o644 });
    await noteRunning(file, { kind: 'app', url: 'http://localhost:1/#token=secret' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
