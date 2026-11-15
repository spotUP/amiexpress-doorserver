#!/usr/bin/env npx tsx

/**
 * Post commit subjects (stdin, one per line) to Partyline room #updates.
 * Run inside the container by scripts/partyline-changelog.sh:
 *   node dist/scripts/partyline-changelog.js <to-sha> < subjects.txt
 * With ACHIEVEMENTS_DB unset the chat surface is off: nothing to post to.
 */
import * as fs from 'fs';
import { withAchievementsDb } from '../src/achievements/db';
import { postUpdates } from '../src/partyline/changelog';

const to = process.argv[2] ?? '';
const dbPath = process.env.ACHIEVEMENTS_DB ?? '';
if (!to) {
  console.error('[ERROR] usage: partyline-changelog.js <to-sha> < subjects');
  process.exit(2);
}
if (!dbPath) {
  console.log('[INFO] ACHIEVEMENTS_DB not set; chat is off, nothing posted to #updates');
  process.exit(0);
}
const subjects = fs.readFileSync(0, 'utf8').split('\n');
const n = withAchievementsDb({ dbPath, smtpUrl: '', mailFrom: '', publicBaseUrl: '' }, (db) => postUpdates(db, subjects, to));
console.log(`[OK] posted ${n} line(s) to #updates`);
