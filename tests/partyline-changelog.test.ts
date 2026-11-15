/** #updates: the sha range (shell, on a scratch repo) and the post (DB). */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { openAchievementsDb } from '../src/achievements/db';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { postUpdates } from '../src/partyline/changelog';

let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

const git = (repo: string, ...a: string[]): string => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();

describe('#updates changelog', () => {
  it('lists only partyline/chat commits after the stored sha, oldest first', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'plchg-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@example.invalid');
    git(repo, 'config', 'user.name', 't');
    const commit = (file: string, msg: string): void => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), msg);
      git(repo, 'add', file);
      git(repo, 'commit', '-q', '-m', msg);
    };
    commit('src/partyline/a.ts', 'old partyline');
    const from = git(repo, 'rev-parse', 'HEAD');
    commit('src/partyline/b.ts', 'new one');
    commit('src/other/c.ts', 'unrelated');
    commit('src/chat/d.ts', 'new two');
    const to = git(repo, 'rev-parse', 'HEAD');
    const out = execFileSync('bash', ['-c', `. scripts/partyline-changelog.sh; partyline_changelog_subjects "$1" "$2" "$3"`, 'x', repo, from, to], { encoding: 'utf8' });
    expect(out.trim().split('\n')).toEqual(['new one', 'new two']);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('creates #updates when missing and posts one message per subject, once', () => {
    const db = openAchievementsDb(fx.ach);
    try {
      expect(db.prepare("SELECT 1 FROM chat_rooms WHERE name_key = '#updates'").get()).toBeUndefined();
      expect(postUpdates(db, ['new one', 'new two'], 'abc123')).toBe(2);
      expect(postUpdates(db, ['new one', 'new two'], 'abc123')).toBe(0); // same deploy re-run
      expect(postUpdates(db, ['third'], 'def456')).toBe(1); // room reused
      const rooms = db.prepare("SELECT id FROM chat_rooms WHERE name_key = '#updates'").all();
      expect(rooms).toHaveLength(1);
      const msgs = db.prepare('SELECT content FROM chat_messages ORDER BY seq').all() as { content: string }[];
      expect(msgs.map((m) => m.content)).toEqual(['new one', 'new two', 'third']);
    } finally { db.close(); }
  });
});
