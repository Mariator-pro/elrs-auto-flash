// What stopped a flash, so automatic updates can react: the device no longer answers ('gone'), this
// version cannot be flashed onto it ('unsupported'), the file lacks its target ('target'), or the
// firmware could not be fetched ('download').
export type ErrorKind = 'gone' | 'unsupported' | 'target' | 'download';

export type MsgParams = Record<string, string | number>;

// The program's own messages in English; the interface translates them by their code.
export const MESSAGES = {
  deviceGone: (p: MsgParams) => `The device at ${p.ip} no longer answers.`,
  deviceMissing: (p: MsgParams) => `The device at ${p.ip} did not send ${p.path}.`,
  notElrs: (p: MsgParams) => `The device at ${p.ip} answers, but not like an ELRS device (3.0 or newer).`,
  noDevice: (p: MsgParams) => `No ELRS device answers at ${p.ip}. Is its WiFi still on?`,
  notAVersion: (p: MsgParams) => `Not a version: ${p.tag}`,
  alreadyCurrent: (p: MsgParams) => `The device already has ${p.to}.`,
  newerThanTarget: (p: MsgParams) => `The device has ${p.version}, newer than ${p.to}; it is never downgraded.`,
  tooOld: () => 'The device is not supported (below ExpressLRS 3.0).',
  ownBuild: () => 'The device runs a custom build; it is only updated by hand.',
  targetMissing: (p: MsgParams) => `The firmware file does not match the device's target ${p.target}; nothing was sent.`,
  downloadOffline: () => 'No connection to the ExpressLRS download server. Check the internet connection.',
  downloadStatus: (p: MsgParams) => `Download failed (${p.status}): ${p.url}`,
  downloadNoFirmware: (p: MsgParams) => `The ExpressLRS download server has no firmware for ${p.tag}.`,
  downloadEmpty: (p: MsgParams) => `Download failed: ${p.tag} has no data`,
  downloadBroken: (p: MsgParams) => `The download of ${p.tag} is incomplete or damaged; it is loaded again next time.`,
  archiveNoTargets: () => 'The firmware archive has no list of targets.',
  noProduct: (p: MsgParams) => `This version has no firmware for "${p.product}" (${p.target}).`,
  noWifiUpload: (p: MsgParams) => `"${p.product}" cannot be updated over WiFi.`,
  notEsp: (p: MsgParams) => `"${p.product}" is no ESP device.`,
  archiveNoFirmware: (p: MsgParams) => `The firmware archive has no ${p.folder} firmware for ${p.firmware}.`,
  archiveNoLayout: (p: MsgParams) => `The firmware archive has no hardware layout ${p.file}.`,
  archiveNoLogo: (p: MsgParams) => `The firmware archive has no logo ${p.file}.`,
  notEspImage: () => 'The firmware file is not an ESP image.',
  imageShort: () => 'The firmware file is cut short.',
  tooLong: (p: MsgParams) => `Too long for the firmware: ${p.what} (${p.size} of ${p.max} bytes).`,
  githubOffline: () => 'No connection to GitHub. Check the internet connection.',
  githubLimit: () => 'GitHub rate limit reached, try again later',
  githubLimitAt: (p: MsgParams) => `GitHub rate limit reached, try again after ${p.time}`,
  githubStatus: (p: MsgParams) => `GitHub answered ${p.status}`,
  uploadTimeout: () => 'no answer from the device',
  uploadLost: (p: MsgParams) => `connection lost (${p.code})`,
  uploadStatus: (p: MsgParams) => `the device answered ${p.status}`,
  stillRuns: (p: MsgParams) => `Still runs ${p.version} after the update to ${p.to}.`,
} satisfies Record<string, (p: MsgParams) => string>;

export type MsgCode = keyof typeof MESSAGES;

// A message for the user: the English text, and its code where it is one of the program's own
// (messages of devices and download servers have none).
export interface Msg {
  message: string;
  code?: MsgCode;
  params?: MsgParams;
}

export function msg(code: MsgCode, params?: MsgParams): Msg {
  return { message: MESSAGES[code](params ?? {}), code, ...(params && { params }) };
}

// An error whose message is meant for the user as it is.
export class AppError extends Error {
  kind?: ErrorKind;
  code?: MsgCode;
  params?: MsgParams;
  constructor(message: string | Msg, kind?: ErrorKind) {
    const m = typeof message === 'string' ? { message } : message;
    super(m.message);
    this.kind = kind;
    this.code = m.code;
    this.params = m.params;
  }
}

// What an error says, with its code where it has one.
export function toMsg(e: unknown): Msg {
  if (e instanceof AppError) return { message: e.message, ...(e.code && { code: e.code }), ...(e.params && { params: e.params }) };
  return { message: e instanceof Error ? e.message : String(e) };
}
