import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dbModule from '../src/db';
import { openDb, applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';
import { createJob, runJobSequentially, getJob, setJobResult, markJobFailed } from '../src/batch-jobs';
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

  it('never runs two items concurrently, and calls processOne in archiveName order', async () => {
    const archiveNames = ['A.LHA', 'B.LHA', 'C.LHA'];
    const jobId = createJob(cfg, 'reextract', archiveNames, null);
    const callOrder: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    await runJobSequentially(cfg, jobId, archiveNames, async (name) => {
      callOrder.push(name);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // A real window in which a concurrent implementation (Promise.all /
      // .map(async ...)) would show more than one item in flight at once.
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true };
    });

    expect(callOrder).toEqual(archiveNames);
    expect(maxInFlight).toBe(1);
  });

  it('stores an arbitrary result payload for a job', () => {
    const jobId = createJob(cfg, 'strip-preview', ['A.LHA'], null);
    setJobResult(cfg, jobId, JSON.stringify({ hello: 'world' }));
    expect(getJob(cfg, jobId)!.resultJson).toBe(JSON.stringify({ hello: 'world' }));
  });

  it('returns null for an unknown job id', () => {
    expect(getJob(cfg, 'does-not-exist')).toBeNull();
  });

  // ─── Finding 1: a throw inside the DB-write block must never wedge the
  // job at 'running' forever or become an unhandled promise rejection. ───

  it('a processOne throw is treated as an errored item, not an escaped exception', async () => {
    const archiveNames = ['A.LHA', 'B.LHA'];
    const jobId = createJob(cfg, 'reextract', archiveNames, null);
    // This must resolve, not reject - the caller (a route handler) never
    // awaits this promise, so a rejection here would be an unhandled
    // rejection with no handler anywhere, which crashes the process.
    await expect(
      runJobSequentially(cfg, jobId, archiveNames, (name) => {
        if (name === 'B.LHA') throw new Error('kaboom');
        return { ok: true };
      })
    ).resolves.toBeUndefined();
    const job = getJob(cfg, jobId);
    expect(job).toMatchObject({ status: 'done', completed: 2, failedCount: 1 });
    expect(job!.items.find((i) => i.archiveName === 'B.LHA')).toMatchObject({ status: 'error', error: 'kaboom' });
  });

  it('a per-item DB write failure is retried, marks the item errored, and the job still reaches done', async () => {
    const archiveNames = ['A.LHA', 'B.LHA'];
    const jobId = createJob(cfg, 'reextract', archiveNames, null);
    const realOpenDb = dbModule.openDb;
    let callCount = 0;
    const spy = jest.spyOn(dbModule, 'openDb').mockImplementation((...args: Parameters<typeof dbModule.openDb>) => {
      callCount++;
      // The first openDb call in the loop is the write block for item A's
      // successful outcome - simulate a transient failure there (e.g.
      // SQLITE_BUSY) while every other call (the retry, item B, and the
      // final 'done' write) goes through to the real implementation.
      if (callCount === 1) {
        throw new Error('simulated SQLITE_BUSY');
      }
      return realOpenDb(...args);
    });
    try {
      await expect(
        runJobSequentially(cfg, jobId, archiveNames, () => ({ ok: true }))
      ).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const job = getJob(cfg, jobId);
    // The job reached a terminal state rather than staying 'running' forever,
    // and the process did not crash getting there.
    expect(job!.status).toBe('done');
    expect(job!.completed).toBe(2);
    expect(job!.failedCount).toBe(1);
    const itemA = job!.items.find((i) => i.archiveName === 'A.LHA');
    expect(itemA!.status).toBe('error');
    expect(itemA!.error).toContain('db write failed');
  });

  it('markJobFailed marks the job failed and is safe to call even for an unknown job id', () => {
    const jobId = createJob(cfg, 'reextract', ['A.LHA'], null);
    markJobFailed(cfg, jobId, 0, 1, 0);
    expect(getJob(cfg, jobId)!.status).toBe('failed');
    // Must not throw even when there is nothing to update.
    expect(() => markJobFailed(cfg, 'does-not-exist', 0, 1, 0)).not.toThrow();
  });

  it('onBeforeComplete runs after every item but before the job is marked done, guaranteeing write-then-broadcast ordering', async () => {
    const archiveNames = ['A.LHA'];
    const jobId = createJob(cfg, 'reextract', archiveNames, null);
    let statusWhenCalled: string | undefined;
    await runJobSequentially(cfg, jobId, archiveNames, () => ({ ok: true }), () => {
      statusWhenCalled = getJob(cfg, jobId)!.status;
      setJobResult(cfg, jobId, JSON.stringify({ ok: true }));
    });
    expect(statusWhenCalled).toBe('running');
    const job = getJob(cfg, jobId);
    expect(job!.status).toBe('done');
    expect(job!.resultJson).toBe(JSON.stringify({ ok: true }));
  });
});
