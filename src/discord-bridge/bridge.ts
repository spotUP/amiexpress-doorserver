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
}

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
export async function startBridge(config: BridgeConfig, handlers: BridgeHandlers, opts: BridgeOptions = {}): Promise<BridgeHandle> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const minBackoff = opts.minBackoffMs ?? 500;
  const maxBackoff = opts.maxBackoffMs ?? 30000;
  const state = new BridgeState(config.dbPath);
  const hub = new HubClient(config.hubUrl, config.boardKey, config.handle, config.rooms.keys());
  const abort = new AbortController();

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
  const loop = (async (): Promise<void> => {
    let backoff = minBackoff;
    while (!abort.signal.aborted) {
      try {
        const batch = await hub.poll(seq, config.waitSeconds, abort.signal);
        backoff = minBackoff;
        for (const ev of batch.events) {
          try {
            await handlers.onEvent(ev);
          } catch (err) {
            log(`[ERROR] handler failed on event ${ev.seq} (${ev.type}): ${(err as Error).message}`);
          }
        }
        if (batch.last > seq) {
          seq = batch.last;
          state.setSeq(seq);
        }
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
