/**
 * PL waited seconds (minutes on a cold file cache) for a fresh child to boot and
 * load the LIVECHAT door. The host now keeps a spare child that loads the door
 * before any caller arrives.
 */
import { forkLivechatChild, livechatDoorDir } from '../src/partyline/livechat-host';
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
