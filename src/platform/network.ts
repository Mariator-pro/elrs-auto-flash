import { networkInterfaces } from 'node:os';

export interface Ipv4Network {
  address: string;
  netmask: string;
}

// The computer's own IPv4 networks, without loopback.
export function ipv4Networks(): Ipv4Network[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((n) => n !== undefined && n.family === 'IPv4' && !n.internal)
    .map((n) => ({ address: n!.address, netmask: n!.netmask }));
}
