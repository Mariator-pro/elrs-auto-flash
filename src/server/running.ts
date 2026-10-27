import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// The browser interface's server takes a free port and notes it here, so a second start opens the
// running one instead of starting another server that flashes the same devices.

interface Note {
  url: string;
  pid: number;
}

async function readNote(file: string): Promise<Note | undefined> {
  try {
    const note = JSON.parse(await readFile(file, 'utf8')) as Partial<Note>;
    return typeof note.url === 'string' && typeof note.pid === 'number' ? (note as Note) : undefined;
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

// The address of a server that still runs; a note left by a server that was killed is ignored.
export async function runningServer(file: string): Promise<string | undefined> {
  const note = await readNote(file);
  if (!note || !alive(note.pid)) return undefined;
  // the process id may have gone to another program since: only a server that answers counts
  const res = await fetch(note.url, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
  return res?.ok ? note.url : undefined;
}

// Notes this process's server; the returned function removes the note again, unless another server wrote it since.
export async function noteServer(file: string, url: string): Promise<() => Promise<void>> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ url, pid: process.pid } satisfies Note)}\n`);
  return async () => {
    if ((await readNote(file))?.pid === process.pid) await rm(file, { force: true });
  };
}

// A command in a terminal that flashes (watch, or update while it runs) notes itself as well, so
// watch and update in two terminals never flash at the same time. It has no address to ask, so the
// process id alone tells whether it still runs.
interface FlasherNote {
  command: 'watch' | 'update';
  pid: number;
}

async function readFlasherNote(file: string): Promise<FlasherNote | undefined> {
  try {
    const note = JSON.parse(await readFile(file, 'utf8')) as Partial<FlasherNote>;
    return (note.command === 'watch' || note.command === 'update') && typeof note.pid === 'number' ? (note as FlasherNote) : undefined;
  } catch {
    return undefined;
  }
}

// The command of another process that still runs; a note left by one that was killed is ignored.
export async function runningFlasher(file: string): Promise<FlasherNote | undefined> {
  const note = await readFlasherNote(file);
  return note && note.pid !== process.pid && alive(note.pid) ? note : undefined;
}

// Notes this process; the returned function removes the note again, unless another one wrote it since.
export async function noteFlasher(file: string, command: FlasherNote['command']): Promise<() => Promise<void>> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ command, pid: process.pid } satisfies FlasherNote)}\n`);
  return async () => {
    if ((await readFlasherNote(file))?.pid === process.pid) await rm(file, { force: true });
  };
}
