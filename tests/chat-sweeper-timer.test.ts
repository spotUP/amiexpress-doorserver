/**
 * H3: the chat sweeper timer must not keep the process alive, and the stop hook
 * must end it, so jest exits clean without --forceExit.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests, startSweeper } from '../src/chat/sessions';
import { loadChatConfig } from '../src/chat/config';

describe('chat sweeper timer', () => {
  it('is unref-ed and the stop hook clears it', () => {
    const fx = makeAchievementsFixture();
    _stopChatSweepersForTests(); // createApp already started the fixture sweeper
    const timers: NodeJS.Timeout[] = [];
    const real = global.setInterval;
    const spy = jest.spyOn(global, 'setInterval').mockImplementation(((...a: Parameters<typeof setInterval>) => {
      const t = real(...a);
      timers.push(t);
      return t;
    }) as typeof setInterval);
    try {
      startSweeper(fx.ach, loadChatConfig({}));
      expect(timers).toHaveLength(1);
      expect(timers[0].hasRef()).toBe(false);
      startSweeper(fx.ach, loadChatConfig({})); // one timer per database file
      expect(timers).toHaveLength(1);
      _stopChatSweepersForTests();
      startSweeper(fx.ach, loadChatConfig({}));
      expect(timers).toHaveLength(2); // stopped means gone: a new one starts
    } finally {
      spy.mockRestore();
      fx.cleanup();
    }
  });
});
