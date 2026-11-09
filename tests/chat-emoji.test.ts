/** Custom emoji: the LiveChat door's {display, ascii} shape, sysop only, listed by GET /emoji. */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';

let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

async function login(handle: string, sysop: boolean): Promise<string> {
  return (await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle, sysop })).body.sid as string;
}
const call = (method: 'get' | 'put' | 'delete', path: string, sid: string) =>
  request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);

describe('custom emoji', () => {
  it('stores {display, ascii} from a sysop, lists it, refuses a plain user and bad input', async () => {
    const sys = await login('sysop', true);
    const usr = await login('bob', false);
    expect((await call('put', '/emoji/party', usr).send({ display: 'P', ascii: ':P' })).status).toBe(403);
    expect((await call('put', '/emoji/party', sys).send({ display: 'P|', ascii: ':P' })).status).toBe(400);
    expect((await call('put', '/emoji/party', sys).send({ display: 'P' })).status).toBe(400);
    const ok = await call('put', '/emoji/party', sys).send({ display: 'PARTY', ascii: '\\o/' });
    expect(ok.status).toBeLessThan(300);
    const list = (await call('get', '/emoji', usr)).body as { name: string; display: string; ascii: string; dataUrl: string }[];
    expect(list).toEqual([expect.objectContaining({ name: 'party', display: 'PARTY', ascii: '\\o/', dataUrl: '' })]);
    expect((await call('delete', '/emoji/party', sys)).status).toBeLessThan(300);
    expect((await call('get', '/emoji', usr)).body).toEqual([]);
  });

  it('still accepts the image dataUrl shape', async () => {
    const sys = await login('sysop', true);
    const url = 'data:image/png;base64,AAAA';
    expect((await call('put', '/emoji/pic', sys).send({ dataUrl: url })).status).toBeLessThan(300);
    expect((await call('get', '/emoji', sys)).body).toEqual([expect.objectContaining({ name: 'pic', dataUrl: url, display: '', ascii: '' })]);
  });
});
