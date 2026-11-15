/**
 * One PLP/1 connection: login, then the live loop with one `D` frame in flight.
 *
 * The chat session behind it is an ordinary chat_sessions row made by the same
 * createSession /chat/v1 uses, in the same achievements.db: one store, so a
 * Partyline caller is in /chat/v1's who list and rooms like any other session.
 * The resume token IS that sid. It is only honoured after a good AUTH for the
 * same board and handle, so on a plain link it is worth nothing without the key.
 */
import type { Duplex } from 'stream';
import { PLP_CLIENT, PLP_HUB, PLP_LIMITS, PLP_MAX_PAYLOAD, PLP_MINOR } from '../../contract/partyline-types';
import type { PlpFrame, PlpHello, PlpRefusal } from '../../contract/partyline-types';
import { withAchievementsDb } from '../achievements/db';
import type { AchievementsConfig } from '../achievements/config';
import { SurfaceError } from '../achievements/errors';
import type { ChatConfig } from '../chat/config';
import { createSession, expireSession, newId, resolveSession } from '../chat/sessions';
import { encodeFrame, FrameDecoder, FrameError, kvPayload, readAck, seqPayload } from './frames';
import { newNonce, parseHello, pickVersion, verifyAuth } from './auth';

/**
 * What the hub engine (P2, src/partyline/ui/) implements. P1 ships a stub.
 * render(full) returns the bytes that bring the caller's terminal from the
 * last render to now; full = redraw everything (login, resize, resume).
 */
export interface PartylineScreen {
  resize(cols: number, rows: number): void;
  input(bytes: Buffer): void;
  render(full: boolean): Buffer | RenderPart[];
  /** A `U` frame from the relay: `ok <fileId>` or `fail <reason>`. */
  upload?(payload: Buffer): void;
  /** An `M` frame from the caller's board (voice/video); present only for media=1 callers' screens. */
  media?(payload: Buffer): void;
  /** The connection is gone: drop subscriptions. */
  close?(): void;
}

/** Ordered output: `D` terminal bytes, `G` kitty APC bytes (only for a kitty=1 caller). */
export interface RenderPart { type: 'D' | 'G'; bytes: Buffer }

/** A render as parts: a bare Buffer is one D part. */
export function renderParts(out: Buffer | RenderPart[]): RenderPart[] {
  return Buffer.isBuffer(out) ? [{ type: 'D', bytes: out }] : out;
}

export interface ScreenInfo {
  sid: string;
  user: string;
  /** The authenticated board's id (resolveSession needs it). */
  boardId: string;
  hello: PlpHello;
  /** Call when the model changed; the session coalesces and flushes. */
  markDirty: () => void;
  /** /quit: end the connection the way a BYE does (no resume). */
  quit?: () => void;
  /** Send a `T` frame (host action) to the client. */
  ctrl?: (text: string) => void;
  /** Send an `S` frame: a notification sound cue for the caller's board to play. */
  sound?: (cue: string) => void;
  /** Send an `M` frame (voice/video), only when the caller said media=1; dropped when the socket is backed up. */
  media?: (payload: Buffer) => void;
}
export type ScreenFactory = (info: ScreenInfo) => PartylineScreen;

export const OLD_CLIENT_SCREEN = 'This board runs an old Partyline client. Ask the sysop to update.';
const REFUSAL_TEXT: Record<PlpRefusal, string> = {
  old_client: OLD_CLIENT_SCREEN,
  bad_hello: 'Partyline could not read this board\'s login. Ask the sysop to check the door setup.',
  unauthenticated: 'Partyline does not know this board key. Ask the sysop to check the door setup.',
  board_suspended: 'This board is suspended from Partyline.',
  rate_limited: 'Partyline is full for this board right now. Try again in a minute.',
  draining: 'Partyline is restarting. Try again in a moment.',
  login_timeout: 'Partyline login timed out.',
};

/** The P1 placeholder screen: a banner and the input line, repainted whole. */
export const stubScreen: ScreenFactory = (info) => {
  let cols = info.hello.cols;
  let rows = info.hello.rows;
  let line = '';
  return {
    resize(c, r) { cols = c; rows = r; },
    input(bytes) {
      for (const b of bytes) {
        if (b === 0x0d) line = '';
        else if (b === 0x08 || b === 0x7f) line = line.slice(0, -1);
        else if (b >= 0x20) line += String.fromCharCode(b);
      }
      info.markDirty();
    },
    render() {
      return Buffer.from(`\x1b[H\x1b[2JPartyline ${info.user} ${cols}x${rows}\r\n> ${line}`, 'latin1');
    },
  };
};

export interface SessionDeps {
  ach: AchievementsConfig;
  chat: ChatConfig;
  screen: ScreenFactory;
  tls: boolean;
  isDraining: () => boolean;
  onClose: (s: PartylineSession) => void;
  log: (line: string) => void;
}

const PLP_MEDIA_BACKLOG = 256 * 1024;
type State = 'hello' | 'auth' | 'live' | 'closed';

export class PartylineSession {
  readonly id = newId('pl');
  sid: string | null = null;
  private state: State = 'hello';
  private hello: PlpHello | null = null;
  private nonce = '';
  private decoder = new FrameDecoder();
  private screen: PartylineScreen | null = null;
  private seq = 0;
  private inFlight: number | null = null;
  private queue: RenderPart[] = [];
  private dirty = false;
  private full = false;
  private lastFlush = 0;
  private timer: NodeJS.Timeout | null = null;
  private loginTimer: NodeJS.Timeout | null;

  constructor(private readonly sock: Duplex, private readonly deps: SessionDeps) {
    sock.on('data', (chunk: Buffer) => this.onData(chunk));
    sock.on('close', () => this.closed());
    sock.on('error', () => this.closed());
    this.loginTimer = setTimeout(() => this.refuse('login_timeout'), PLP_LIMITS.loginTimeoutMs);
  }

  get live(): boolean {
    return this.state === 'live';
  }

  private send(type: string, payload?: Buffer | string): void {
    if (this.state !== 'closed' && !this.sock.destroyed) this.sock.write(encodeFrame(type, payload));
  }

  /** M frames are lossy: over 256 KB buffered, drop them so terminal output always wins. */
  private sendMedia(payload: Buffer): void {
    if (this.sock.writableLength > PLP_MEDIA_BACKLOG) return;
    this.send(PLP_HUB.MEDIA, payload);
  }

  private onData(chunk: Buffer): void {
    let frames: PlpFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      if (err instanceof FrameError) this.deps.log(`[WARN] partyline ${this.id} dropped: ${err.message}`);
      this.sock.destroy();
      return;
    }
    for (const f of frames) {
      if (this.state === 'closed') return;
      this.onFrame(f);
    }
  }

  private onFrame(f: PlpFrame): void {
    if (this.state === 'hello') {
      if (f.type === PLP_CLIENT.HELLO) this.onHello(f.payload);
      return;
    }
    if (this.state === 'auth') {
      if (f.type === PLP_CLIENT.AUTH) this.onAuth(f.payload);
      return;
    }
    switch (f.type) {
      case PLP_CLIENT.INPUT:
        this.screen!.input(f.payload);
        return;
      case PLP_CLIENT.RESIZE: {
        const m = /^(\d+)\s*x\s*(\d+)$/.exec(f.payload.toString('latin1').trim());
        if (m) {
          this.screen!.resize(Math.min(Number(m[1]), 255) || 80, Math.min(Number(m[2]), 255) || 25);
          this.markDirty(true);
        }
        return;
      }
      case PLP_CLIENT.ACK: {
        const seq = readAck(f.payload);
        if (seq !== null && this.inFlight !== null && seq >= this.inFlight) {
          this.inFlight = null;
          if (this.queue.length > 0) this.flush();
          else this.schedule();
        }
        return;
      }
      case PLP_CLIENT.UPLOAD:
        this.screen!.upload?.(f.payload);
        return;
      case PLP_CLIENT.MEDIA:
        if (this.hello?.media) this.screen!.media?.(f.payload);
        return;
      case PLP_CLIENT.PING:
        this.send(PLP_HUB.PONG, f.payload);
        return;
      case PLP_CLIENT.BYE:
        this.bye(f.payload.toString('latin1').trim());
        return;
      default:
        // Unknown types are skipped (forward compatibility).
        return;
    }
  }

  private onHello(payload: Buffer): void {
    const hello = parseHello(payload);
    this.deps.log(`[INFO] partyline hello client=${hello.client || '?'} proto=${hello.proto || '?'} board=${hello.board || '?'} ${this.deps.tls ? 'tls' : 'plain'}`);
    if (this.deps.isDraining()) return this.refuse('draining');
    if (pickVersion(hello.proto) === null) return this.refuse('old_client');
    if (!hello.board || !hello.handle) return this.refuse('bad_hello');
    this.hello = hello;
    this.nonce = newNonce();
    this.state = 'auth';
    this.send(PLP_HUB.CHALLENGE, this.nonce);
  }

  private onAuth(mac: Buffer): void {
    const hello = this.hello!;
    let sid: string;
    let user: string;
    let boardId: string;
    try {
      const out = withAchievementsDb(this.deps.ach, (db) => {
        const auth = verifyAuth(db, hello, this.nonce, mac);
        if (!auth.ok) return auth;
        return db.transaction(() => ({ ok: true as const, boardId: auth.boardId, ...this.openChatSession(db, auth.boardId, hello) }))();
      });
      if (!out.ok) return this.refuse(out.reason);
      ({ sid, user, boardId } = out);
    } catch (err) {
      if (err instanceof SurfaceError && err.status === 429) return this.refuse('rate_limited');
      this.deps.log(`[ERROR] partyline ${this.id} login failed: ${(err as Error).message}`);
      return this.refuse('unauthenticated');
    }
    if (this.loginTimer) clearTimeout(this.loginTimer);
    this.loginTimer = null;
    this.sid = sid;
    this.state = 'live';
    const features = [hello.kitty ? 'kitty' : '', hello.media ? 'media' : ''].filter(Boolean).join(',');
    this.send(PLP_HUB.WELCOME, kvPayload({ proto: `1.${pickVersion(hello.proto) ?? PLP_MINOR}`, features, session: this.id, resume: sid }));
    this.screen = this.deps.screen({ sid, user, boardId, hello, markDirty: () => this.markDirty(), quit: () => this.bye('quit'), ctrl: (t) => this.send(PLP_HUB.CTRL, t), sound: (c) => this.send(PLP_HUB.SOUND, c), media: hello.media ? (p) => this.sendMedia(p) : undefined });
    this.markDirty(true);
  }

  /** Resume the chat session the token names when it is still this caller's; else a fresh one. */
  private openChatSession(db: Parameters<typeof createSession>[0], boardId: string, hello: PlpHello): { sid: string; user: string } {
    if (hello.resume) {
      try {
        const ctx = resolveSession(db, this.deps.chat, hello.resume, boardId);
        if (ctx.handle === hello.handle && ctx.sid) return { sid: ctx.sid, user: ctx.user };
      } catch {
        // stale or foreign token: fall through to a fresh session
      }
    }
    const s = createSession(db, this.deps.chat, boardId, { handle: hello.handle, sysop: hello.sysop, client: hello.client });
    return { sid: s.sid, user: s.user };
  }

  markDirty(full = false): void {
    this.dirty = true;
    this.full = this.full || full;
    this.schedule();
  }

  /** At most one flush per flushIntervalMs, and none while a frame is unacked. */
  private schedule(): void {
    if (this.timer || this.inFlight !== null || !this.dirty || this.state !== 'live') return;
    const wait = Math.max(0, this.lastFlush + PLP_LIMITS.flushIntervalMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (this.inFlight !== null || this.state !== 'live') return;
    if (this.queue.length === 0 && this.dirty) {
      // Render only now, so everything that changed while waiting is one latest diff, never a backlog.
      const out = this.screen!.render(this.full);
      this.dirty = false;
      this.full = false;
      for (const { type, bytes } of renderParts(out)) {
        for (let i = 0; i < bytes.length; i += PLP_MAX_PAYLOAD - 4) this.queue.push({ type, bytes: bytes.subarray(i, i + PLP_MAX_PAYLOAD - 4) });
      }
    }
    const next = this.queue.shift();
    if (!next) return;
    this.seq += 1;
    this.inFlight = this.seq;
    this.lastFlush = Date.now();
    this.send(next.type === 'G' ? PLP_HUB.GRAPHICS : PLP_HUB.OUTPUT, seqPayload(this.seq, next.bytes));
  }

  /** One D with the refusal screen, then X; the chat session (if any) is untouched. */
  private refuse(reason: PlpRefusal): void {
    this.send(PLP_HUB.OUTPUT, seqPayload(++this.seq, Buffer.from(`\r\n${REFUSAL_TEXT[reason]}\r\n`, 'latin1')));
    this.send(PLP_HUB.EXIT, reason);
    this.end();
  }

  /** Caller left on purpose: the chat session goes with it, no resume. */
  private bye(reason: string): void {
    this.deps.log(`[INFO] partyline ${this.id} bye ${reason || '?'}`);
    const sid = this.sid;
    if (sid) withAchievementsDb(this.deps.ach, (db) => db.transaction(() => expireSession(db, sid))());
    this.sid = null;
    this.end();
  }

  /** SIGTERM: one status line, then close; the chat session stays so the client can resume. */
  drain(): void {
    if (this.state === 'live') this.send(PLP_HUB.OUTPUT, seqPayload(++this.seq, Buffer.from('\r\nPartyline is restarting, reconnecting...\r\n', 'latin1')));
    this.end();
  }

  private end(): void {
    if (!this.sock.destroyed) this.sock.end();
    this.closed();
  }

  private closed(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.timer) clearTimeout(this.timer);
    if (this.loginTimer) clearTimeout(this.loginTimer);
    this.timer = null;
    this.loginTimer = null;
    this.screen?.close?.();
    this.deps.onClose(this);
  }
}
