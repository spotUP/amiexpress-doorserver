/**
 * Default HTTP fetcher for the integrations.
 *
 * https only, 10s timeout, 1 MB response cap, fixed UA. Redirects are
 * followed by the underlying stack only while they stay on https; the
 * SSRF guard for user-defined sources lives in the custom adapter,
 * which validates the final host before calling this.
 */
import * as https from 'https';
import type { FetchJson } from './types';

export const FETCH_TIMEOUT_MS = 10000;
export const FETCH_MAX_BYTES = 1024 * 1024;
export const USER_AGENT = 'AmiExpress-DoorServer/1.0 (operator-chat integrations; https://doors.uprough.net)';

export function createFetchJson(opts?: { timeoutMs?: number }): FetchJson {
  const timeoutMs = opts?.timeoutMs ?? FETCH_TIMEOUT_MS;
  return (url: string) =>
    new Promise((resolve, reject) => {
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
      const req = https.get(
        url,
        { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on('data', (c: Buffer) => {
            bytes += c.length;
            if (bytes > FETCH_MAX_BYTES) {
              req.destroy(new Error('response over 1 MB cap'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
            } catch (e) {
              reject(new Error(`bad JSON: ${(e as Error).message}`));
            }
          });
          res.on('error', reject);
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error('fetch timeout')));
      req.on('error', reject);
    });
}
