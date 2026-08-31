import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';
import { createJob, runJobSequentially, getJob, setJobResult } from '../src/batch-jobs';
import type { ServerConfig } from '../src/config';

describe('batch-jobs', () => {
  let cfg: ServerConfig;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'batch-jobs-')), 'test.db');
    cfg = { dbPath, archivesRoot: '', port: 0, adminKeys: [], jwtSecret: 'x'.repeat(64), learnKey: null };
    const db = openDb(cfg);
    applySchema(db);
    runMigrations(db);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('creates a job with pending items for every archive name', () => {
    const jobId = createJob(cfg, 'reextract', ['A.LHA', 'B.LHA'], null);
    const job = getJob(cfg, jobId);
    expect(job).toMatchObject({ kind: 'reextract', status: 'running', total: 2, completed: 0, failedCount: 0 });
    expect(job!.items).toEqual([
      { archiveName: 'A.LHA', status: 'pending', error: null },
      { archiveName: 'B.LHA', status: 'pending', error: null },
    ]);
  });

  it('processes items sequentially, marking ok/error and finishing as done', async () => {
    const jobId = createJob(cfg, 'reextract', ['A.LHA', 'B.LHA'], null);
    await runJobSequentially(cfg, jobId, ['A.LHA', 'B.LHA'], (name) =>
      name === 'B.LHA' ? { error: 'boom' } : { ok: true }
    );
    const job = getJob(cfg, jobId);
    expect(job).toMatchObject({ status: 'done', completed: 2, failedCount: 1 });
    expect(job!.items).toEqual([
      { archiveName: 'A.LHA', status: 'ok', error: null },
      { archiveName: 'B.LHA', status: 'error', error: 'boom' },
    ]);
  });

  it('stores an arbitrary result payload for a job', () => {
    const jobId = createJob(cfg, 'strip-preview', ['A.LHA'], null);
    setJobResult(cfg, jobId, JSON.stringify({ hello: 'world' }));
    expect(getJob(cfg, jobId)!.resultJson).toBe(JSON.stringify({ hello: 'world' }));
  });

  it('returns null for an unknown job id', () => {
    expect(getJob(cfg, 'does-not-exist')).toBeNull();
  });
});
