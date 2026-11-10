/**
 * The bridge's view of the hub: plain HTTP like any board. One session as
 * `bridge` (user bridge@DISCORD), joined to the mapped rooms, then a long
 * poll of /events.txt. A 401 (session_expired) opens a new session.
 */
import { decodeBody, parseEvents } from './wire';
import type { BridgeEvent } from './wire';

export class HubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface EventBatch {
  /** The seq to resume from: the last event's seq, or `since` / head when empty. */
  last: number;
  events: BridgeEvent[];
}

export class HubClient {
  private sid: string | null = null;
  private readonly rooms: string[];

  constructor(
    private readonly hubUrl: string,
    private readonly boardKey: string,
    private readonly handle: string,
    rooms: Iterable<string>,
  ) {
    // Copied: a one-shot iterator (Map.keys()) would be spent by the first open().
    this.rooms = [...rooms];
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Board ${this.boardKey}`, 'Content-Type': 'application/json' };
    if (this.sid) h['X-Chat-Session'] = this.sid;
    return h;
  }

  private async send(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<Buffer> {
    const res = await fetch(`${this.hubUrl}/chat/v1${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new HubError(`${method} ${path} -> ${res.status} ${buf.toString('utf8').slice(0, 200)}`, res.status);
    return buf;
  }

  /** Open a fresh session and join every mapped room. */
  async open(signal?: AbortSignal): Promise<void> {
    this.sid = null;
    const created = JSON.parse((await this.send('POST', '/sessions', { handle: this.handle }, signal)).toString('utf8')) as { sid: string };
    this.sid = created.sid;
    for (const room of this.rooms) await this.send('POST', `/rooms/${encodeURIComponent(room)}/join`, {}, signal);
  }

  /** Long-poll. `since` undefined asks the hub for its head (no replay on first run). */
  async poll(since: number | undefined, waitSeconds: number, signal?: AbortSignal): Promise<EventBatch> {
    if (!this.sid) await this.open(signal);
    const q = `wait=${waitSeconds}${since === undefined ? '' : `&since=${since}`}`;
    try {
      const parsed = parseEvents(decodeBody(await this.send('GET', `/events.txt?${q}`, undefined, signal)));
      return { last: parsed.revision, events: parsed.events };
    } catch (err) {
      if (err instanceof HubError && err.status === 401) this.sid = null; // next poll re-opens the session
      throw err;
    }
  }
}
