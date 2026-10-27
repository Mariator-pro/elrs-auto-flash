import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { DeviceInfo } from '../src/core/device.ts';
import {
  discover,
  looksBlocked,
  mergeDevice,
  parseMdnsResponse,
  scanAddresses,
  scanSubnet,
  type Device,
  type Mdns,
  type MdnsPacket,
  type Probe,
} from '../src/core/discovery.ts';

const txt = (pairs: Record<string, string>) => Object.entries(pairs).map(([k, v]) => Buffer.from(`${k}=${v}`));

// A response as an ESP32 receiver sends it: PTR to its instance, SRV, TXT and A of its host.
function elrsResponse(mac: string, ip: string, extra: Record<string, string> = {}): MdnsPacket {
  const instance = `elrs_rx_${mac}._http._tcp.local`;
  return {
    answers: [{ name: '_http._tcp.local', type: 'PTR', data: instance }],
    additionals: [
      { name: instance, type: 'SRV', data: { port: 80, target: 'elrs_rx.local' } },
      {
        name: instance,
        type: 'TXT',
        data: txt({
          vendor: 'elrs',
          target: 'UNIFIED_ESP32_2400_RX',
          device: 'RM RP4TD',
          product: 'RadioMaster RP4TD 2.4GHz RX',
          version: '3.6.4',
          options: '-DAUTO_WIFI_ON_INTERVAL=60',
          type: 'rx',
          ...extra,
        }),
      },
      { name: 'elrs_rx.local', type: 'A', data: ip },
    ],
  };
}

const info = (over: Partial<DeviceInfo> = {}): DeviceInfo => ({
  type: 'rx',
  target: 'UNIFIED_ESP8285_2400_RX',
  product: 'RadioMaster RP1 2.4GHz RX',
  version: '4.1.0',
  domainHigh: 'CE_LBT',
  ...over,
});

describe('parseMdnsResponse', () => {
  it('reads an ELRS device with its MAC from the instance name', () => {
    expect(parseMdnsResponse(elrsResponse('a1b2c3d4e5f6', '192.168.1.37'), '192.168.1.37')).toEqual([
      {
        ip: '192.168.1.37',
        mac: 'A1B2C3D4E5F6',
        via: ['mdns'],
        type: 'rx',
        target: 'UNIFIED_ESP32_2400_RX',
        product: 'RadioMaster RP4TD 2.4GHz RX',
        device: 'RM RP4TD',
        version: '3.6.4',
      },
    ]);
  });

  it('takes the sender as address without an A record, and a transmitter module', () => {
    const p = elrsResponse('A1B2C3D4E5F6', '10.0.0.5', { type: 'tx' });
    p.additionals = p.additionals!.filter((r) => r.type !== 'A');
    expect(parseMdnsResponse(p, '10.0.0.9')[0]).toMatchObject({ ip: '10.0.0.9', type: 'tx' });
  });

  it('ignores other devices that offer _http._tcp, and other records', () => {
    expect(parseMdnsResponse(elrsResponse('A1B2C3D4E5F6', '10.0.0.5', { vendor: 'shelly' }), '10.0.0.5')).toEqual([]);
    expect(parseMdnsResponse({ answers: [{ name: 'printer._ipp._tcp.local', type: 'TXT', data: txt({ vendor: 'elrs' }) }] }, '10.0.0.5')).toEqual([]);
    expect(parseMdnsResponse({}, '10.0.0.5')).toEqual([]);
  });

  it('asks only addresses in private or own networks, not this computer or the internet', () => {
    const own = [{ address: '100.70.1.2', netmask: '255.255.255.0' }];
    const ip = (a: string, from: string) => parseMdnsResponse(elrsResponse('A1B2C3D4E5F6', a), from, own)[0]?.ip;
    expect(ip('172.20.0.8', '172.20.0.8')).toBe('172.20.0.8');
    expect(ip('100.70.1.9', '100.70.1.9')).toBe('100.70.1.9');
    // an A record elsewhere: the sender's address
    expect(ip('127.0.0.1', '192.168.1.37')).toBe('192.168.1.37');
    expect(ip('8.8.8.8', '192.168.1.37')).toBe('192.168.1.37');
    expect(ip('100.70.1.2', '10.0.0.5')).toBe('10.0.0.5');
    // nothing that may be asked: no device
    expect(ip('127.0.0.1', '127.0.0.1')).toBeUndefined();
    expect(ip('8.8.8.8', '1.1.1.1')).toBeUndefined();
    expect(ip('224.0.0.251', '100.70.1.2')).toBeUndefined();
    expect(ip('not-an-ip', 'fe80::1')).toBeUndefined();
  });

  it('drops control characters from what a device announces', () => {
    const p = elrsResponse('A1B2C3D4E5F6', '10.0.0.5', { product: 'RP1\u001b]0;owned\u0007 RX\u202e', device: '\u001b[2J' });
    expect(parseMdnsResponse(p, '10.0.0.5')[0]).toMatchObject({ product: 'RP1]0;owned RX', device: '[2J' });
  });

  it('has no MAC when the instance name carries none', () => {
    const p: MdnsPacket = { answers: [{ name: 'elrs_rx._http._tcp.local', type: 'TXT', data: txt({ vendor: 'elrs', type: 'rx' }) }] };
    expect(parseMdnsResponse(p, '10.0.0.5')[0]?.mac).toBeUndefined();
  });
});

describe('scanAddresses', () => {
  it('lists the hosts of a /24 without the own address', () => {
    const list = scanAddresses([{ address: '192.168.1.20', netmask: '255.255.255.0' }]);
    expect(list).toHaveLength(253);
    expect(list[0]).toBe('192.168.1.1');
    expect(list.at(-1)).toBe('192.168.1.254');
    expect(list).not.toContain('192.168.1.20');
  });

  it('limits larger networks to the /24 around the own address', () => {
    const list = scanAddresses([{ address: '10.1.2.3', netmask: '255.255.0.0' }]);
    expect(list).toHaveLength(253);
    expect(list.every((ip) => ip.startsWith('10.1.2.'))).toBe(true);
  });

  it('handles small networks and several interfaces in the same network', () => {
    expect(scanAddresses([{ address: '10.0.0.1', netmask: '255.255.255.252' }])).toEqual(['10.0.0.2']);
    expect(scanAddresses([{ address: '10.0.0.1', netmask: '255.255.255.255' }])).toEqual([]);
    const two = scanAddresses([
      { address: '192.168.1.20', netmask: '255.255.255.0' },
      { address: '192.168.1.21', netmask: '255.255.255.0' },
    ]);
    expect(two).toHaveLength(252);
  });
});

describe('scanSubnet', () => {
  it('asks every address, at most so many at a time, and keeps the ELRS devices', async () => {
    let running = 0;
    let most = 0;
    const probe = async (ip: string) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return ip.endsWith('7') ? info() : undefined;
    };
    const addresses = Array.from({ length: 40 }, (_, i) => `10.0.0.${i + 1}`);
    const found = await scanSubnet(addresses, probe, 8);
    expect(most).toBe(8);
    expect(found.map((d) => d.ip).sort()).toEqual(['10.0.0.17', '10.0.0.27', '10.0.0.37', '10.0.0.7']);
    expect(found[0]).toMatchObject({ via: ['scan'], domainHigh: 'CE_LBT' });
  });
});

describe('mergeDevice', () => {
  it('joins both ways under one address, /config values win, the MAC stays', () => {
    const list = new Map<string, Device>();
    mergeDevice(list, { ip: '10.0.0.5', mac: 'A1B2C3D4E5F6', via: ['mdns'], version: '4.1.0', product: 'From mDNS' });
    mergeDevice(list, { ...info({ product: 'From config' }), ip: '10.0.0.5', via: ['scan'] });
    mergeDevice(list, { ip: '10.0.0.5', via: ['mdns'], product: 'mDNS again' });
    expect(list.size).toBe(1);
    expect(list.get('10.0.0.5')).toMatchObject({ mac: 'A1B2C3D4E5F6', via: ['mdns', 'scan'], product: 'From config', domainHigh: 'CE_LBT' });
  });
});

class FakeMdns extends EventEmitter implements Mdns {
  queries = 0;
  destroyed = false;
  answer: (n: number) => [MdnsPacket, string][];
  constructor(answer: (n: number) => [MdnsPacket, string][]) {
    super();
    this.answer = answer;
  }
  query() {
    for (const [packet, from] of this.answer(++this.queries)) setTimeout(() => this.emit('response', packet, { address: from }), 1);
  }
  destroy() {
    this.destroyed = true;
  }
}

describe('discover', () => {
  it('finds devices via mDNS and the scan, asks mDNS-only ones for /config, and stops mDNS', async () => {
    const mdns = new FakeMdns(() => [[elrsResponse('A1B2C3D4E5F6', '10.0.0.30'), '10.0.0.30']]);
    const asked: string[] = [];
    const probe = async (ip: string) => {
      asked.push(ip);
      if (ip === '10.0.0.7') return info();
      if (ip === '10.0.0.30') return info({ target: 'UNIFIED_ESP32_2400_RX', product: 'RadioMaster RP4TD 2.4GHz RX', version: '3.6.4' });
      return undefined;
    };
    const { devices } = await discover({
      seconds: 0.05,
      networks: [{ address: '10.0.0.1', netmask: '255.255.255.240' }],
      probe,
      mdns: () => mdns,
    });
    expect(mdns.destroyed).toBe(true);
    expect(devices.map((d) => [d.ip, d.via, d.mac, d.domainHigh])).toEqual([
      ['10.0.0.7', ['scan'], undefined, 'CE_LBT'],
      ['10.0.0.30', ['mdns'], 'A1B2C3D4E5F6', 'CE_LBT'],
    ]);
    expect(asked.filter((ip) => ip === '10.0.0.30')).toHaveLength(1);
  });

  it('counts addresses that answer "no route to host" and tells a blocked network from an empty one', async () => {
    const networks = [{ address: '10.0.0.1', netmask: '255.255.255.240' }];
    const quiet = () => new FakeMdns(() => []);
    const blocked: Probe = async (ip, onFail) => {
      onFail?.(ip === '10.0.0.14' ? 'not-elrs' : 'EHOSTUNREACH');
      return undefined;
    };
    const result = await discover({ seconds: 0.01, networks, probe: blocked, mdns: quiet });
    expect(result).toEqual({ devices: [], asked: 13, unreachable: 12 });
    expect(looksBlocked(result)).toBe(true);

    const empty: Probe = async (_ip, onFail) => {
      onFail?.('timeout');
      return undefined;
    };
    expect(looksBlocked(await discover({ seconds: 0.01, networks, probe: empty, mdns: quiet }))).toBe(false);
    expect(looksBlocked({ devices: [{ ip: '10.0.0.2', via: ['mdns'] }], asked: 13, unreachable: 13 })).toBe(false);
    expect(looksBlocked({ devices: [], asked: 0, unreachable: 0 })).toBe(false);
  });
});
