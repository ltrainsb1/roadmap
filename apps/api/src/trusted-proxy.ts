import { BlockList, isIP } from 'node:net';

const MAPPED_V4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

/**
 * A test for "is this peer address inside one of these CIDRs" (as loadConfig validated them). An IPv4 peer seen
 * through a dual-stack socket (::ffff:a.b.c.d) is checked as the IPv4 address it is. No CIDRs: nothing matches.
 */
export function addressMatcher(cidrs: readonly string[]): (address: string) => boolean {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [network, prefix] = cidr.split('/') as [string, string];
    list.addSubnet(network, Number(prefix), isIP(network) === 6 ? 'ipv6' : 'ipv4');
  }
  return (address) => {
    const plain = MAPPED_V4.exec(address)?.[1] ?? address;
    const version = isIP(plain);
    if (version === 0) return false;
    return list.check(plain, version === 6 ? 'ipv6' : 'ipv4');
  };
}
