import { describe, expect, it } from 'vitest';
import { parseConfig, parseTarget, readConfig } from '../src/core/device.ts';
import { fakeDevice, fixture } from './helpers.ts';

describe('parseConfig', () => {
  it('reads type, target, product, version and domain of a receiver', async () => {
    expect(parseConfig(await fixture('config-rx-4.1.0.json'))).toEqual({
      type: 'rx',
      target: 'UNIFIED_ESP8285_2400_RX',
      product: 'RadioMaster RP1 2.4GHz RX',
      device: 'RM RP1',
      version: '4.1.0',
      domainLow: undefined,
      domainHigh: 'CE_LBT',
      customHardware: false,
    });
  });

  it('keeps no options: neither the WiFi password nor the UID', async () => {
    const json = JSON.stringify(parseConfig(await fixture('config-rx-4.1.0.json')));
    expect(json).not.toContain('secret-wifi-password');
    expect(json).not.toContain('HomeNet');
    expect(json).not.toContain('uid');
  });

  it('reads a transmitter module and both bands of a dual band device', () => {
    const info = parseConfig({
      settings: {
        target: 'UNIFIED_ESP32_LR1121_TX',
        version: '4.1.0-RC1',
        product_name: 'RadioMaster Nomad',
        'module-type': 'TX',
        reg_domain_low: 'EU868',
        reg_domain_high: 'ISM2G4',
      },
    });
    expect(info).toMatchObject({ type: 'tx', version: '4.1.0-RC1', domainLow: 'EU868', domainHigh: 'ISM2G4' });
  });

  it('drops control characters from what the device reports', () => {
    const info = parseConfig({
      settings: { target: 'UNIFIED_ESP32_2400_RX', version: '4.1.0', product_name: '\u001b]0;owned\u0007RP4TD\u202e', lua_name: '\u001b[2J', 'module-type': 'rx' },
    });
    expect(info).toMatchObject({ product: ']0;ownedRP4TD', device: '[2J' });
    expect(parseConfig({ settings: { target: 'X', version: '4.1.0', product_name: '\u001b\u0007', 'module-type': 'rx' } })).toBeUndefined();
  });

  it('rejects answers that are not those of an ELRS device', () => {
    expect(parseConfig(null)).toBeUndefined();
    expect(parseConfig({})).toBeUndefined();
    expect(parseConfig({ settings: { target: 'X', version: '4.1.0', product_name: 'P' } })).toBeUndefined();
    expect(parseConfig({ settings: { target: 'X', version: '4.1.0', product_name: 'P', 'module-type': 'backpack' } })).toBeUndefined();
    expect(parseConfig({ settings: { target: '', version: '4.1.0', product_name: 'P', 'module-type': 'RX' } })).toBeUndefined();
  });
});

describe('parseTarget', () => {
  it('reads a 3.x device from /target, its one domain by band', async () => {
    expect(parseTarget(await fixture('target-tx-3.5.4.json'))).toEqual({
      type: 'tx',
      target: 'UNIFIED_ESP32_2400_TX',
      product: 'RadioMaster Pocket Internal 2.4GHz TX',
      device: 'RM Pocket',
      version: '3.5.4 (a6f9a2)',
      domainLow: undefined,
      domainHigh: 'ISM2G4',
      customHardware: false,
    });
    expect(parseTarget({ target: 'X', version: '3.5.4', product_name: 'P', 'module-type': 'RX', reg_domain: 'EU868' })).toMatchObject({
      domainLow: 'EU868',
      domainHigh: undefined,
    });
    expect(parseTarget({ target: 'X', version: '3.5.4', product_name: 'P' })).toBeUndefined();
  });
});

describe('readConfig', () => {
  it('asks /config of the device', async () => {
    const body = JSON.stringify(await fixture('config-rx-4.1.0.json'));
    const paths: string[] = [];
    const dev = await fakeDevice((req, res) => {
      paths.push(req.url ?? '');
      res.setHeader('Content-Type', 'application/json');
      res.end(body);
    });
    try {
      expect((await readConfig(dev.host))?.target).toBe('UNIFIED_ESP8285_2400_RX');
      expect(paths).toEqual(['/config']);
    } finally {
      await dev.close();
    }
  });

  it('asks /target as well when /config has the form of 3.x', async () => {
    const config = JSON.stringify(await fixture('config-tx-3.5.4.json'));
    const target = JSON.stringify(await fixture('target-tx-3.5.4.json'));
    const paths: string[] = [];
    const dev = await fakeDevice((req, res) => {
      paths.push(req.url ?? '');
      res.setHeader('Content-Type', 'application/json');
      res.end(req.url === '/target' ? target : config);
    });
    try {
      const info = await readConfig(dev.host);
      expect(info).toMatchObject({ type: 'tx', target: 'UNIFIED_ESP32_2400_TX', version: '3.5.4 (a6f9a2)', domainHigh: 'ISM2G4' });
      expect(JSON.stringify(info)).not.toContain('secret-wifi-password');
      expect(paths).toEqual(['/config', '/target']);
    } finally {
      await dev.close();
    }
  });

  it('gives undefined for other web servers, non-JSON answers and nothing in time', async () => {
    const dev = await fakeDevice((req, res) => {
      if (req.url === '/config') {
        res.statusCode = 404;
        res.end();
      }
    });
    const html = await fakeDevice((_req, res) => res.end('<html></html>'));
    const slow = await fakeDevice(() => {});
    const reasons: string[] = [];
    const note = (r: string) => reasons.push(r);
    try {
      expect(await readConfig(dev.host, fetch, 1500, note)).toBeUndefined();
      expect(await readConfig(html.host, fetch, 1500, note)).toBeUndefined();
      expect(await readConfig(slow.host, fetch, 100, note)).toBeUndefined();
      expect(reasons).toEqual(['not-elrs', 'not-elrs', 'timeout']);
    } finally {
      await Promise.all([dev.close(), html.close(), slow.close()]);
    }
  });

  it('reports the network error code when nothing listens', async () => {
    const gone = await fakeDevice(() => {});
    await gone.close();
    const reasons: string[] = [];
    expect(await readConfig(gone.host, fetch, 1500, (r) => reasons.push(r))).toBeUndefined();
    expect(reasons).toEqual(['ECONNREFUSED']);
  });
});
