import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // The hosted LIVECHAT door pulls the SDK, whose audio engine imports ESM-only tone.
  moduleNameMapper: { '^tone$': '<rootDir>/tests/stubs/tone.js' },
  collectCoverageFrom: ['src/**/*.ts'],
};

export default config;
