/**
 * Mail: the SMTP seam, the queue, the drain, the pending count.
 *
 * Built BEFORE the endpoint that needs it, deliberately. A registration
 * endpoint that takes a caller's address and cannot send them a code is the
 * spec's stated worst case: the player has already given up their email and
 * has nothing to show for it. So the queue exists, and is proven, before
 * anything can register.
 *
 * Three rules shape everything here:
 *
 * - **Queue, never send inline.** An HTTP response must not wait on an SMTP
 *   handshake, and a registration must survive the mail server being down.
 *   queueMail() writes one row and returns; nothing on a request path ever
 *   opens a socket.
 * - **The seam is an interface, not a mock.** `Mailer` has one method. The
 *   real one is nodemailer over ACHIEVEMENTS_SMTP_URL; a test injects a
 *   recording one, so no suite in this repo ever opens an SMTP connection
 *   and no suite waits thirty seconds for a timer.
 * - **A dead address stops costing.** Backoff, then give up after three
 *   days - shorter than SP2's fourteen-day outbox rule because a
 *   verification code has expired long before then anyway, so retrying it
 *   on day ten delivers a code that cannot be used.
 *
 * nodemailer is pure JavaScript with zero dependencies of its own. That is
 * the property that matters here and it is not incidental: the Dockerfile
 * compiles better-sqlite3 from source against musl, and src/auth.ts records
 * why a SECOND compiled dependency is not wanted. A mailer that needed
 * node-gyp would be a second way for the live container to fail at require
 * time.
 */
import type Database from 'better-sqlite3';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { AchievementsConfig } from './config';
import { openAchievementsDb } from './db';

/**
 * One method, and it is allowed to throw: a failure is the drain's business,
 * never the caller's. Nothing that queues mail ever holds one of these.
 */
export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}

/**
 * Seconds to wait after the 1st, 2nd, 3rd... failed attempt. The last entry
 * repeats, so a permanently dead SMTP server costs four attempts a day
 * rather than one every thirty seconds.
 */
export const MAIL_BACKOFF_SECONDS: readonly number[] = [60, 5 * 60, 30 * 60, 2 * 60 * 60, 6 * 60 * 60];

/** A row still unsent this long after it was queued is given up on. */
export const MAIL_GIVE_UP_SECONDS = 3 * 24 * 60 * 60;

/**
 * How many due rows one drain sends. A bounded batch is what keeps a
 * backlog from turning one tick into a minutes-long SMTP session that
 * overlaps the next.
 */
export const MAIL_DRAIN_BATCH = 20;

/** How often the server drains, in milliseconds. */
export const MAIL_DRAIN_INTERVAL_MS = 30_000;

/**
 * Printable ASCII plus newline and tab. A mail from this service is plain
 * text and nothing else: the body carries a code that has to be typed off a
 * screen, and the further it travels from a fixed 7-bit set - through a
 * webmail client, a phone, a 68K terminal - the more ways a character has to
 * come out looking like a different character.
 */
const ASCII_ONLY = /^[\x20-\x7e\n\t]*$/;

interface MailRow {
  id: number;
  to_addr: string;
  subject: string;
  body: string;
  created_at: number;
  attempts: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The real mailer. The transport is built on the FIRST send, never at
 * construction: createApp() hands one of these to the surface on every
 * server and in every test fixture, and a server that never sends a mail
 * must never have built a transport to not use.
 */
export function smtpMailer(ach: AchievementsConfig): Mailer {
  let transport: Transporter | null = null;
  return {
    async send(to: string, subject: string, body: string): Promise<void> {
      if (!transport) {
        transport = nodemailer.createTransport(ach.smtpUrl);
      }
      await transport.sendMail({ from: ach.mailFrom, to, subject, text: body });
    },
  };
}

/**
 * Write one row and return. Due immediately - the drain decides when, and
 * a first attempt that fails is what starts the backoff ladder.
 *
 * The ASCII check is here, at the single write point, rather than at each
 * call site that composes a mail: a non-ASCII body is a bug in a template,
 * and a bug in a template should be a loud refusal in a test run, not a
 * mojibake code in a caller's inbox three days later.
 */
export function queueMail(
  db: Database.Database,
  to: string,
  subject: string,
  body: string,
  now: number = nowSeconds()
): number {
  if (!ASCII_ONLY.test(subject) || !ASCII_ONLY.test(body)) {
    throw new Error('a queued mail must be pure printable ASCII; this one is not');
  }
  const info = db
    .prepare(
      'INSERT INTO mail_queue (to_addr, subject, body, created_at, next_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(to, subject, body, now, now);
  return Number(info.lastInsertRowid);
}

/** Queued, not yet sent, not yet given up on. The number GET /health reports. */
export function pendingMailCount(db: Database.Database): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM mail_queue WHERE sent_at IS NULL AND failed_at IS NULL')
    .get() as { n: number };
  return row.n;
}

/**
 * Send up to MAIL_DRAIN_BATCH due rows.
 *
 * Each row is its own try/catch: one address that bounces must not stop the
 * nineteen behind it, which is the same reasoning D3 applies to a batch of
 * events. A failure records its message, bumps the attempt count and pushes
 * next_at up the ladder; a row older than MAIL_GIVE_UP_SECONDS is marked
 * failed instead and logged, and is never selected again.
 *
 * The give-up is checked ON a failure, not before the attempt: a four-day-old
 * row still gets one more try, because the reason it is four days old may be
 * a mail server that came back a minute ago.
 */
export async function drainMailQueue(
  db: Database.Database,
  mailer: Mailer,
  now: number
): Promise<{ sent: number; failed: number }> {
  const due = db
    .prepare(
      `SELECT id, to_addr, subject, body, created_at, attempts
         FROM mail_queue
        WHERE sent_at IS NULL AND failed_at IS NULL AND next_at <= ?
        ORDER BY next_at, id
        LIMIT ?`
    )
    .all(now, MAIL_DRAIN_BATCH) as MailRow[];

  let sent = 0;
  let failed = 0;
  for (const row of due) {
    try {
      await mailer.send(row.to_addr, row.subject, row.body);
      db.prepare('UPDATE mail_queue SET sent_at = ?, last_error = NULL WHERE id = ?').run(now, row.id);
      sent += 1;
    } catch (err) {
      const message = (err as Error).message;
      const attempts = row.attempts + 1;
      if (now - row.created_at >= MAIL_GIVE_UP_SECONDS) {
        db.prepare(
          'UPDATE mail_queue SET attempts = ?, failed_at = ?, last_error = ? WHERE id = ?'
        ).run(attempts, now, message, row.id);
        console.error(
          `[ERROR] mail to ${row.to_addr} given up after ${attempts} attempts: ${message}`
        );
        failed += 1;
      } else {
        const wait = MAIL_BACKOFF_SECONDS[Math.min(attempts - 1, MAIL_BACKOFF_SECONDS.length - 1)];
        db.prepare(
          'UPDATE mail_queue SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?'
        ).run(attempts, now + wait, message, row.id);
      }
    }
  }
  return { sent, failed };
}

/**
 * One drain against its own database handle.
 *
 * withAchievementsDb() cannot be used here: it is synchronous and would
 * close the handle while drainMailQueue's first await was still pending.
 */
export async function drainMailQueueOnce(
  ach: AchievementsConfig,
  mailer: Mailer,
  now: number = nowSeconds()
): Promise<{ sent: number; failed: number }> {
  const db = openAchievementsDb(ach);
  try {
    return await drainMailQueue(db, mailer, now);
  } finally {
    db.close();
  }
}

/**
 * The ONLY timer this server starts (D12 forbids a scheduler; this is not
 * one - it drains a queue and computes nothing).
 *
 * It lives here rather than inline in index.ts so a test can drive the exact
 * wiring the server runs, at its own interval, with a recording mailer,
 * instead of asserting against a copy of it.
 *
 * unref(): a process holding nothing but this timer must still exit. A test
 * that imports index.ts, and a container asked to stop, both depend on it.
 *
 * Re-entrancy is guarded rather than assumed. Twenty sends against a slow
 * SMTP server can outlast a thirty-second interval, and two drains at once
 * would send the same rows twice - both would have selected them before
 * either marked one sent.
 */
export function startMailDrain(
  ach: AchievementsConfig,
  mailer: Mailer,
  intervalMs: number = MAIL_DRAIN_INTERVAL_MS
): NodeJS.Timeout {
  let draining = false;
  const timer = setInterval(() => {
    if (draining) return;
    draining = true;
    drainMailQueueOnce(ach, mailer)
      .then(({ sent, failed }) => {
        if (sent || failed) console.log(`[INFO] mail drain sent ${sent} failed ${failed}`);
      })
      .catch((err: unknown) => console.error(`[ERROR] mail drain: ${(err as Error).message}`))
      .finally(() => {
        draining = false;
      });
  }, intervalMs);
  timer.unref();
  return timer;
}

/**
 * The verification mail.
 *
 * Plain text, pure ASCII, and the code alone on its own line: it is read off
 * a screen and typed on an Amiga keyboard, and every character of decoration
 * around it is a character somebody can mistake for part of it. queueMail()
 * enforces the ASCII half at the write point, so a template that ever grew a
 * typographic dash fails in a test run rather than in an inbox.
 *
 * The board's name is deliberately absent. The mail comes from the
 * achievement service, which is one thing for every board; naming the board
 * a caller happened to be dialled into would suggest they have to go back to
 * that one.
 *
 * The TTL is a parameter rather than a constant of this module: the number
 * of minutes is owned by whoever issues the code (players.ts), and a second
 * copy here is a second thing to forget to change.
 */
export function verificationMail(
  ach: AchievementsConfig,
  code: string,
  ttlSeconds: number
): { subject: string; body: string } {
  const minutes = Math.round(ttlSeconds / 60);
  return {
    subject: 'Your AmiExpress achievements code',
    body: [
      'Someone asked to link this address to an AmiExpress achievements',
      'account. The code is:',
      '',
      code,
      '',
      'Type it into the achievements door on the BBS you are calling. It is',
      `good for ${minutes} minutes and can be used once.`,
      '',
      'If this was not you, ignore this mail. Nothing is linked to this',
      'address, and nothing can be, until that code is typed in.',
      '',
      '--',
      'AmiExpress achievements',
      ach.publicBaseUrl,
      '',
    ].join('\n'),
  };
}
