import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildImage, firmwareEnd, hasTarget, uploadFile } from '../src/core/image.ts';
import { espImage } from './helpers.ts';

const TARGET = 'UNIFIED_ESP32_2400_RX';
const options = { uid: [1, 2, 3, 4, 5, 6], 'wifi-ssid': 'HomeNet', 'wifi-password': 'secret-wifi-password', 'flash-discriminator': 123456789 };

describe('firmwareEnd', () => {
  it('finds the end of the program in ESP32 and ESP8285 images like the ELRS tool', () => {
    for (const esp8285 of [false, true]) {
      const { image, end } = espImage(TARGET, esp8285);
      expect(firmwareEnd(image)).toBe(end);
      expect(image.length - end).toBe(2704);
    }
  });

  it('rejects files that are no ESP image or are cut short', () => {
    const { image } = espImage(TARGET);
    expect(() => firmwareEnd(Buffer.from('not firmware at all, really not'))).toThrow("isn't an ESP image");
    expect(() => firmwareEnd(image.subarray(0, 60))).toThrow('incomplete');
    const broken = Buffer.from(espImage(TARGET, true).image);
    broken[0x1000] = 0;
    expect(() => firmwareEnd(broken)).toThrow("isn't an ESP image");
  });
});

describe('hasTarget', () => {
  it('finds the whole target name behind the marker, in any case', () => {
    const { image } = espImage(TARGET);
    expect(hasTarget(image, TARGET)).toBe(true);
    expect(hasTarget(image, 'Unified_ESP32_2400_RX')).toBe(true);
    expect(hasTarget(image, 'UNIFIED_ESP32_2400')).toBe(false);
    expect(hasTarget(image, 'UNIFIED_ESP8285_2400_RX')).toBe(false);
  });
});

describe('buildImage', () => {
  it('replaces the default blocks with product, device name, options and layout', () => {
    const { image, end } = espImage(TARGET);
    const hardware = { serial_rx: 3, serial_tx: 1, led_rgb: 22 };
    const out = buildImage(image, { productName: 'RadioMaster RP4TD', luaName: 'RM RP4TD 2400', options, hardware });
    expect(out.subarray(0, end)).toEqual(image.subarray(0, end));
    expect(out.length).toBe(end + 2704);
    const text = (from: number, size: number) => out.subarray(from, from + size).toString('utf8').replace(/\0+$/, '');
    expect(text(end, 128)).toBe('RadioMaster RP4TD');
    expect(text(end + 128, 16)).toBe('RM RP4TD 2400');
    expect(JSON.parse(text(end + 144, 512))).toEqual(options);
    expect(JSON.parse(text(end + 656, 2048))).toEqual(hardware);
    expect(out[end + 144 + 511]).toBe(0);
  });

  it('leaves the layout empty without one and appends logo and earlier target name', () => {
    const { image, end } = espImage(TARGET);
    const logo = Buffer.from([1, 2, 3, 4]);
    const out = buildImage(image, { productName: 'P', luaName: 'L', options: {}, logo, priorTargetName: 'old_target' });
    expect(out.subarray(end + 656, end + 2704).every((b) => b === 0)).toBe(true);
    expect(out.subarray(end + 2704, end + 2708)).toEqual(logo);
    expect(out.subarray(end + 2708)).toEqual(Buffer.concat([Buffer.from([0xbe, 0xef, 0xca, 0xfe]), Buffer.from('OLD_TARGET'), Buffer.from([0])]));
    expect(hasTarget(out, 'old_target')).toBe(true);
  });

  it('stops instead of cutting blocks short, without showing the options', () => {
    const { image } = espImage(TARGET);
    const long = { ...options, filler: 'x'.repeat(500) };
    expect(() => buildImage(image, { productName: 'P', luaName: 'L', options: long })).toThrow(/Too long for the firmware: options/);
    try {
      buildImage(image, { productName: 'P', luaName: 'L', options: long });
    } catch (e) {
      expect(String(e)).not.toContain('secret-wifi-password');
    }
    expect(() => buildImage(image, { productName: 'P', luaName: 'a lua name longer than 16', options })).toThrow(/device name/);
  });
});

describe('uploadFile', () => {
  it('packs ESP8285 files with gzip and leaves ESP32 files as they are', () => {
    const { image } = espImage(TARGET, true);
    const gz = uploadFile(image, true);
    expect(gz.name).toBe('firmware.bin.gz');
    expect(gz.data[0]).toBe(0x1f);
    expect(gunzipSync(gz.data)).toEqual(image);
    expect(uploadFile(image, false)).toEqual({ name: 'firmware.bin', data: image });
  });
});
