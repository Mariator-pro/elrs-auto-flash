// What the server sends the interface, shared by both. Imports nothing, so the interface stays free of
// server code; the server's assignments check that these types match its own.

// A device's state: against the target version, after its last flash, or in the queue.
export type WatchState =
  | 'current'
  | 'update'
  | 'newer'
  | 'custom-build'
  | 'no-target-version'
  | 'unsupported'
  | 'unconfirmed'
  | 'mismatch'
  | 'failed'
  | 'queued'
  | 'flashing';

// The program's own messages, translated in the interface by their code.
export type MessageCode =
  | 'deviceGone'
  | 'deviceMissing'
  | 'notElrs'
  | 'noDevice'
  | 'notAVersion'
  | 'alreadyCurrent'
  | 'newerThanTarget'
  | 'tooOld'
  | 'ownBuild'
  | 'targetMissing'
  | 'downloadOffline'
  | 'downloadStatus'
  | 'downloadNoFirmware'
  | 'downloadEmpty'
  | 'downloadBroken'
  | 'archiveNoTargets'
  | 'noProduct'
  | 'noWifiUpload'
  | 'notEsp'
  | 'archiveNoFirmware'
  | 'archiveNoLayout'
  | 'archiveNoLogo'
  | 'notEspImage'
  | 'imageShort'
  | 'tooLong'
  | 'githubOffline'
  | 'githubLimit'
  | 'githubLimitAt'
  | 'githubStatus'
  | 'uploadTimeout'
  | 'uploadLost'
  | 'uploadStatus'
  | 'stillRuns';
export type MessageParams = Record<string, string | number>;

// A message in English; with a code when it is one of the program's own (those of devices and
// download servers have none and are shown as they come).
export interface Message {
  message: string;
  code?: MessageCode;
  params?: MessageParams;
}

// How a flash ended ('stopped': before the upload).
export type FlashOutcome =
  | { result: 'done'; version: string }
  | { result: 'wrong-version'; version: string }
  | { result: 'unconfirmed'; check?: 'wifi-off' | 'later' } // not waited for: a transmitter module (its WiFi is off), or confirmed when seen again
  | { result: 'mismatch'; message: string }
  | (Message & { result: 'failed' })
  | (Message & { result: 'stopped'; kind?: 'gone' | 'unsupported' | 'target' | 'download' });

export type FlashStep = 'prepare' | 'download' | 'upload' | 'reboot';

export const MAX_NAME = 40;

// How a device is named everywhere: its own name with the Lua name, else the Lua name (or product)
// with the end of its MAC, so two devices of the same kind can be told apart.
export function deviceLabel(d: { name?: string; device?: string; product?: string; mac?: string; ip: string }): string {
  const kind = d.device ?? d.product;
  if (d.name) return kind ? `${d.name} (${kind})` : d.name;
  if (!kind) return d.ip;
  return d.mac ? `${kind} · ${d.mac.slice(-4)}` : kind;
}

// A device as the interface shows it. Never holds the device's options.
export interface DeviceView {
  key: string;
  ip: string;
  mac?: string;
  name?: string; // given by the user
  label: string; // see deviceLabel
  type?: 'rx' | 'tx';
  target?: string;
  product?: string;
  device?: string; // Lua name
  version?: string;
  domain?: string;
  lastSeen: string;
  online: boolean;
  state: WatchState;
  notice?: Message & { kind: 'mismatch' | 'failed' };
  unconfirmedTo?: string; // flashed to this version, not seen since
  unsupportedReason?: Message; // why the target version cannot be flashed onto it
  step?: { step: FlashStep; percent?: number }; // while it is being flashed
  lastAttempt?: { to: string; outcome: FlashOutcome }; // the last flash stopped or failed; until the next one, or the device is up to date
}

// A newer release of the desktop app.
export interface AppUpdateView {
  version: string; // without "v"
  url: string; // its release page
  installable: boolean; // the app installs it itself (Windows, Linux); macOS only links to the download
  percent?: number; // while it is downloaded
  restarting?: boolean; // downloaded, the app is about to restart into it
}

export interface StateView {
  settings: { targetMajor?: number; autoUpdate: boolean; releaseCandidates: boolean; rememberWebFlasher: boolean };
  desktop: boolean; // runs in the desktop app's window
  appUpdate?: AppUpdateView;
  target?: string; // the version devices are brought to
  majors: { major: number; tag: string }[]; // major versions to choose from, with the version each means
  newerMajor?: number; // a major version above the chosen one is out
  releasesChecked?: string;
  checking: boolean;
  lastScan?: string;
  problems: { releases?: Message; blocked?: boolean; error?: Message; download?: Message };
  devices: DeviceView[];
}

// One line of the "Activity" page; translated in the interface. `to` is the target version then.
// A flash takes two lines, its start (with the version before) and its result; its steps only show
// on the device's card. 'target': the target version changed (not at the start), then the devices'
// new states follow.
export type ActivityEntry = { id: number; at: string; key?: string; name?: string } & (
  | { type: 'found' | 'back'; version?: string; state: WatchState; to?: string }
  | { type: 'left' }
  | { type: 'state'; state: WatchState; to?: string }
  | { type: 'start'; to: string; from?: string }
  | { type: 'target'; to?: string }
  | { type: 'result'; to: string; outcome: FlashOutcome; later?: boolean }
  | (Message & { type: 'problem'; problem: 'releases' | 'blocked' | 'download' | 'error' })
);

// Errors of the API the interface translates; other errors come with their message only.
export type ErrorCode =
  | 'noTarget'
  | 'notFlashable'
  | 'unknownDevice'
  | 'busyDevice'
  | 'invalidMajor'
  | 'invalidRequest'
  | 'flashRunning'
  | 'appUpdateFailed';

// A key made for each start of the server: the page gets it, other web pages in the browser don't,
// so they can't use the API. Sent as a header, by the live connection (no headers there) in the address.
export const TOKEN_HEADER = 'x-elrs-auto-flash-token';
export const TOKEN_META = 'elrs-auto-flash-token';

// Language and theme, kept by the server: the port changes with every start, and the browser keeps
// what a page stores per port, so it would forget them.
export interface PrefsView {
  lang?: string;
  theme?: 'light' | 'dark';
}
export const PREFS_META = 'elrs-auto-flash-prefs';

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// The page gets the key and the stored choices, so it starts with them.
export const withPageData = (html: string, token: string, prefs: PrefsView) =>
  html.replace(
    '</head>',
    `<meta name="${TOKEN_META}" content="${token}" />\n<meta name="${PREFS_META}" content="${attr(JSON.stringify(prefs))}" />\n</head>`,
  );
