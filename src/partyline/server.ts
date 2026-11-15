/**
 * The PLP/1 listener: one TCP port, TLS and plain on it alike.
 *
 * A TLS ClientHello starts with byte 0x16; a PLP HELLO starts with 'H'. The
 * first byte picks the path, so a board without TLS (68K, D14) and one with it
 * (D13) dial the same port. On by default; PARTYLINE_ENABLED=0 turns it off.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as tls from 'tls';
import type { Duplex } from 'stream';
import { PLP_LIMITS } from '../../contract/partyline-types';
import { withAchievementsDb } from '../achievements/db';
import type { AchievementsConfig } from '../achievements/config';
import { loadChatConfig, nowSec } from '../chat/config';
import type { ChatConfig } from '../chat/config';
import { PartylineSession } from './session';
import { chatScreen } from './ui/screen';
import { livechatScreen } from './livechat-host';
import type { ScreenFactory } from './session';

export interface PartylineConfig {
  enabled: boolean;
  port: number;
  host: string;
  /** PEM paths; without both, TLS callers are dropped and only plain works. */
  tlsCert: string | null;
  tlsKey: string | null;
}

export function loadPartylineConfig(env: NodeJS.ProcessEnv = process.env): PartylineConfig {
  const port = Number(env.PARTYLINE_PORT);
  return {
    // On by default: Partyline is the reason the board runs the chat door here.
    enabled: env.PARTYLINE_ENABLED !== '0',
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : PLP_LIMITS.defaultPort,
    host: env.PARTYLINE_HOST || '0.0.0.0',
    tlsCert: env.PARTYLINE_TLS_CERT || null,
    tlsKey: env.PARTYLINE_TLS_KEY || null,
  };
}

/** Live chat sessions are touched this often, well inside the 90 s session TTL. */
const KEEPALIVE_MS = 30_000;

export interface PartylineServer {
  server: net.Server;
  sessions: Set<PartylineSession>;
  listen(): Promise<number>;
  /** Stop accepting, tell every caller, close; chat sessions stay for resume. */
  drain(): Promise<void>;
}

export interface PartylineOptions {
  /** The hub's chat file directory (cfg.chatFilesDir); null or absent: file sharing is off. */
  filesDir?: string | null;
  screen?: ScreenFactory;
  chat?: ChatConfig;
  log?: (line: string) => void;
  /** Tests hand in PEM text instead of paths. */
  tlsContext?: tls.SecureContextOptions;
}

export function createPartylineServer(cfg: PartylineConfig, ach: AchievementsConfig, opts: PartylineOptions = {}): PartylineServer {
  const chat = opts.chat ?? loadChatConfig();
  const log = opts.log ?? ((line: string) => console.log(line));
  // PARTYLINE_ENGINE=livechat hosts the board's LIVECHAT door per caller; the default is the hub's own chat screen.
  const screen = opts.screen ?? (process.env.PARTYLINE_ENGINE === 'livechat' ? livechatScreen(ach, chat, undefined, log, opts.filesDir ?? null) : chatScreen(ach, chat, opts.filesDir ?? null));
  const sessions = new Set<PartylineSession>();
  let draining = false;
  // Stale sessions are swept by the /chat/v1 router's sweeper (createApp mounts it whenever achievements is on).

  const tlsOpts = opts.tlsContext
    ?? (cfg.tlsCert && cfg.tlsKey ? { cert: fs.readFileSync(cfg.tlsCert), key: fs.readFileSync(cfg.tlsKey) } : null);
  const secureContext = tlsOpts ? tls.createSecureContext(tlsOpts) : null;

  const attach = (sock: Duplex, isTls: boolean): void => {
    const s = new PartylineSession(sock, {
      ach, chat, screen, tls: isTls,
      isDraining: () => draining,
      onClose: (gone) => sessions.delete(gone),
      log,
    });
    sessions.add(s);
  };

  const server = net.createServer((raw) => {
    raw.on('error', () => raw.destroy());
    raw.once('data', (first: Buffer) => {
      raw.pause();
      raw.unshift(first);
      if (first[0] !== 0x16) {
        attach(raw, false);
        raw.resume();
        return;
      }
      if (!secureContext) {
        log('[WARN] partyline TLS caller dropped: PARTYLINE_TLS_CERT/KEY not set');
        raw.destroy();
        return;
      }
      const sock = new tls.TLSSocket(raw, { isServer: true, secureContext });
      sock.on('error', () => sock.destroy());
      // No raw.resume(): TLSSocket takes the unshifted bytes and the handle; resuming raw starves it (handshake hangs).
      attach(sock, true);
    });
  });

  const keepalive = setInterval(() => {
    const sids = [...sessions].filter((s) => s.live && s.sid).map((s) => s.sid as string);
    if (sids.length === 0) return;
    try {
      withAchievementsDb(ach, (db) => {
        const touch = db.prepare('UPDATE chat_sessions SET last_seen = ? WHERE sid = ?');
        const now = nowSec();
        db.transaction(() => { for (const sid of sids) touch.run(now, sid); })();
      });
    } catch (err) {
      log(`[ERROR] partyline keepalive: ${(err as Error).message}`);
    }
  }, KEEPALIVE_MS);
  keepalive.unref();
  server.on('close', () => clearInterval(keepalive));

  return {
    server,
    sessions,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, () => {
        const addr = server.address() as net.AddressInfo;
        log(`[OK] partyline listening on ${addr.port} (${secureContext ? 'tls+plain' : 'plain only'})`);
        resolve(addr.port);
      });
    }),
    drain: () => new Promise((resolve) => {
      draining = true;
      for (const s of [...sessions]) s.drain();
      server.close(() => resolve());
    }),
  };
}
