/**
 * One Partyline caller's LIVECHAT door, in its own process (forked by
 * livechat-host.ts). The door keeps module-level singletons (events bus it
 * clears on exit, settings, theme, emoji mode, prefsSender), so two callers
 * cannot share one module cache. This process holds the door's bbs, bbsSession
 * and socket shims; the parent owns the hub chat store and the PLP connection.
 */
import { EventEmitter } from 'events';
import * as path from 'path';

export interface ChildInit { t: 'init'; doorDir: string; user: string; access: number; sysop: boolean; cols: number; rows: number; utf8: boolean }
export type ToChild =
  | ChildInit
  | { t: 'input'; s: string }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'event'; ev: string; data: Record<string, unknown> }
  | { t: 'repaint' };
export type FromChild =
  | { t: 'out'; s: string }
  | { t: 'emit'; ev: string; data: Record<string, unknown> }
  | { t: 'end'; error?: string }
  /** A spare finished loading the door. */
  | { t: 'ready' };

interface RepaintableScreen { alloc?(): void; render(): void }
interface DoorApp { run(): Promise<void> }
interface DoorModule { createApp(session: unknown): DoorApp | Promise<DoorApp> }
interface ScreenModule { createScreen(bbs: unknown): RepaintableScreen }

const send = (m: FromChild): void => { if (process.connected) process.send?.(m); };

function start(init: ChildInit): void {
  let cols = init.cols;
  let rows = init.rows;
  let out = '';
  const write = (s: string): void => {
    if (!out) setImmediate(() => { const s2 = out; out = ''; send({ t: 'out', s: s2 }); });
    out += s;
  };
  const bbs = Object.assign(new EventEmitter(), {
    connectionType: 'telnet',
    unicodeCapable: init.utf8,
    write,
    writeLine: (s: string) => write(s + '\r\n'),
    getTerminalSize: () => ({ width: cols, height: rows }),
    isPetsciiMode: () => false,
    isAnsiMode: () => true,
    getModemSpeed: () => 0,
    modemEmulationEnabled: false,
  });
  // The door gates commands on secLevel (80 kick, 100 ban) and treats 255 as sysop; the hub store still checks every write.
  const user = { username: init.user, id: 0, secLevel: init.sysop ? Math.max(init.access, 255) : init.access };
  const bbsSession: { user: typeof user; nodeId: number; tempData: Record<string, unknown>; doorInputHandler?: (d: string) => void } =
    { user, nodeId: 0, tempData: {} };
  const toDoor = new EventEmitter();
  const socket = {
    id: `pl-${process.pid}`, connected: true,
    on: (ev: string, fn: (...a: unknown[]) => void) => { toDoor.on(ev, fn); return socket; },
    off: (ev: string, fn: (...a: unknown[]) => void) => { toDoor.off(ev, fn); return socket; },
    once: (ev: string, fn: (...a: unknown[]) => void) => { toDoor.once(ev, fn); return socket; },
    emit: (ev: string, data: Record<string, unknown> = {}) => { send({ t: 'emit', ev, data }); return true; },
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
    else if (m.t === 'repaint' && screen) { screen.alloc?.(); screen.render(); }
  });

  const mod = require(path.join(init.doorDir, 'dist/server.js')) as DoorModule; // eslint-disable-line @typescript-eslint/no-require-imports
  Promise.resolve(mod.createApp({ socket, user, bbsSession, bbs, params: [] })).then((app) => app.run())
    .then(() => send({ t: 'end' }), (e: Error) => send({ t: 'end', error: e.message }))
    .finally(() => process.disconnect?.());
}

// Forked as the host's warm spare (argv[2] = door dir): load the door now, before any caller,
// so a PL waits only for createApp, not for process boot and the door's module load.
if (process.argv[2]) { require(path.join(process.argv[2], 'dist/ui/screen.js')); require(path.join(process.argv[2], 'dist/server.js')); send({ t: 'ready' }); } // eslint-disable-line @typescript-eslint/no-require-imports
process.once('message', (m: ToChild) => { if (m.t === 'init') start(m); });
process.on('disconnect', () => process.exit(0));
