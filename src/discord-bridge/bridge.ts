/**
 * The bridge event loop. Phases 3-5 fill the handler; this owns the hub
 * session, the stored seq and the stop handle.
 */
import { HubClient } from './hub-client';
import { BridgeState } from './state';
import type { BridgeConfig } from './config';
import type { BridgeEvent } from './wire';

export interface BridgeHandlers {
  onEvent(ev: BridgeEvent): Promise<void> | void;
}

export interface BridgeHandle {
  state: BridgeState;
  /** Abort the poll, wait for the loop to end, close the state DB. */
  stop(): Promise<void>;
}

export interface BridgeOptions {
  log?: (line: string) => void;
  /** Backoff after a hub error, doubling up to maxBackoffMs. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Attempts per event before it is logged, skipped and the seq advances. */
  eventAttempts?: number;
  /** First delay between attempts on one event; doubles each retry. */
  eventBackoffMs?: number;
  /** Called after every successful hub poll, with the seq the bridge has reached. */
  onPolled?: (seq: number) => void;
}

export type HandlersFactory = (hub: HubClient, state: BridgeState) => BridgeHandlers;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      signal.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

/**
 * Open the hub session, settle the starting seq (stored, else the hub's head
 * so a first run never replays history), then run the loop in the background.
 */
export async function startBridge(config: BridgeConfig, handlersOrFactory: BridgeHandlers | HandlersFactory, opts: BridgeOptions = {}): Promise<BridgeHandle> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const minBackoff = opts.minBackoffMs ?? 500;
  const maxBackoff = opts.maxBackoffMs ?? 30000;
  const state = new BridgeState(config.dbPath);
  const hub = new HubClient(config.hubUrl, config.boardKey, config.handle, config.rooms.keys());
  const abort = new AbortController();
  const handlers = typeof handlersOrFactory === 'function' ? handlersOrFactory(hub, state) : handlersOrFactory;
  const attempts = opts.eventAttempts ?? 5;
  const eventBackoff = opts.eventBackoffMs ?? 500;

  let since = state.getSeq();
  try {
    await hub.open(abort.signal);
    if (since === null) {
      since = (await hub.poll(undefined, 0, abort.signal)).last;
      state.setSeq(since);
    }
  } catch (err) {
    state.close();
    throw err;
  }

  let seq: number = since;
  opts.onPolled?.(seq);
  const loop = (async (): Promise<void> => {
    let backoff = minBackoff;
    while (!abort.signal.aborted) {
      try {
        const batch = await hub.poll(seq, config.waitSeconds, abort.signal);
        backoff = minBackoff;
        for (const ev of batch.events) {
          // A failed event is retried; the stored seq never passes it until it
          // succeeds or the attempts run out (then it is skipped, not stalled on).
          for (let attempt = 1; ; attempt++) {
            try {
              await handlers.onEvent(ev);
              break;
            } catch (err) {
              if (abort.signal.aborted) break;
              const msg = `event ${ev.seq} (${ev.type}) attempt ${attempt}/${attempts}: ${(err as Error).message}`;
              if (attempt >= attempts) {
                log(`[ERROR] giving up on ${msg}; skipping`);
                break;
              }
              log(`[WARN] ${msg}; retrying`);
              await sleep(eventBackoff * 2 ** (attempt - 1), abort.signal);
            }
          }
          if (abort.signal.aborted) break;
          if (ev.seq > seq) {
            seq = ev.seq;
            state.setSeq(seq);
          }
        }
        if (abort.signal.aborted) break;
        if (batch.last > seq) {
          seq = batch.last;
          state.setSeq(seq);
        }
        opts.onPolled?.(seq);
      } catch (err) {
        if (abort.signal.aborted) break;
        log(`[ERROR] hub: ${(err as Error).message}; retrying in ${backoff} ms`);
        await sleep(backoff, abort.signal);
        backoff = Math.min(backoff * 2, maxBackoff);
      }
    }
  })();

  return {
    state,
    async stop(): Promise<void> {
      abort.abort();
      await loop;
      state.close();
    },
  };
}
