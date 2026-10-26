import { AppError, msg, type MsgCode, type MsgParams } from './errors.ts';

export type FetchFn = typeof fetch;

export type DeviceType = 'rx' | 'tx';

// What a device reports about itself on /config. Its options (home WiFi password, UID) are
// deliberately not part of it, so they cannot end up in output, files or errors.
export interface DeviceInfo {
  type: DeviceType;
  target: string; // e.g. UNIFIED_ESP8285_2400_RX
  product: string; // e.g. RadioMaster RP1 2.4GHz RX
  device?: string; // short name shown in the Lua script
  version: string; // a release tag (4.1.0, 4.1.0-RC1, on 3.x with the commit: 3.5.4 (a6f9a2)) or, for own builds, a branch name
  domainLow?: string; // 900 MHz band, e.g. EU868
  domainHigh?: string; // 2.4 GHz band: CE_LBT or ISM2G4
  customHardware?: boolean; // hardware layout changed by hand in the web page (reported from 4.x on)
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

// Reads the answer of /config; undefined when it is not one of an ELRS device from 4.0 on.
export function parseConfig(json: unknown): DeviceInfo | undefined {
  const s = (json as { settings?: Record<string, unknown> } | null)?.settings;
  if (!s || typeof s !== 'object') return undefined;
  const info = parseIdentity(s);
  return info && { ...info, domainLow: str(s.reg_domain_low), domainHigh: str(s.reg_domain_high), customHardware: s.custom_hardware === true };
}

// 3.x answers /config without "settings" and tells who it is on /target, with one domain for its band.
export function parseTarget(json: unknown): DeviceInfo | undefined {
  const s = json as Record<string, unknown> | null;
  if (!s || typeof s !== 'object') return undefined;
  const info = parseIdentity(s);
  const domain = str(s.reg_domain);
  const high = domain === 'ISM2G4' || domain === 'CE_LBT';
  return info && { ...info, domainLow: high ? undefined : domain, domainHigh: high ? domain : undefined, customHardware: false };
}

function parseIdentity(s: Record<string, unknown>): Omit<DeviceInfo, 'domainLow' | 'domainHigh' | 'customHardware'> | undefined {
  const target = str(s.target);
  const version = str(s.version);
  const product = str(s.product_name);
  const moduleType = str(s['module-type'])?.toLowerCase();
  if (!target || !version || !product || (moduleType !== 'rx' && moduleType !== 'tx')) return undefined;
  return { type: moduleType, target, product, device: str(s.lua_name), version };
}

const getJson = async (ip: string, path: string, fetchFn: FetchFn, timeoutMs: number): Promise<unknown> => {
  const res = await fetchFn(`http://${ip}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  return res.ok ? await res.json().catch(() => undefined) : undefined;
};

// Asks one address for /config (on 3.x also /target); undefined when nothing answers in time or it is not an ELRS device.
// onFail gets the reason: a network error code such as EHOSTUNREACH, 'timeout' or 'not-elrs'.
export async function readConfig(
  ip: string,
  fetchFn: FetchFn = fetch,
  timeoutMs = 1500,
  onFail?: (reason: string) => void,
): Promise<DeviceInfo | undefined> {
  try {
    const json = (await getJson(ip, '/config', fetchFn, timeoutMs)) as { settings?: unknown; config?: unknown } | undefined;
    const old = !!json && typeof json === 'object' && !json.settings && !!json.config;
    const info = old ? parseTarget(await getJson(ip, '/target', fetchFn, timeoutMs)) : parseConfig(json);
    if (!info) onFail?.('not-elrs');
    return info;
  } catch (e) {
    const err = e as { name?: string; cause?: { code?: string } };
    onFail?.(err.name === 'TimeoutError' ? 'timeout' : (err.cause?.code ?? 'error'));
    return undefined;
  }
}

async function readObject(ip: string, path: string, fetchFn: FetchFn): Promise<Record<string, unknown>> {
  let json: unknown;
  try {
    const res = await fetchFn(`http://${ip}${path}`, { signal: AbortSignal.timeout(5000) });
    json = res.ok ? await res.json().catch(() => undefined) : undefined;
  } catch {
    throw new AppError(msg('deviceGone', { ip }), 'gone');
  }
  if (json && typeof json === 'object' && !Array.isArray(json)) return json as Record<string, unknown>;
  throw new AppError(msg('deviceMissing', { ip, path }), 'unsupported');
}

// The options built into the firmware (binding UID, home WiFi with password, ...). They only go into
// the new firmware, never into output, files or errors.
export function readOptions(ip: string, fetchFn: FetchFn = fetch): Promise<Record<string, unknown>> {
  return readObject(ip, '/options.json', fetchFn);
}

// The hardware layout the device runs with.
export function readHardware(ip: string, fetchFn: FetchFn = fetch): Promise<Record<string, unknown>> {
  return readObject(ip, '/hardware.json', fetchFn);
}

export interface UploadResult {
  status: 'ok' | 'error' | 'mismatch';
  message: string; // the device's own, or one of the program's with its code
  code?: MsgCode;
  params?: MsgParams;
}

const plain = (html: string) => html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// Uploads a firmware file as the device's web page does: POST /update with the file in the form
// field "data" and its size in X-FileSize. Never with a "force" field: that makes the device skip
// its target check.
export async function uploadFirmware(
  ip: string,
  file: { name: string; data: Buffer },
  fetchFn: FetchFn = fetch,
  timeoutMs = 120_000,
): Promise<UploadResult> {
  const form = new FormData();
  form.append('data', new Blob([new Uint8Array(file.data)]), file.name);
  let res: Response;
  try {
    res = await fetchFn(`http://${ip}/update`, {
      method: 'POST',
      body: form,
      headers: { 'X-FileSize': String(file.data.length) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as { name?: string; cause?: { code?: string } };
    return { status: 'error', ...(err.name === 'TimeoutError' ? msg('uploadTimeout') : msg('uploadLost', { code: err.cause?.code ?? 'error' })) };
  }
  const json = (await res.json().catch(() => undefined)) as { status?: string; msg?: string } | undefined;
  const status = json?.status === 'ok' || json?.status === 'mismatch' ? json.status : 'error';
  return { status, ...(json?.msg ? { message: plain(json.msg) } : msg('uploadStatus', { status: res.status })) };
}
