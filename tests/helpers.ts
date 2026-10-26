import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

// Minimal zip writer (stored, no compression) for test archives.
export function makeZip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// A small ESP image laid out like real firmware: header, segments (the first carrying the target
// marker), padding to 16 bytes, on ESP32 a 32 byte hash, then the 2704 bytes of default blocks.
export function espImage(target: string, esp8285 = false): { image: Buffer; end: number } {
  const marker = Buffer.concat([Buffer.from([0xbe, 0xef, 0xca, 0xfe]), Buffer.from(target), Buffer.from([0])]);
  const segment = (data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(0x40080000, 0);
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data]);
  };
  // ESP32 images have more than two segments; exactly two is how the ELRS tool tells an ESP8285 image
  const segs = [segment(Buffer.concat([Buffer.alloc(40, 0x11), marker, Buffer.alloc(23, 0x22)])), segment(Buffer.alloc(57, 0x33))];
  if (!esp8285) segs.push(segment(Buffer.alloc(19, 0x44)));
  let parts: Buffer[];
  if (esp8285) {
    const boot = Buffer.alloc(0x1000, 0xff);
    boot[0] = 0xe9;
    boot[1] = 2;
    const head = Buffer.alloc(8);
    head[0] = 0xe9;
    head[1] = segs.length;
    parts = [boot, head, ...segs];
  } else {
    const head = Buffer.alloc(24);
    head[0] = 0xe9;
    head[1] = segs.length;
    parts = [head, ...segs];
  }
  const body = Buffer.concat(parts);
  let end = (body.length + 16) & ~15;
  if (!esp8285) end += 32;
  const image = Buffer.concat([body, Buffer.alloc(end - body.length, 0xee), Buffer.from('Unified'), Buffer.alloc(2704 - 7)]);
  return { image, end };
}

export function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'elrs-auto-flash-'));
}

export async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
}

// A local HTTP server standing in for a device; returns its host:port and a function to close it.
export async function fakeDevice(handler: RequestListener): Promise<{ host: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    host: `127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

export const TARGETS = {
  radiomaster: {
    name: 'RadioMaster',
    rx_2400: {
      rp4td: {
        product_name: 'RadioMaster RP4TD True Diversity 2.4GHz RX',
        lua_name: 'RM RP4TD 2400',
        layout_file: 'Generic 2400 TD.json',
        overlay: { led_rgb: 22, power_max: 3 },
        upload_methods: ['uart', 'wifi'],
        platform: 'esp32',
        firmware: 'Unified_ESP32_2400_RX',
      },
      rp1: {
        product_name: 'RadioMaster RP1 2.4GHz RX',
        lua_name: 'RM RP1',
        layout_file: 'Generic 2400.json',
        upload_methods: ['uart', 'wifi'],
        platform: 'esp8285',
        firmware: 'Unified_ESP8285_2400_RX',
        logo_file: 'rm.bin',
        prior_target_name: 'RM_RP1_2400_RX',
      },
      mislabeled: {
        product_name: 'Mislabeled 900 RX',
        upload_methods: ['wifi'],
        platform: 'esp32',
        firmware: 'Unified_ESP32_900_RX',
      },
      uartonly: {
        product_name: 'Some UART RX',
        layout_file: 'Generic 2400.json',
        upload_methods: ['uart'],
        platform: 'esp8285',
        firmware: 'Unified_ESP8285_2400_RX',
      },
    },
  },
};

// A firmware archive like the real one, with two targets in both FCC and LBT.
export function testArchive(): Buffer {
  const esp32 = espImage('UNIFIED_ESP32_2400_RX').image;
  const esp8285 = espImage('UNIFIED_ESP8285_2400_RX', true).image;
  return makeZip({
    'firmware/hardware/targets.json': JSON.stringify(TARGETS),
    'firmware/hardware/RX/Generic 2400 TD.json': JSON.stringify({ serial_rx: 3, led_rgb: 2 }),
    'firmware/hardware/RX/Generic 2400.json': JSON.stringify({ serial_rx: 1 }),
    'firmware/hardware/logo/rm.bin': Buffer.from([9, 8, 7]),
    'firmware/FCC/Unified_ESP32_2400_RX/firmware.bin': esp32,
    'firmware/LBT/Unified_ESP32_2400_RX/firmware.bin': Buffer.concat([esp32.subarray(0, 36), Buffer.from('LBT'), esp32.subarray(39)]),
    'firmware/FCC/Unified_ESP8285_2400_RX/firmware.bin': esp8285,
    'firmware/LBT/Unified_ESP8285_2400_RX/firmware.bin': esp8285,
    // carries the wrong target, to see the own check refuse it
    'firmware/FCC/Unified_ESP32_900_RX/firmware.bin': esp32,
  });
}
