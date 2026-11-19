import fs from 'fs';
import path from 'path';
import type { Config } from 'jest';
import { livechatDoorDir } from './src/partyline/livechat-host';

// The partyline-livechat suites (all but -files) fork the board checkout's LIVECHAT door. CI checks out only this
// repo (amiexpress-web is private), so they run only where the door is built.
const hasLivechatDoor = fs.existsSync(path.join(livechatDoorDir(), 'dist', 'server.js'));

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', ...(hasLivechatDoor ? [] : ['/tests/partyline-livechat(?!-files)[^/]*\\.test\\.ts$'])],
  collectCoverageFrom: ['src/**/*.ts'],
};

export default config;
