import { readJson, writeJson, type Paths } from './paths.ts';

export interface Settings {
  targetMajor?: number; // major version all devices are kept on; unset: nothing is flashed
  autoUpdate: boolean; // terminal: what watch does; the interface has its own switch
  alwaysAutoUpdate?: boolean; // interface: auto update is on at every start, without its switch
  hideAutoUpdateWarning?: boolean; // interface: don't ask again before auto update goes on
  releaseCandidates: boolean;
  rememberWebFlasher?: boolean; // desktop app: keep what was typed into the Web Flasher after quitting
  ui?: { lang?: string; theme?: 'light' | 'dark' }; // kept for the interface, whose port changes with every start
}

export function defaultSettings(): Settings {
  return { autoUpdate: false, releaseCandidates: false };
}

export async function loadSettings(p: Paths): Promise<Settings> {
  const saved = (await readJson<Partial<Settings>>(p.settings)) ?? {};
  const s = { ...defaultSettings(), ...saved };
  if (!Number.isInteger(s.targetMajor)) delete s.targetMajor;
  return s;
}

export async function saveSettings(p: Paths, s: Settings): Promise<void> {
  await writeJson(p.settings, s);
}
