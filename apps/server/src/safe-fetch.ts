import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Config } from './config.js';

/**
 * Addresses a server must not be talked into calling: loopback, private networks, link-local
 * (169.254.169.254 is the cloud metadata service), CGNAT, multicast, documentation and reserved
 * ranges, for IPv4 and IPv6. IPv4-mapped IPv6 is checked as IPv4.
 */
const internal = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  internal.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  internal.addSubnet(net, prefix, 'ipv6');
}

export function isInternalAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return internal.check(mapped[1], 'ipv4');
  const family = isIP(address);
  if (family === 4) return internal.check(address, 'ipv4');
  if (family === 6) return internal.check(address, 'ipv6');
  return true;
}

export interface FetchPolicy {
  /** `private` lets hosts reach internal addresses (only those in `allow`, when it has any). */
  mode: 'public' | 'private';
  allow: string[];
}

export const policyFrom = (config: Config): FetchPolicy => ({
  mode: config.fetch,
  allow: config.fetchAllow,
});

export class FetchRefused extends Error {}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

function mayReach(policy: FetchPolicy, host: string, address: string): boolean {
  if (!isInternalAddress(address)) return true;
  if (policy.mode !== 'private') return false;
  return policy.allow.length === 0 || policy.allow.includes(host.toLowerCase());
}

const refusal = (host: string) =>
  new FetchRefused(
    `${host} is an internal address. To reach it, set OPENUSECASE_FETCH=private (and list the host in OPENUSECASE_FETCH_ALLOW).`,
  );

export interface SafeResponse {
  status: number;
  body: string;
}

export interface SafeRequest {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Milliseconds for the whole request. Default 10 s. */
  timeout?: number;
  /** Bytes of answer kept. Default 1 MB. */
  maxBytes?: number;
}

/**
 * Fetches a URL someone gave us without becoming a way into the network the server runs in.
 * Every address the name resolves to is checked when the connection is made (a `lookup` hook),
 * which also stops DNS rebinding. Redirects are not followed: a 3xx is the answer.
 */
export function safeFetch(
  target: string,
  policy: FetchPolicy,
  request: SafeRequest = {},
): Promise<SafeResponse> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return Promise.reject(new FetchRefused(`"${target}" isn't a URL.`));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.reject(new FetchRefused('Only http and https URLs can be fetched.'));
  }
  if (url.username || url.password) {
    return Promise.reject(new FetchRefused('Leave the user name and password out of the URL.'));
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !mayReach(policy, host, host)) return Promise.reject(refusal(host));

  const lookup = (
    hostname: string,
    options: object,
    callback: LookupCallback,
  ) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, []);
        return;
      }
      const list = addresses;
      const blocked = list.find((a) => !mayReach(policy, hostname, a.address));
      if (blocked) {
        callback(refusal(hostname), []);
        return;
      }
      if ((options as { all?: boolean }).all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    });
  };

  const client = url.protocol === 'https:' ? https : http;
  const timeout = request.timeout ?? 10_000;
  const maxBytes = request.maxBytes ?? 1_000_000;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: request.method ?? 'GET',
        headers: request.headers,
        lookup: lookup,
        // A fresh connection every time: a pooled socket would skip the address check.
        agent: false,
        timeout,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error(`The answer from ${host} was too large.`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`${host} didn't answer within ${Math.round(timeout / 1000)} seconds.`));
    }, timeout);
    req.on('close', () => {
      clearTimeout(timer);
    });
    req.on('timeout', () => {
      req.destroy(new Error(`${host} didn't answer within ${Math.round(timeout / 1000)} seconds.`));
    });
    req.on('error', (err) => {
      reject(err);
    });
    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
}
