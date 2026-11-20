/**
 * Typing previews are throttled hub-side: one preview per keystroke fans a
 * repaint out to every room member, so repeats inside the window are dropped
 * while start and stop always go through at once.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { TYPING_PREVIEW_MIN_MS } from '../src/chat/store';

jest.setTimeout(30000);
let fx: AchievementsFixture;
beforeEach(() => {
  fx = makeAchievementsFixture();
});
afterEach(() => {
  _stopChatSweepersForTests();
  fx.cleanup();
});

type S = { sid: string; auth: string };
async function login(auth: string, handle: string, sysop = false): Promise<S> {
  const r = await request(fx.app).post('/chat/v1/sessions').set('Authorization', auth).send({ handle, sysop });
  expect(r.status).toBe(201);
  return { sid: r.body.sid as string, auth };
}
const call = (s: S, method: 'get' | 'post', path: string) =>
  request(fx.app)[method](`/chat/v1${path}`).set('Authorization', s.auth).set('X-Chat-Session', s.sid);

function typingText(user: string): string | null {
  return withAchievementsDb(fx.ach, (db) => {
    const r = db.prepare("SELECT text FROM chat_events WHERE type = 'typing' AND user = ?").get(user) as { text: string } | undefined;
    return r ? r.text : null;
  });
}

describe('typing throttle', () => {
  it('emits start, drops repeats inside the window, always emits stop', async () => {
    const sys = await login(fx.auth, 'sys', true);
    const made = await call(sys, 'post', '/rooms').send({ name: 'lobby' });
    expect(made.status).toBe(201);
    const room = made.body.id as string;
    const alice = await login(fx.auth, 'alice');
    expect((await call(alice, 'post', `/rooms/${room}/join`)).status).toBe(200);

    expect((await call(alice, 'post', `/rooms/${room}/typing`).send({ text: 'h' })).status).toBe(200);
    expect(typingText('alice@UPROUGH')).toBe('h');
    expect((await call(alice, 'post', `/rooms/${room}/typing`).send({ text: 'he' })).status).toBe(200);
    expect(typingText('alice@UPROUGH')).toBe('h');
    expect((await call(alice, 'post', `/rooms/${room}/typing`).send({ text: '' })).status).toBe(200);
    expect(typingText('alice@UPROUGH')).toBe('');
  });

  it('emits again after the window', async () => {
    const sys = await login(fx.auth, 'sys', true);
    const made = await call(sys, 'post', '/rooms').send({ name: 'lobby' });
    expect(made.status).toBe(201);
    const room = made.body.id as string;
    const alice = await login(fx.auth, 'alice');
    expect((await call(alice, 'post', `/rooms/${room}/join`)).status).toBe(200);

    expect((await call(alice, 'post', `/rooms/${room}/typing`).send({ text: 'a' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, TYPING_PREVIEW_MIN_MS + 200));
    expect((await call(alice, 'post', `/rooms/${room}/typing`).send({ text: 'ab' })).status).toBe(200);
    expect(typingText('alice@UPROUGH')).toBe('ab');
  }, 15000);
});
