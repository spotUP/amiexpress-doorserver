/**
 * One Partyline caller's LIVECHAT door, in its own process (forked by
 * livechat-host.ts). The door keeps module-level singletons (events bus it
 * clears on exit, settings, theme, emoji mode, prefsSender), so two callers
 * cannot share one module cache. This process holds the door's bbs, bbsSession
 * and socket shims; the parent owns the hub chat store and the PLP connection.
 */
import { EventEmitter } from 'events';
import * as path from 'path';
import { encodeKittyDelete, encodeKittyImage, encodeKittyPlace, type KittyCrop, type KittyImage, type SendKittyImageOptions } from './kitty-encode';

export interface ChildInit { t: 'init'; doorDir: string; user: string; access: number; sysop: boolean; cols: number; rows: number; utf8: boolean;
  /** The caller's terminal draws kitty pictures (hello kitty=1). */
  kitty: boolean;
  /** The caller's board connection (hello conn=), as the board's bbs.connectionType. */
  conn: 'web' | 'telnet' | 'ssh';
  /** The caller's Alt+Enter choice this call (hello wide=1): responsive instead of 80x25. */
  wide: boolean;
  /** hello responsive=: the board's Responsive Doors state; absent from an older board. */
  responsive?: { board: 'on' | 'off'; choice: 'default' | 'on' | 'off'; door: string };
  /** hello chatonly=1: the door's bbsSession.tempData.chatOnly (the board's /chat page). */
  chatOnly: boolean;
  /** hello node=: the caller's board node, the door's bbsSession.nodeId (status bar "Node N"). */
  node?: number }
export type ToChild =
  | ChildInit
  | { t: 'input'; s: string }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'event'; ev: string; data: Record<string, unknown> }
  /** The host's answer to an emit that carried `ack`. */
  | { t: 'ack'; id: number; result: unknown }
  | { t: 'repaint' };
export type FromChild =
  | { t: 'out'; s: string }
  /** Kitty APC bytes, after every 'out' written before them; the hub sends them as G frames. */
  | { t: 'gfx'; s: string }
  | { t: 'emit'; ev: string; data: Record<string, unknown>; ack?: number }
  | { t: 'end'; error?: string }
  /** The door asks the caller's terminal for 80x25 or responsive (`mode`), or remembers the caller's Alt+Enter choice for the call (`choice`). */
  | { t: 'term'; mode?: 'wide' | 'fixed'; choice?: boolean; responsive?: 'default' | 'on' | 'off' }
  /** A spare finished loading the door. */
  | { t: 'ready' };

interface RepaintableScreen { alloc?(): void; render(): void; destroyed?: boolean }
interface DoorApp { run(): Promise<void> }
interface DoorModule { createApp(session: unknown): DoorApp | Promise<DoorApp> }
interface ScreenModule { createScreen(bbs: unknown): RepaintableScreen }

const send = (m: FromChild): void => { if (process.connected) process.send?.(m); };

function start(init: ChildInit): void {
  let cols = init.cols;
  let rows = init.rows;
  let wide = init.wide;
  let responsive = init.responsive;
  let out = '';
  const flush = (): void => { if (out) { const s2 = out; out = ''; send({ t: 'out', s: s2 }); } };
  const write = (s: string): void => {
    if (!out) setImmediate(flush);
    out += s;
  };
  // Pictures go out raw, never through write (the board's BBSApi does the same: a wrap breaks base64).
  const gfx = (apc: string): true => { flush(); send({ t: 'gfx', s: apc }); return true; };
  const bbs = Object.assign(new EventEmitter(), {
    connectionType: init.conn,
    kittyGraphics: init.kitty,
    sendImage: (image: KittyImage, opts: SendKittyImageOptions = {}): boolean => {
      const { fallback, ...keys } = opts;
      const apc = init.kitty ? encodeKittyImage(image, keys) : null;
      if (apc !== null) return gfx(apc);
      if (fallback) write(fallback);
      return false;
    },
    placeImage: (id: number, c: number, r: number, crop?: KittyCrop, placement?: number, z?: number): boolean =>
      init.kitty && gfx(encodeKittyPlace(id, c, r, crop, placement, z)),
    deleteImage: (id: number, keepData = true, placement?: number): boolean =>
      init.kitty && gfx(encodeKittyDelete(id, keepData, placement)),
    unicodeCapable: init.utf8,
    write,
    writeLine: (s: string) => write(s + '\r\n'),
    getTerminalSize: () => ({ width: cols, height: rows }),
    // The board's BBSApi terminal-mode calls; the board applies them (PLP T terminal-mode / terminal-choice).
    getTerminalModeChoice: () => wide,
    setTerminalModeChoice: (on: boolean) => { wide = on; flush(); send({ t: 'term', choice: on }); },
    // Responsive Doors (W row 24): none without the hello field, so the SDK ignores it as for an older board.
    getResponsiveDoors: responsive && (() => ({ board: responsive!.board, doors: responsive!.choice === 'default' ? {} : { [responsive!.door]: responsive!.choice }, door: responsive!.door })),
    setResponsiveDoors: responsive && (async (choice: 'default' | 'on' | 'off') => {
      responsive = { ...responsive!, choice };
      flush(); send({ t: 'term', responsive: choice });
      return { board: responsive.board, doors: choice === 'default' ? {} : { [responsive.door]: choice }, door: responsive.door };
    }),
    enableWideMode: () => { flush(); send({ t: 'term', mode: 'wide' }); },
    disableWideMode: () => { flush(); send({ t: 'term', mode: 'fixed' }); },
    isPetsciiMode: () => false,
    isAnsiMode: () => true,
    getModemSpeed: () => 0,
    modemEmulationEnabled: false,
  });
  // The door gates commands on secLevel (80 kick, 100 ban) and treats 255 as sysop; the hub store still checks every write.
  const user = { username: init.user, id: 0, secLevel: init.sysop ? Math.max(init.access, 255) : init.access };
  const bbsSession: { user: typeof user; nodeId: number; tempData: Record<string, unknown>; doorInputHandler?: (d: string) => void } =
    { user, nodeId: init.node ?? 0, tempData: { chatOnly: init.chatOnly } };
  const toDoor = new EventEmitter();
  let ackId = 0;
  const acks = new Map<number, (r: unknown) => void>();
  const socket = {
    id: `pl-${process.pid}`, connected: true,
    on: (ev: string, fn: (...a: unknown[]) => void) => { toDoor.on(ev, fn); return socket; },
    off: (ev: string, fn: (...a: unknown[]) => void) => { toDoor.off(ev, fn); return socket; },
    once: (ev: string, fn: (...a: unknown[]) => void) => { toDoor.once(ev, fn); return socket; },
    emit: (ev: string, data: Record<string, unknown> = {}, cb?: (r: unknown) => void) => {
      if (typeof cb === 'function') { const id = ++ackId; acks.set(id, cb); send({ t: 'emit', ev, data, ack: id }); } else send({ t: 'emit', ev, data });
      return true;
    },
    // The door's BBSEventBus calls socket.send after its local event; socket.io's send is a plain 'message' emit the hub has no use for.
    send: () => socket,
  };

  // Keep the door's blessed screen so render(full) can force a whole repaint.
  let screen: RepaintableScreen | null = null;
  const scr = require(path.join(init.doorDir, 'dist/ui/screen.js')) as ScreenModule; // eslint-disable-line @typescript-eslint/no-require-imports
  const createScreen = scr.createScreen;
  scr.createScreen = (b) => (screen = createScreen(b));

  process.on('message', (m: ToChild) => {
    if (m.t === 'input') bbsSession.doorInputHandler?.(m.s);
    else if (m.t === 'resize') { cols = m.cols; rows = m.rows; bbs.emit('screen:resize', { cols, rows }); }
    else if (m.t === 'event') toDoor.emit(m.ev, m.data);
    else if (m.t === 'ack') { const cb = acks.get(m.id); acks.delete(m.id); cb?.(m.result); }
    // A destroyed screen (door quit; the board's 80-column resize still arrives before X) must not repaint.
    else if (m.t === 'repaint' && screen && !screen.destroyed) { screen.alloc?.(); screen.render(); }
  });

  const mod = require(path.join(init.doorDir, 'dist/server.js')) as DoorModule; // eslint-disable-line @typescript-eslint/no-require-imports
  // The SDK's media classes only emit/listen on the socket, so the door's ctx.audio/ctx.video
  // reach the caller's browser as relayed M frames. Absolute paths: the SDK exports map hides media/.
  // A door without the SDK (test stubs, older doors) runs without ctx.audio/ctx.video.
  let audio: unknown;
  let video: unknown;
  try {
    const sdkDir = path.dirname(require.resolve('@amiexpress/bbs-door-sdk', { paths: [init.doorDir] }));
    const { Audio } = require(path.join(sdkDir, 'media/Audio.js')) as { Audio: new (s: typeof socket, roomId?: string) => unknown }; // eslint-disable-line @typescript-eslint/no-require-imports
    const { Video } = require(path.join(sdkDir, 'media/Video.js')) as { Video: new (s: typeof socket) => unknown }; // eslint-disable-line @typescript-eslint/no-require-imports
    audio = new Audio(socket, (bbsSession as { currentRoomId?: string }).currentRoomId);
    video = new Video(socket);
  } catch (e) {
    process.stderr.write(`[partyline] door SDK media unavailable: ${(e as Error).message}\n`);
  }
  Promise.resolve(mod.createApp({ socket, user, bbsSession, bbs, audio, video, params: [] })).then((app) => app.run())
    // Flush first: the door's last writes (LIVECHAT's clear + goodbye) wait on setImmediate, after this microtask and the disconnect.
    .then(() => { flush(); send({ t: 'end' }); }, (e: Error) => { flush(); send({ t: 'end', error: e.message }); })
    .finally(() => process.disconnect?.());
}

// Forked as the host's warm spare (argv[2] = door dir): load the door now, before any caller,
// so a PL waits only for createApp, not for process boot and the door's module load.
if (process.argv[2]) { require(path.join(process.argv[2], 'dist/ui/screen.js')); require(path.join(process.argv[2], 'dist/server.js')); send({ t: 'ready' }); } // eslint-disable-line @typescript-eslint/no-require-imports
process.once('message', (m: ToChild) => { if (m.t === 'init') start(m); });
process.on('disconnect', () => process.exit(0));
