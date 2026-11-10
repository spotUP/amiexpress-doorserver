/**
 * Default HTTP fetcher for the integrations.
 *
 * https only, 10s timeout, 1 MB response cap, fixed UA. Redirects are
 * followed by the underlying stack only while they stay on https; the
 * SSRF guard for user-defined sources lives in the custom adapter,
 * which validates the final host before calling this.
 */
import * as https from 'https';
import * as dns from 'dns';
import type { FetchJson, FetchText, HeadStatus } from './types';

export const FETCH_TIMEOUT_MS = 10000;
export const FETCH_MAX_BYTES = 1024 * 1024;
export const USER_AGENT = 'AmiExpress-DoorServer/1.0 (operator-chat integrations; https://doors.uprough.net)';

export class ResponseTooLarge extends Error {
  constructor(maxBytes: number) {
    super(`response over ${Math.round(maxBytes / 1024)} KB cap`);
    this.name = 'ResponseTooLarge';
  }
}

function getBody(
  url: string,
  accept: string,
  timeoutMs: number,
  method = 'GET',
  maxBytes = FETCH_MAX_BYTES
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`bad url: ${url}`));
      return;
    }
    if (parsed.protocol !== 'https:') {
      reject(new Error('https only'));
      return;
    }
    const req = https.request(
      url,
      { method, headers: { Accept: accept, 'User-Agent': USER_AGENT } },
      (res) => {
        if (method === 'HEAD') {
          res.resume();
          resolve(Buffer.from(String(res.statusCode ?? 0)));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
          res.on('data', (c: Buffer) => {
            bytes += c.length;
            if (bytes > maxBytes) {
              req.destroy(new ResponseTooLarge(maxBytes));
              return;
            }
            chunks.push(c);
          });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('fetch timeout')));
    req.on('error', reject);
    req.end();
  });
}

export function createFetchText(opts?: { timeoutMs?: number; maxBytes?: number }): FetchText {
  const timeoutMs = opts?.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? FETCH_MAX_BYTES;
  return async (url: string) => (await getBody(url, '*/*', timeoutMs, 'GET', maxBytes)).toString('utf-8');
}

export function createHeadStatus(opts?: { timeoutMs?: number }): HeadStatus {
  const timeoutMs = opts?.timeoutMs ?? FETCH_TIMEOUT_MS;
  return async (url: string) => Number(await getBody(url, '*/*', timeoutMs, 'HEAD'));
}

export interface RawResponse {
  status: number;
  location?: string;
  body: Buffer;
}

/** Status + headers + body without following redirects: the custom-source
 *  adapter validates each hop itself (SSRF guard), the shared JSON fetcher
 *  fails 3xx closed. Same timeout and cap. */
export function fetchRaw(
  url: string,
  opts?: { timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> }
): Promise<RawResponse> {
  const timeoutMs = opts?.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? FETCH_MAX_BYTES;
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('bad url'));
      return;
    }
    if (parsed.protocol !== 'https:') {
      reject(new Error('https only'));
      return;
    }
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...(opts?.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (c: Buffer) => {
          bytes += c.length;
          if (bytes > maxBytes) {
            req.destroy(new ResponseTooLarge(maxBytes));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            body: Buffer.concat(chunks),
          })
        );
        res.on('error', reject);
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('fetch timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** SSRF guard for caller-supplied URLs (/check, custom sources): https
 *  only, no credentials in the URL, and the host must not resolve to a
 *  loopback / RFC-1918 / link-local address. Throws on violation. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('bad url');
  }
  if (parsed.protocol !== 'https:') throw new Error('https only');
  if (parsed.username || parsed.password) throw new Error('credentials in url');
  const addrs = await dns.promises.lookup(parsed.hostname, { all: true }).catch(() => []);
  const privateRe =
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fe80:|fc00:|fd)/i;
  for (const a of addrs) {
    if (privateRe.test(a.address)) throw new Error('private host');
  }
  if (addrs.length === 0) throw new Error('unresolvable host');
  return parsed;
}

export function createFetchJson(opts?: { timeoutMs?: number }): FetchJson {
  const text = createFetchText(opts);
  return async (url: string) => {
    const body = await text(url);
    try {
      return JSON.parse(body);
    } catch (e) {
      throw new Error(`bad JSON: ${(e as Error).message}`);
    }
  };
}
