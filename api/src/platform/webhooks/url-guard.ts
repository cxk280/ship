/**
 * SSRF guard for webhook target URLs. Without this, an app with webhooks:manage
 * could point a subscription at loopback / link-local / RFC1918 / cloud-metadata
 * addresses and make the server fetch them on delivery or replay.
 *
 * Production: require https AND reject any host that resolves (via DNS) to a
 * private address (defeats DNS rebinding). Dev/test (allowPrivate): permit http +
 * localhost so the TTFE drill can deliver to a local listener.
 */
import dns from 'dns';

/**
 * Extract the embedded IPv4 (dotted) from an IPv4-mapped IPv6 address, handling
 * the dotted (`::ffff:127.0.0.1`), 2-group hex (`::ffff:7f00:1`), and single hex
 * (`::ffff:7f000001`) forms Node may normalize to. Returns null if not mapped.
 */
function mappedV4(ipLower: string): string | null {
  const m = ipLower.match(/^::ffff:(.+)$/);
  if (!m) return null;
  const tail = m[1]!;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail; // dotted
  const groups = tail.split(':');
  if (groups.length === 2 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
    const hi = parseInt(groups[0]!, 16);
    const lo = parseInt(groups[1]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  if (groups.length === 1 && /^[0-9a-f]{1,8}$/.test(groups[0]!)) {
    const n = parseInt(groups[0]!, 16);
    return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
  }
  return null;
}

export function isPrivateIp(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');

  // IPv4-mapped IPv6 (any form) → classify the embedded IPv4 first.
  const mapped = mappedV4(lower);
  if (mapped) return isPrivateIp(mapped);

  const v4 = lower.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true; // this-net, RFC1918-10, loopback
    if (a === 169 && b === 254) return true; // link-local + 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918-172
    if (a === 192 && b === 168) return true; // RFC1918-192
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local
  return false;
}

export interface UrlGuardOptions {
  /** Dev/test: allow http + private/loopback hosts (no DNS check). */
  allowPrivate?: boolean;
}

/** Throws an Error if the URL is not a safe public https webhook target. */
export async function assertPublicHttpUrl(rawUrl: string, opts: UrlGuardOptions = {}): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('target_url is not a valid URL');
  }

  if (opts.allowPrivate) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('target_url must be http or https');
    }
    return;
  }

  if (url.protocol !== 'https:') throw new Error('Webhook target_url must use https');

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('Webhook target_url may not be localhost');
  }
  // If it's already an IP literal, check directly; otherwise resolve all records.
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host)) throw new Error('Webhook target_url may not be a private address');
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new Error('Could not resolve webhook target host');
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new Error('Webhook target_url resolves to a private address');
    }
  }
}

/** Whether private targets are allowed in the current environment. */
export function allowPrivateTargets(): boolean {
  return process.env.NODE_ENV !== 'production';
}
