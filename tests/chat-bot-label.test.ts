/**
 * A session the board opens with `bot: true` is shown as "[BOT] <handle>" in every
 * label column clients print (members, who, history, events), and its handle is
 * reserved: a plain session for the same handle, any case, is refused.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { displayLabels } from '../src/chat/render';

let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

const open = (body: object) => request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send(body);
function api(method: 'get' | 'post', path: string, sid: string) {
  return request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);
}
const rowsOf = (text: string): string[][] => text.split('\r\n').filter((l) => l !== '').slice(1).map((l) => l.split('|'));

describe('board bot label', () => {
  it('labels the bot [BOT] Uptown everywhere and reserves its handle', async () => {
    const bot = (await open({ handle: 'Uptown', bot: true })).body.sid as string;
    const alice = (await open({ handle: 'alice' })).body.sid as string;
    const id = (await api('post', '/rooms', alice).send({ name: 'lobby' })).body.id as string;
    await api('post', `/rooms/${id}/join`, alice);
    await api('post', `/rooms/${id}/join`, bot);
    expect((await api('post', `/rooms/${id}/messages`, bot).send({ content: 'hello', clientId: 'c1' })).status).toBeLessThan(300);

    const mem = rowsOf((await api('get', `/rooms/${id}/members.txt`, alice)).text);
    expect(mem.find((r) => r[0] === 'Uptown')![7]).toBe('[BOT] Uptown');
    expect(mem.find((r) => r[0] === 'alice@UPROUGH')![7]).toBe('alice');
    const who = rowsOf((await api('get', '/who.txt', alice)).text).find((r) => r[0] === 'Uptown')!;
    expect(who[who.length - 1]).toBe('[BOT] Uptown');
    const hist = rowsOf((await api('get', `/rooms/${id}/history.txt`, alice)).text).find((r) => r[2] === 'Uptown')!;
    expect(hist[hist.length - 1]).toBe('[BOT] Uptown');
    const ev = rowsOf((await api('get', '/events.txt?since=0&wait=0', alice)).text)
      .find((r) => r[1] === 'message' && r[3] === 'Uptown')!;
    expect(ev[9]).toBe('[BOT] Uptown');

    for (const handle of ['Uptown', 'uptown']) {
      const r = await open({ handle });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('conflict');
    }
    expect((await open({ handle: 'Uptown', bot: true })).status).toBe(201);
  });

  it('keeps the clash form behind the prefix', () => {
    const l = displayLabels(['Uptown@UPROUGH', 'uptown@OTHER'], new Set(['Uptown@UPROUGH']));
    expect(l.get('Uptown@UPROUGH')).toBe('[BOT] Uptown@UPROUGH');
    expect(l.get('uptown@OTHER')).toBe('uptown@OTHER');
  });
});
