import { describe, it, expect } from 'vitest';
import { isPrivateIp, assertPublicHttpUrl } from '../url-guard.js';

describe('isPrivateIp', () => {
  it('flags loopback, link-local/metadata, RFC1918, CGNAT, and IPv6 private', () => {
    for (const ip of ['127.0.0.1', '169.254.169.254', '10.0.0.5', '172.16.0.1', '192.168.1.1', '100.64.0.1', '::1', 'fe80::1', 'fd00::1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it('flags IPv4-mapped IPv6 private addresses in dotted AND hex forms', () => {
    for (const ip of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:7f000001', '[::ffff:a9fe:a9fe]', '::ffff:10.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it('allows public addresses (incl. mapped public)', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1::1', '::ffff:8.8.8.8', '::ffff:0808:0808']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

describe('assertPublicHttpUrl (production-strict, allowPrivate=false)', () => {
  it('rejects http, localhost, and IP-literal private targets', async () => {
    await expect(assertPublicHttpUrl('http://example.com/hook')).rejects.toThrow(/https/);
    await expect(assertPublicHttpUrl('https://localhost/hook')).rejects.toThrow(/localhost/);
    await expect(assertPublicHttpUrl('https://127.0.0.1/hook')).rejects.toThrow(/private/);
    await expect(assertPublicHttpUrl('https://169.254.169.254/latest/meta-data')).rejects.toThrow(/private/);
    await expect(assertPublicHttpUrl('https://10.0.0.9/hook')).rejects.toThrow(/private/);
  });

  it('allows a public https IP-literal target', async () => {
    await expect(assertPublicHttpUrl('https://93.184.216.34/hook')).resolves.toBeUndefined();
  });
});

describe('assertPublicHttpUrl (dev/test, allowPrivate=true)', () => {
  it('permits http + localhost so the TTFE local listener works', async () => {
    await expect(assertPublicHttpUrl('http://localhost:4000/hook', { allowPrivate: true })).resolves.toBeUndefined();
    await expect(assertPublicHttpUrl('ftp://localhost/x', { allowPrivate: true })).rejects.toThrow(/http/);
  });
});
