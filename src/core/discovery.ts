import makeMdns from 'multicast-dns';
import { readConfig, type DeviceInfo, type DeviceType } from './device.ts';
import { ipv4Networks, type Ipv4Network } from '../platform/network.ts';

export type Via = 'mdns' | 'scan';

export interface Device extends Partial<DeviceInfo> {
  ip: string;
  mac?: string; // from the mDNS instance name, upper case without colons
  via: Via[];
}

// The parts of a multicast-dns response that are read here.
export interface MdnsRecord {
  name: string;
  type: string;
  data?: unknown;
}
export interface MdnsPacket {
  answers?: MdnsRecord[];
  additionals?: MdnsRecord[];
}
export interface Mdns {
  on(event: 'response', listener: (packet: MdnsPacket, rinfo: { address: string }) => void): unknown;
  query(query: { questions: { name: string; type: string }[] }): unknown;
  destroy(): unknown;
}

const SERVICE = '_http._tcp.local';

function txtValues(data: unknown): Record<string, string> {
  const parts = Array.isArray(data) ? data : [data];
  const out: Record<string, string> = {};
  for (const p of parts) {
    const s = Buffer.isBuffer(p) ? p.toString('utf8') : typeof p === 'string' ? p : '';
    const eq = s.indexOf('=');
    if (eq > 0) out[s.slice(0, eq)] = s.slice(eq + 1);
  }
  return out;
}

// ELRS devices in one mDNS response: each announces _http._tcp as "<hostname>_<MAC>" with vendor=elrs.
// The address comes from the A record of the service's host, else from the sender.
export function parseMdnsResponse(packet: MdnsPacket, from: string): Device[] {
  const records = [...(packet.answers ?? []), ...(packet.additionals ?? [])];
  const devices: Device[] = [];
  for (const r of records) {
    if (r.type !== 'TXT' || !r.name.toLowerCase().endsWith(`.${SERVICE}`)) continue;
    const txt = txtValues(r.data);
    if (txt.vendor !== 'elrs') continue;
    const instance = r.name.slice(0, -SERVICE.length - 1);
    const srv = records.find((x) => x.type === 'SRV' && x.name === r.name)?.data as { target?: string } | undefined;
    const a = srv?.target ? records.find((x) => x.type === 'A' && x.name === srv.target) : undefined;
    const type: DeviceType | undefined = txt.type === 'rx' || txt.type === 'tx' ? txt.type : undefined;
    devices.push({
      ip: typeof a?.data === 'string' ? a.data : from,
      mac: /_([0-9a-f]{12})$/i.exec(instance)?.[1]?.toUpperCase(),
      via: ['mdns'],
      type,
      target: txt.target || undefined,
      product: txt.product || undefined,
      device: txt.device || undefined,
      version: txt.version || undefined,
    });
  }
  return devices;
}

// Listens for ELRS devices via mDNS and asks for them right away and then every queryEveryMs.
export function browseMdns(
  onDevice: (d: Device) => void,
  queryEveryMs = 5000,
  create: () => Mdns = () => makeMdns() as unknown as Mdns,
): { stop: () => void } {
  const mdns = create();
  mdns.on('response', (packet, rinfo) => parseMdnsResponse(packet, rinfo.address).forEach(onDevice));
  const ask = () => mdns.query({ questions: [{ name: SERVICE, type: 'PTR' }] });
  ask();
  const timer = setInterval(ask, queryEveryMs);
  return {
    stop: () => {
      clearInterval(timer);
      mdns.destroy();
    },
  };
}

const toInt = (ip: string) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const toIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');

// Addresses to ask in the computer's networks: all hosts except its own, networks larger
// than /24 only in the 254 addresses around its own address.
export function scanAddresses(networks: Ipv4Network[]): string[] {
  const own = new Set(networks.map((n) => n.address));
  const out = new Set<string>();
  for (const n of networks) {
    const mask = Math.max(toInt(n.netmask), toInt('255.255.255.0'));
    const size = 2 ** 32 - mask;
    if (size < 4) continue;
    const base = toInt(n.address) - (toInt(n.address) % size);
    for (let i = 1; i < size - 1; i++) {
      const ip = toIp(base + i);
      if (!own.has(ip)) out.add(ip);
    }
  }
  return [...out];
}

// Asks one address for /config and reports why it is no ELRS device (see readConfig).
export type Probe = (ip: string, onFail?: (reason: string) => void) => Promise<DeviceInfo | undefined>;

const readConfigProbe: Probe = (ip, onFail) => readConfig(ip, fetch, 1500, onFail);

// Asks every address with probe, at most `parallel` at a time.
export async function scanSubnet(
  addresses: string[],
  probe: Probe = readConfigProbe,
  parallel = 32,
  onFail?: (reason: string) => void,
): Promise<Device[]> {
  const found: Device[] = [];
  let next = 0;
  const worker = async () => {
    while (next < addresses.length) {
      const ip = addresses[next++]!;
      const info = await probe(ip, onFail);
      if (info) found.push({ ...info, ip, via: ['scan'] });
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, addresses.length) }, worker));
  return found;
}

// Adds what one way found to the list, keyed by IP address. Values read from /config (scan and
// the follow-up question) win over those from mDNS.
export function mergeDevice(list: Map<string, Device>, d: Device, fromConfig = d.via.includes('scan')): void {
  const old = list.get(d.ip);
  if (!old) {
    list.set(d.ip, { ...d, via: [...d.via] });
    return;
  }
  const defined = (o: Device) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const merged = fromConfig ? { ...old, ...defined(d) } : { ...defined(d), ...old };
  merged.mac = old.mac ?? d.mac;
  merged.via = [...new Set([...old.via, ...d.via])].sort() as Via[];
  list.set(d.ip, merged as Device);
}

export interface DiscoverOptions {
  seconds?: number; // how long to listen for mDNS at least
  networks?: Ipv4Network[];
  probe?: Probe;
  mdns?: () => Mdns;
}

export interface Discovery {
  devices: Device[];
  asked: number; // addresses of the scan
  unreachable: number; // of these, how many answered "no route to host" (EHOSTUNREACH)
}

// One look around: mDNS for `seconds` and one scan of the networks at the same time; devices only
// found via mDNS are then asked for /config, which adds the regulatory domain.
export async function discover(opts: DiscoverOptions = {}): Promise<Discovery> {
  const probe = opts.probe ?? readConfigProbe;
  const list = new Map<string, Device>();
  const browser = browseMdns((d) => mergeDevice(list, d), 3000, opts.mdns);
  let scan: Discovery;
  try {
    [scan] = await Promise.all([scanNetworks(opts.networks, probe), new Promise((r) => setTimeout(r, (opts.seconds ?? 10) * 1000))]);
    scan.devices.forEach((d) => mergeDevice(list, d));
  } finally {
    browser.stop();
  }
  await Promise.all(
    [...list.values()]
      .filter((d) => !d.via.includes('scan'))
      .map(async (d) => {
        const info = await probe(d.ip);
        if (info) mergeDevice(list, { ...info, ip: d.ip, via: [] }, true);
      }),
  );
  const devices = [...list.values()].sort((a, b) => (a.product ?? '').localeCompare(b.product ?? '') || a.ip.localeCompare(b.ip));
  return { devices, asked: scan.asked, unreachable: scan.unreachable };
}

// One scan of the computer's networks, counting the addresses that answered "no route to host".
export async function scanNetworks(networks = ipv4Networks(), probe: Probe = readConfigProbe): Promise<Discovery> {
  const addresses = scanAddresses(networks);
  let unreachable = 0;
  const devices = await scanSubnet(addresses, probe, 32, (reason) => reason === 'EHOSTUNREACH' && unreachable++);
  return { devices, asked: addresses.length, unreachable };
}

// Nearly every address of the network at once "no route to host": the system blocks this program
// from the local network (on macOS the Local Network permission of the app it runs in).
export function looksBlocked(d: Discovery): boolean {
  return d.devices.length === 0 && d.asked > 0 && d.unreachable >= d.asked * 0.9;
}
