/**
 * AC-6 - the SMTP seam, the queue, the backoff drain, the pending count.
 *
 * Mail is built BEFORE the endpoint that needs it because a registration
 * endpoint that cannot send a code is the spec's stated worst case. Nothing
 * here opens a socket: every test injects the fixture's recording mailer,
 * and the fixture's ACHIEVEMENTS_SMTP_URL points at a closed port so a test
 * that forgot would fail loudly instead of hanging.
 *
 * The clock is injected too. A backoff of 60 s / 5 min / 30 min / 2 h / 6 h
 * and a three-day give-up cannot be proven by waiting, and a suite that
 * waited would take three days.
 *
 * ONE test drives the real HTTP surface (pendingMail through
 * GET /achievements/v1/health); the rest drive drainMailQueue directly,
 * which is the same function the server's own timer calls - see the last
 * test, which drives that timer.
 */
import Database from 'better-sqlite3';
import request from 'supertest';
import {
  MAIL_BACKOFF_SECONDS,
  MAIL_DRAIN_BATCH,
  MAIL_GIVE_UP_SECONDS,
  drainMailQueue,
  pendingMailCount,
  queueMail,
  startMailDrain,
} from '../../src/achievements/mail';
import { createApp } from '../../src/app';
import { ConfigError, loadConfig } from '../../src/config';
import { makeAchievementsFixture, recordingMailer } from './helpers';
import type { AchievementsFixture, RecordingMailer } from './helpers';

let fx: AchievementsFixture;
let db: Database.Database;
let mailer: RecordingMailer;

/** A fixed instant, so every expectation below is an arithmetic fact. */
const T0 = 1_760_000_000;

beforeEach(() => {
  fx = makeAchievementsFixture();
  db = fx.openAchievements();
  mailer = recordingMailer();
});

afterEach(() => {
  db.close();
  fx.cleanup();
});

interface QueueRow {
  attempts: number;
  next_at: number;
  sent_at: number | null;
  failed_at: number | null;
  last_error: string | null;
}

const row = (id: number): QueueRow =>
  db
    .prepare('SELECT attempts, next_at, sent_at, failed_at, last_error FROM mail_queue WHERE id = ?')
    .get(id) as QueueRow;

describe('the mail queue', () => {
  it('keeps the code when the SMTP server is refusing connections, and opens no socket to find out', async () => {
    // The half of the spec's worst case that AC-6 can prove on its own: the
    // WRITE succeeds while mail is down. AC-7 proves the other half - that
    // POST /players still answers 202 - once that endpoint exists.
    mailer.refuse(Infinity);
    const id = queueMail(db, 'caller@example.com', 'Your code', 'ABC123\n', T0);

    // Queued, and nothing has been attempted yet: queueMail does not send.
    expect(pendingMailCount(db)).toBe(1);
    expect(mailer.calls).toBe(0);

    const result = await drainMailQueue(db, mailer, T0);

    expect(result).toEqual({ sent: 0, failed: 0 });
    // Still queued, still pending, and the body is untouched - the code is
    // not lost because the mail server was down when it was issued.
    expect(pendingMailCount(db)).toBe(1);
    expect(row(id).sent_at).toBeNull();
    expect(row(id).failed_at).toBeNull();
    expect(row(id).last_error).toContain('ECONNREFUSED');
    expect(db.prepare('SELECT body FROM mail_queue WHERE id = ?').get(id)).toEqual({
      body: 'ABC123\n',
    });
  });

  it('retries a failed mail on the backoff schedule and not on every drain', async () => {
    mailer.refuse(Infinity);
    const id = queueMail(db, 'caller@example.com', 'Your code', 'ABC123\n', T0);

    // Walk the ladder. After the Nth failure the row is due exactly
    // MAIL_BACKOFF_SECONDS[N-1] later, and the last entry repeats for ever.
    const ladder = [...MAIL_BACKOFF_SECONDS, MAIL_BACKOFF_SECONDS[MAIL_BACKOFF_SECONDS.length - 1]];
    let now = T0;
    for (const [i, wait] of ladder.entries()) {
      await drainMailQueue(db, mailer, now);
      expect(mailer.calls).toBe(i + 1);
      expect(row(id).attempts).toBe(i + 1);
      expect(row(id).next_at).toBe(now + wait);

      // ONE SECOND BEFORE it is due, a drain must not touch it. This is the
      // assertion that makes it a schedule rather than a retry-every-tick.
      await drainMailQueue(db, mailer, now + wait - 1);
      expect(mailer.calls).toBe(i + 1);
      expect(row(id).attempts).toBe(i + 1);

      now += wait;
    }

    expect(ladder).toEqual([60, 300, 1800, 7200, 21600, 21600]);

    // And when the mail server comes back, the row that has been waiting all
    // along goes out - a backoff delays a mail, it never discards one.
    mailer.refuse(0);
    await drainMailQueue(db, mailer, now);
    expect(mailer.sent).toEqual([{ to: 'caller@example.com', subject: 'Your code', body: 'ABC123\n' }]);
    expect(row(id).sent_at).toBe(now);
    expect(row(id).last_error).toBeNull();
    expect(pendingMailCount(db)).toBe(0);
  });

  it('gives up on a mail still unsent after three days, logs it, and never retries it again', async () => {
    const logged: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    try {
      mailer.refuse(Infinity);
      const id = queueMail(db, 'gone@example.com', 'Your code', 'ABC123\n', T0);

      // One second short of three days: the row is due, the attempt fails,
      // and it is RETRIED rather than abandoned.
      const justUnder = T0 + MAIL_GIVE_UP_SECONDS - 1;
      await drainMailQueue(db, mailer, justUnder);
      expect(row(id).failed_at).toBeNull();
      expect(row(id).next_at).toBe(justUnder + MAIL_BACKOFF_SECONDS[0]);
      expect(pendingMailCount(db)).toBe(1);

      // The give-up is checked on a FAILED ATTEMPT, never on a row that is
      // merely waiting - a four-day-old row still gets one more try, because
      // the reason it is four days old may be a mail server that came back a
      // minute ago. So the terminal moment is the next time it comes due.
      const past = justUnder + MAIL_BACKOFF_SECONDS[0];
      expect(past - T0).toBeGreaterThan(MAIL_GIVE_UP_SECONDS);
      const result = await drainMailQueue(db, mailer, past);
      expect(result).toEqual({ sent: 0, failed: 1 });
      expect(row(id).failed_at).toBe(past);

      // It stops counting as pending, so a dead address cannot inflate for
      // ever the one number that tells a sysop mail is broken...
      expect(pendingMailCount(db)).toBe(0);
      // ...and it is never selected again, whatever the clock says.
      const callsAtGiveUp = mailer.calls;
      await drainMailQueue(db, mailer, T0 + 10 * MAIL_GIVE_UP_SECONDS);
      expect(mailer.calls).toBe(callsAtGiveUp);

      expect(logged.join('\n')).toContain('[ERROR] mail to gone@example.com given up after');
    } finally {
      spy.mockRestore();
    }
  });

  it("reports the queue depth as the health object's pendingMail, over HTTP", async () => {
    // The one test here that drives the real entry point: the number a
    // monitor and a sysop actually read comes out of the same query the
    // drain uses, not out of a second count that could drift from it.
    const pending = async (): Promise<number> => {
      const res = await request(fx.app).get('/achievements/v1/health');
      expect(res.status).toBe(200);
      return res.body.pendingMail as number;
    };

    expect(await pending()).toBe(0);

    queueMail(db, 'one@example.com', 'Your code', 'AAA111\n', T0);
    const second = queueMail(db, 'two@example.com', 'Your code', 'BBB222\n', T0);
    expect(await pending()).toBe(2);

    // One goes out...
    mailer.refuseAddress('two@example.com');
    await drainMailQueue(db, mailer, T0);
    expect(await pending()).toBe(1);

    // ...and the other is eventually given up on, which also stops counting.
    await drainMailQueue(db, mailer, T0 + MAIL_GIVE_UP_SECONDS);
    expect(row(second).failed_at).not.toBeNull();
    expect(await pending()).toBe(0);
  });

  it('refuses a mail that is not pure ASCII at the queue, not at the SMTP server', async () => {
    // A code is typed off a screen. A template that smuggles in a non-ASCII
    // character must fail in a test run, not arrive as mojibake in an inbox
    // three days later.
    expect(() => queueMail(db, 'caller@example.com', 'Your code', 'ABC\u2013123\n', T0)).toThrow(
      /pure printable ASCII/
    );
    expect(() => queueMail(db, 'caller@example.com', 'C\u00f3digo', 'ABC123\n', T0)).toThrow(
      /pure printable ASCII/
    );
    // Nothing was written, so a rejected template cannot leave a half-row.
    expect(pendingMailCount(db)).toBe(0);

    // The same body in plain ASCII is accepted, so the check is a character
    // rule and not a length or a shape one.
    expect(() => queueMail(db, 'caller@example.com', 'Your code', 'ABC-123\n', T0)).not.toThrow();
    expect(pendingMailCount(db)).toBe(1);
  });

  it('sends at most twenty due mails in one drain, and the rest on the next', async () => {
    for (let i = 0; i < MAIL_DRAIN_BATCH + 5; i += 1) {
      queueMail(db, `caller${i}@example.com`, 'Your code', 'ABC123\n', T0);
    }

    expect(await drainMailQueue(db, mailer, T0)).toEqual({ sent: MAIL_DRAIN_BATCH, failed: 0 });
    expect(pendingMailCount(db)).toBe(5);

    expect(await drainMailQueue(db, mailer, T0)).toEqual({ sent: 5, failed: 0 });
    expect(pendingMailCount(db)).toBe(0);
    expect(mailer.sent).toHaveLength(MAIL_DRAIN_BATCH + 5);
  });

  it('lets one bouncing address hold up nothing but itself', async () => {
    queueMail(db, 'good1@example.com', 'Your code', 'AAA111\n', T0);
    const bad = queueMail(db, 'bounce@example.com', 'Your code', 'BBB222\n', T0);
    queueMail(db, 'good2@example.com', 'Your code', 'CCC333\n', T0);
    mailer.refuseAddress('bounce@example.com');

    expect(await drainMailQueue(db, mailer, T0)).toEqual({ sent: 2, failed: 0 });
    expect(mailer.sent.map((m) => m.to)).toEqual(['good1@example.com', 'good2@example.com']);
    expect(row(bad).attempts).toBe(1);
    expect(row(bad).next_at).toBe(T0 + MAIL_BACKOFF_SECONDS[0]);
  });
});

describe('the drain the server itself starts', () => {
  it('drains on its own tick and never keeps the process alive', async () => {
    // The exact wiring src/index.ts runs, at an interval a test can wait
    // for. Asserting against a copy of the timer body would prove nothing
    // about the timer the server starts.
    queueMail(db, 'caller@example.com', 'Your code', 'ABC123\n');

    const timer = startMailDrain(fx.ach, mailer, 10);
    try {
      // unref: a process holding nothing but this must still exit. Without
      // it, importing index.ts would hang a test run for ever.
      expect(timer.hasRef()).toBe(false);

      const deadline = Date.now() + 5000;
      while (mailer.sent.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(mailer.sent.map((m) => m.to)).toEqual(['caller@example.com']);
    } finally {
      clearInterval(timer);
    }

    // The drain opened its OWN handle, so the row this suite's handle reads
    // is the row the timer wrote.
    expect(pendingMailCount(db)).toBe(0);
  });
});

describe('a surface that cannot send mail', () => {
  it('never starts at all, rather than mounting a half of one (D7)', async () => {
    // The other side of the queue's whole reason for existing: an endpoint
    // that takes an address and cannot mail it is worse than one that is
    // absent, because the caller has already given up their address. The
    // refusal is at startup, in loadConfig, so there is no code path that
    // reaches createApp with a mailless achievements config.
    const base = {
      DOORSERVER_DB: fx.doorsDbPath,
      DOOR_ARCHIVES_ROOT: fx.cfg.archivesRoot,
      ACHIEVEMENTS_DB: fx.achievementsDbPath,
    };

    expect(() => loadConfig(base)).toThrow(ConfigError);
    expect(() => loadConfig(base)).toThrow(/ACHIEVEMENTS_SMTP_URL/);

    // And with mail configured, the SAME environment mounts a live surface -
    // so the refusal above is about the missing variable and not about
    // something else in this environment being wrong.
    const whole = loadConfig({
      ...base,
      ACHIEVEMENTS_SMTP_URL: 'smtp://127.0.0.1:1',
      ACHIEVEMENTS_MAIL_FROM: 'achievements@example.invalid',
    });
    const res = await request(createApp(whole)).get('/achievements/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.pendingMail).toBe(0);
  });
});
