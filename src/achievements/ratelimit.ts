/**
 * Rate limits, on the WRITE API only.
 *
 * GET /catalog, /catalog.txt, /leaderboard, /leaderboard.txt,
 * /players/<email> and /health are NOT limited, and a test names them one
 * by one. The exception the spec grants is narrow: a limiter on a read
 * path is exactly the "locks out legitimate BBS users" failure the
 * project-wide no-rate-limiting rule exists to prevent, and no BBS-facing
 * path in either repo gains one.
 *
 * In-process fixed windows in a Map (D15): one container, one process, so
 * a second store would be a second thing to fail. The per-player counters
 * are keyed by email_key, so a board cannot dodge them by re-batching, and
 * an attacker who guesses an address can lock its owner out of nothing but
 * more mail.
 */
import type { Request } from 'express';
import { SurfaceError } from './errors';

export interface Limit {
  max: number;
  windowSeconds: number;
}

const MINUTE = 60;
const HOUR = 3600;

export const LIMITS = {
  eventsPerBoard: { max: 120, windowSeconds: MINUTE } as Limit,
  eventRowsPerBoard: { max: 12000, windowSeconds: MINUTE } as Limit,
  eventRowsPerPlayer: { max: 600, windowSeconds: MINUTE } as Limit,
  registerPerBoard: { max: 10, windowSeconds: MINUTE } as Limit,
  registerPerEmail: { max: 3, windowSeconds: HOUR } as Limit,
  verifyPerBoard: { max: 30, windowSeconds: MINUTE } as Limit,
  verifyPerEmail: { max: 10, windowSeconds: HOUR } as Limit,
  linksPerBoard: { max: 30, windowSeconds: MINUTE } as Limit,
  linksPerEmail: { max: 10, windowSeconds: HOUR } as Limit,
  doorCatalogPerBoard: { max: 10, windowSeconds: MINUTE } as Limit,
  adminPerAdmin: { max: 20, windowSeconds: MINUTE } as Limit,
  // The global-requests surface (src/requests/), writes only. A GET is never
  // limited here either - the same read exemption the header states.
  requestsPostPerBoard: { max: 20, windowSeconds: MINUTE } as Limit,
  requestsPostPerHandle: { max: 10, windowSeconds: HOUR } as Limit,
  requestsActionPerBoard: { max: 60, windowSeconds: MINUTE } as Limit,
};

/** lower(trim(handle)) - the requests identity, shared with the store. */
export function requestHandleKey(handle: unknown): string | null {
  return typeof handle === 'string' && handle.trim().length > 0
    ? handle.trim().toLowerCase()
    : null;
}

interface Window {
  startedAt: number;
  count: number;
}

const windows = new Map<string, Window>();
let clock: () => number = () => Math.floor(Date.now() / 1000);

export function _resetRateLimitsForTests(now?: () => number): void {
  windows.clear();
  clock = now ?? (() => Math.floor(Date.now() / 1000));
}

/** How many times the limiter refused a request; the ledger's sentinel. */
let refusals = 0;
export function _rateLimitRefusalsForTests(): number {
  return refusals;
}

export interface Charge {
  key: string;
  limit: Limit;
  cost?: number;
}

/**
 * Charge every counter, or refuse the request with 429 and Retry-After.
 * All-or-nothing: a request refused on its second counter is not charged
 * on its first, so a refused caller does not eat their own window.
 */
export function charge(charges: Charge[]): void {
  const now = clock();
  const planned: { w: Window; cost: number; key: string }[] = [];
  for (const c of charges) {
    const cost = c.cost ?? 1;
    let w = windows.get(c.key);
    if (!w || now - w.startedAt >= c.limit.windowSeconds) {
      w = { startedAt: now, count: 0 };
      windows.set(c.key, w);
    }
    if (w.count + cost > c.limit.max) {
      refusals += 1;
      const retryAfter = Math.max(1, w.startedAt + c.limit.windowSeconds - now);
      throw new SurfaceError('rate_limited', 429, 'over the write rate; try again later', retryAfter);
    }
    planned.push({ w, cost, key: c.key });
  }
  for (const p of planned) p.w.count += p.cost;
}

/** Give back what `charge` took, for a charge whose work was abandoned (an upload cancelled or dropped). */
export function refund(charges: Charge[]): void {
  for (const c of charges) {
    const w = windows.get(c.key);
    if (w) w.count = Math.max(0, w.count - (c.cost ?? 1));
  }
}

const emailKey = (email: unknown): string | null =>
  typeof email === 'string' && email.trim().length > 0 ? email.trim().toLowerCase() : null;

/** The counters a request charges, by route. */
export function chargesFor(route: 'events' | 'register' | 'verify' | 'links' | 'doorCatalog' | 'requestPost' | 'requestAction', boardId: string, body: unknown): Charge[] {
  const b = (body ?? {}) as Record<string, unknown>;
  switch (route) {
    case 'requestPost': {
      // Per board AND per handle: a board cannot post a thousand under a
      // hundred handles, and one handle cannot flood a hundred boards.
      const k = requestHandleKey(b.handle);
      return [
        { key: `req-post:board:${boardId}`, limit: LIMITS.requestsPostPerBoard },
        ...(k ? [{ key: `req-post:handle:${boardId}:${k}`, limit: LIMITS.requestsPostPerHandle }] : []),
      ];
    }
    case 'requestAction':
      // vote / claim / release / done / withdraw: one board budget covers them
      // all, so a spammer cannot vote a thousand times a minute.
      return [{ key: `req-action:board:${boardId}`, limit: LIMITS.requestsActionPerBoard }];
    case 'events': {
      const events = Array.isArray(b.events) ? (b.events as Record<string, unknown>[]) : [];
      const perPlayer = new Map<string, number>();
      for (const e of events) {
        const k = emailKey(e?.email);
        if (k) perPlayer.set(k, (perPlayer.get(k) ?? 0) + 1);
      }
      return [
        { key: `events:board:${boardId}`, limit: LIMITS.eventsPerBoard },
        { key: `event-rows:board:${boardId}`, limit: LIMITS.eventRowsPerBoard, cost: Math.max(1, events.length) },
        ...[...perPlayer].map(([k, n]) => ({ key: `event-rows:player:${k}`, limit: LIMITS.eventRowsPerPlayer, cost: n })),
      ];
    }
    case 'register':
      // The per-address budget is MAIL, not requests: it is charged by the
      // handler right before a mail is queued (chargeMail), so a request
      // refused for a bad handle does not eat the address's three.
      return [{ key: `register:board:${boardId}`, limit: LIMITS.registerPerBoard }];
    case 'verify': {
      const k = emailKey(b.email);
      return [
        { key: `verify:board:${boardId}`, limit: LIMITS.verifyPerBoard },
        ...(k ? [{ key: `verify:email:${k}`, limit: LIMITS.verifyPerEmail }] : []),
      ];
    }
    case 'links': {
      const k = emailKey(b.email);
      return [
        { key: `links:board:${boardId}`, limit: LIMITS.linksPerBoard },
        ...(k ? [{ key: `links:email:${k}`, limit: LIMITS.linksPerEmail }] : []),
      ];
    }
    case 'doorCatalog':
      return [{ key: `door-catalog:board:${boardId}`, limit: LIMITS.doorCatalogPerBoard }];
    default:
      return [];
  }
}

/** Express middleware: charge before the handler, so a 429 stores nothing. */
export function rateLimit(route: Parameters<typeof chargesFor>[0]) {
  return (req: Request & { board?: { id: string } }, _res: unknown, next: (err?: unknown) => void): void => {
    try {
      charge(chargesFor(route, req.board?.id ?? 'anonymous', req.body));
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function rateLimitAdmin() {
  return (req: Request & { admin?: { username: string } }, _res: unknown, next: (err?: unknown) => void): void => {
    try {
      charge([{ key: `admin:${req.admin?.username ?? 'anonymous'}`, limit: LIMITS.adminPerAdmin }]);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** The mail budget for one address: three in an hour, charged at the queue. */
export function chargeMail(email: string): void {
  const k = emailKey(email);
  if (k) charge([{ key: `register:email:${k}`, limit: LIMITS.registerPerEmail }]);
}
