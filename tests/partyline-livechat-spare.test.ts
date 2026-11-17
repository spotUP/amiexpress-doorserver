/**
 * PL waited seconds (minutes on a cold file cache) for a fresh child to boot and
 * load the LIVECHAT door. The host now keeps a spare child that loads the door
 * before any caller arrives.
 */
import { forkLivechatChild, livechatDoorDir, warmSpare } from '../src/partyline/livechat-host';
import type { FromChild } from '../src/partyline/livechat-child';

jest.setTimeout(60_000);

test('a spare LIVECHAT child loads the door before any caller arrives', async () => {
  const child = forkLivechatChild(livechatDoorDir(), () => {});
  try {
    const first = await new Promise<FromChild>((resolve, reject) => {
      child.once('message', resolve);
      child.once('exit', (code) => reject(new Error(`child exited ${code}`)));
      // Own deadline below jest's, so finally still kills the child on failure.
      setTimeout(() => reject(new Error('spare never reported ready')), 30_000).unref();
    });
    expect(first).toEqual({ t: 'ready' });
  } finally {
    child.kill();
  }
});

test('a spare forked before a dist rebuild is killed and replaced on handout', () => {
  const mk = (): any => ({ connected: true, exitCode: null, kill: jest.fn() }); // eslint-disable-line @typescript-eslint/no-explicit-any
  const made: ReturnType<typeof mk>[] = [];
  let stamp = 1;
  const take = warmSpare('x', () => { const c = mk(); made.push(c); return c; }, () => stamp);
  stamp = 2; // dist rebuilt after the spare loaded
  const got = take();
  expect(made[0].kill).toHaveBeenCalled();
  expect(got).toBe(made[1]);
  expect(take()).toBe(made[2]); // spare started after the rebuild is current: handed out as is
  expect(made[2].kill).not.toHaveBeenCalled();
});
