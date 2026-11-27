import type { DeviceView } from '../server/api.ts';

// The product without "2.4GHz RX/TX": the kind of device says that already. 900 MHz and dual band keep theirs.
export const shortProduct = (product?: string) => product?.replace(/\s+2\.4\s?GHz\s+(RX|TX)$/i, '');

// The title of a device on its card: its own name, else its product.
export const title = (d: Pick<DeviceView, 'name' | 'product' | 'ip'>) => d.name ?? shortProduct(d.product) ?? d.ip;

// A MAC with colons, as it is usually written; anything else as it came.
export const macText = (mac: string) => (/^[0-9a-f]{12}$/i.test(mac) ? mac.toUpperCase().match(/../g)!.join(':') : mac);

// How the interface names each device outside its card (activity, notices), by key: the title of its card,
// with the end of its MAC when another known device has the same title.
export function deviceNames(devices: DeviceView[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const d of devices) count.set(title(d), (count.get(title(d)) ?? 0) + 1);
  return new Map(
    devices.map((d) => {
      const t = title(d);
      return [d.key, count.get(t)! > 1 && d.mac ? `${t} · ${d.mac.slice(-4)}` : t];
    }),
  );
}
