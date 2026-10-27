import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Whatever flashes devices notes itself here: the desktop app, the browser interface (both with the
// address their interface opens at, with the key), the terminal's watch and update. Only one of them runs at a time, so two
// never flash the same device or download the same firmware.

export type Runner = { kind: 'app' | 'browser'; url: string } | { kind: 'watch' | 'update' };

type Note = Runner & { pid: number };

const KINDS = ['app', 'browser', 'watch', 'update'];

async function readNote(file: string): Promise<Note | undefined> {
  try {
    const note = JSON.parse(await readFile(file, 'utf8')) as Partial<Note> & { url?: unknown };
    if (typeof note.pid !== 'number') return undefined;
    // a note from before the kinds: a server, the app's or the browser interface's
    const kind = note.kind ?? 'browser';
    if (!KINDS.includes(kind)) return undefined;
    if (kind === 'app' || kind === 'browser') return typeof note.url === 'string' ? { kind, url: note.url, pid: note.pid } : undefined;
    return { kind, pid: note.pid };
  } catch {
    return undefined;
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists, it just isn't ours to signal
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// What else runs now; a note left by a process that was killed is ignored.
export async function running(file: string): Promise<(Runner & { pid: number }) | undefined> {
  const note = await readNote(file);
  if (!note || note.pid === process.pid || !alive(note.pid)) return undefined;
  if (!('url' in note)) return note;
  // the process id may have gone to another program since: only a server that answers counts
  const res = await fetch(note.url, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
  return res?.ok ? note : undefined;
}

// Notes this process; the returned function removes the note again, unless another one wrote it since.
// The address of a server carries its key, so only this user may read the note.
export async function noteRunning(file: string, runner: Runner): Promise<() => Promise<void>> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ ...runner, pid: process.pid } satisfies Note)}\n`, { mode: 0o600 });
  // a note left from before keeps its own mode
  await chmod(file, 0o600);
  return async () => {
    if ((await readNote(file))?.pid === process.pid) await rm(file, { force: true });
  };
}
