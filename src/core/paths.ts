import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Everything the tool stores on the computer lives under one fixed folder.
export interface Paths {
  root: string;
  settings: string;
  releases: string; // the last list of releases from GitHub
  devices: string; // every device ever found
  server: string; // address of the running server of the browser interface
  firmware: string; // one folder per version with its firmware archive
}

// Where apps keep their data on each system: macOS Application Support (the same folder Electron uses for
// the app), Windows LocalAppData, elsewhere XDG data.
function dataRoot(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'ELRS Auto Flash');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ELRS Auto Flash');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'elrs-auto-flash');
}

export function paths(root = dataRoot()): Paths {
  return {
    root,
    settings: join(root, 'settings.json'),
    releases: join(root, 'releases.json'),
    devices: join(root, 'devices.json'),
    server: join(root, 'server.json'),
    firmware: join(root, 'Firmware'),
  };
}

// undefined when the file is missing or not valid JSON.
export async function readJson<T>(path: string): Promise<T | undefined> {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

let tmpCount = 0;

// Writes via a temporary file, so a crash never leaves half a file behind. Each write has a file of
// its own, so two writes at once (e.g. the interface and a command in a terminal) cannot mix theirs.
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}-${++tmpCount}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}
