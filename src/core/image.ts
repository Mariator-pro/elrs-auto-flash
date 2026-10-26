import { gzipSync } from 'node:zlib';
import { AppError, msg } from './errors.ts';

// Marker the firmware puts in front of its target name; devices look for their own when a file is uploaded.
const TARGET_MARK = Buffer.from([0xbe, 0xef, 0xca, 0xfe]);

const PRODUCT_SIZE = 128;
const DEVICE_SIZE = 16;
const OPTIONS_SIZE = 512;
const HARDWARE_SIZE = 2048;

// Where the program of an ESP image ends and the appended blocks start, computed like the ELRS tool
// (src/python/UnifiedConfiguration.py, findFirmwareEnd): ESP8285 images have two segments of boot
// code and the program's header at 0x1000, ESP32 images a 24 byte header and 32 bytes of hash at the end.
export function firmwareEnd(image: Buffer): number {
  if (image.length < 24 || image[0] !== 0xe9) throw new AppError(msg('notEspImage'), 'unsupported');
  let pos = 24;
  let esp8285 = false;
  if (image[1] === 2) {
    if (image[0x1000] !== 0xe9) throw new AppError(msg('notEspImage'), 'unsupported');
    pos = 0x1008;
    esp8285 = true;
  }
  const segments = image[esp8285 ? 0x1001 : 1]!;
  for (let i = 0; i < segments; i++) {
    if (pos + 8 > image.length) throw new AppError(msg('imageShort'), 'unsupported');
    pos += 8 + image.readUInt32LE(pos + 4);
  }
  pos = (pos + 16) & ~15;
  if (!esp8285) pos += 32;
  if (pos > image.length) throw new AppError(msg('imageShort'), 'unsupported');
  return pos;
}

// Whether the file carries this target name (e.g. UNIFIED_ESP32_2400_RX) behind the marker, ending with 0.
export function hasTarget(image: Buffer, target: string): boolean {
  const needle = Buffer.concat([TARGET_MARK, Buffer.from(target.toUpperCase()), Buffer.from([0])]);
  return image.includes(needle);
}

function block(text: string, size: number, what: string): Buffer {
  const data = Buffer.from(text, 'utf8');
  // the firmware reads these as text ending with 0, so one byte stays free; the ELRS tool would cut
  // longer text short, which breaks the JSON
  if (data.length >= size) throw new AppError(msg('tooLong', { what, size: data.length, max: size - 1 }), 'unsupported');
  return Buffer.concat([data, Buffer.alloc(size - data.length)]);
}

export interface ImageParts {
  productName: string;
  luaName: string;
  options: Record<string, unknown>; // the device's options, unchanged
  hardware?: Record<string, unknown>; // hardware layout; without, the device keeps asking for one
  logo?: Buffer;
  priorTargetName?: string; // an earlier name of the target, so devices still on it accept the file
}

// The firmware with the blocks behind the program replaced, as the ELRS tool's appendToFirmware does.
export function buildImage(firmware: Buffer, parts: ImageParts): Buffer {
  const pieces = [
    firmware.subarray(0, firmwareEnd(firmware)),
    block(parts.productName, PRODUCT_SIZE, 'product name'),
    block(parts.luaName, DEVICE_SIZE, 'device name'),
    block(JSON.stringify(parts.options), OPTIONS_SIZE, 'options'),
    parts.hardware ? block(JSON.stringify(parts.hardware), HARDWARE_SIZE, 'hardware layout') : Buffer.alloc(HARDWARE_SIZE),
  ];
  if (parts.logo) pieces.push(parts.logo);
  if (parts.priorTargetName) pieces.push(TARGET_MARK, Buffer.from(parts.priorTargetName.toUpperCase()), Buffer.from([0]));
  return Buffer.concat(pieces);
}

// ESP8285 devices take the file gzip-packed, ESP32 devices as it is.
export function uploadFile(image: Buffer, esp8285: boolean): { name: string; data: Buffer } {
  return esp8285 ? { name: 'firmware.bin.gz', data: gzipSync(image) } : { name: 'firmware.bin', data: image };
}
