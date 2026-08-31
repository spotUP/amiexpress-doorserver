/**
 * Tracked background jobs for bulk operations too slow to run inside one
 * HTTP request (reextract, strip preview/apply - both shell out to
 * lha/unlzx per archive). State lives in batch_jobs/batch_job_items so a
 * page refresh can reconnect to a job already in progress; progress is
 * pushed live over the existing revision SSE connection as a new event
 * type (broadcastJobEvent in src/public-routes.ts), not a separate stream.
 */
import { randomUUID } from 'crypto';
import { openDb } from './db';
import { broadcastJobEvent } from './public-routes';
import type { ServerConfig } from './config';

export type JobKind = 'reextract' | 'strip-preview' | 'strip-apply';
export type ItemOutcome = { ok: true } | { error: string };

export interface JobItem {
  archiveName: string;
  status: 'pending' | 'ok' | 'error';
  error: string | null;
}

export interface Job {
  id: string;
  kind: JobKind;
  status: 'running' | 'done' | 'failed';
  total: number;
  completed: number;
  failedCount: number;
  resultJson: string | null;
  items: JobItem[];
}

export function createJob(cfg: ServerConfig, kind: JobKind, archiveNames: string[], createdBy: number | null): string {
  const id = randomUUID();
  const db = openDb(cfg);
  try {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO batch_jobs (id, kind, status, total, completed, failed_count, created_by, created_at, updated_at)
       VALUES (?, ?, 'running', ?, 0, 0, ?, ?, ?)`
    ).run(id, kind, archiveNames.length, createdBy, now, now);
    const ins = db.prepare(
      `INSERT INTO batch_job_items (job_id, archive_name, status) VALUES (?, ?, 'pending')`
    );
    const tx = db.transaction(() => {
      for (const name of archiveNames) ins.run(id, name);
    });
    tx();
    return id;
  } finally {
    db.close();
  }
}

export function getJob(cfg: ServerConfig, jobId: string): Job | null {
  const db = openDb(cfg, { readonly: true });
  try {
    const row = db.prepare('SELECT * FROM batch_jobs WHERE id = ?').get(jobId) as
      | { id: string; kind: JobKind; status: Job['status']; total: number; completed: number; failed_count: number; result_json: string | null }
      | undefined;
    if (!row) return null;
    const items = db
      .prepare('SELECT archive_name AS archiveName, status, error FROM batch_job_items WHERE job_id = ? ORDER BY rowid')
      .all(jobId) as JobItem[];
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      total: row.total,
      completed: row.completed,
      failedCount: row.failed_count,
      resultJson: row.result_json,
      items,
    };
  } finally {
    db.close();
  }
}

export function setJobResult(cfg: ServerConfig, jobId: string, resultJson: string): void {
  const db = openDb(cfg);
  try {
    db.prepare('UPDATE batch_jobs SET result_json = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?').run(resultJson, jobId);
  } finally {
    db.close();
  }
}

/**
 * Marks a job 'failed' and broadcasts a terminal event, best-effort. This is
 * the last resort so a job never sits at 'running' forever: it is called by
 * runJobSequentially's own top-level catch when something escapes every
 * inner guard, and by the route handlers below as defense-in-depth for
 * anything that could throw outside runJobSequentially itself (e.g. a
 * `.then()` chained onto its returned promise). Both the DB write and the
 * broadcast are individually swallowed - if the DB itself is the thing
 * failing, at least the SSE event still reaches a connected client.
 */
export function markJobFailed(cfg: ServerConfig, jobId: string, completed: number, total: number, failedCount: number): void {
  try {
    const db = openDb(cfg);
    try {
      db.prepare('UPDATE batch_jobs SET status = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?').run('failed', jobId);
    } finally {
      db.close();
    }
  } catch {
    // Best-effort - see doc comment above.
  }
  try {
    broadcastJobEvent({ jobId, status: 'failed', completed, total, failedCount });
  } catch {
    // Best-effort - see doc comment above.
  }
}

/**
 * Processes `archiveNames` one at a time via `processOne`, never in
 * parallel - see the reasoning in the module doc comment. The caller
 * (a route handler) does NOT await this: it fires the job and responds
 * with the job id immediately, letting this run across subsequent event
 * loop turns.
 *
 * `onBeforeComplete`, when given, runs after every item has been processed
 * but before the job is marked 'done' and the terminal SSE event fires -
 * this is how a caller (e.g. batch-strip-preview) can guarantee its
 * `result_json` write lands before the client ever sees a 'done' event for
 * this job, without relying on a `.then()` racing the broadcast.
 *
 * The whole body is wrapped in a top-level try/catch as a backstop: every
 * expected failure (processOne throwing, a per-item DB write throwing) is
 * already handled inline below by treating the item as an error and
 * continuing the loop, but if something still escapes - a DB write for the
 * *job* row itself, or `onBeforeComplete` throwing - this promise must still
 * resolve with the job in a terminal state rather than becoming an unhandled
 * rejection that wedges the job at 'running' forever (see Finding 1).
 */
export async function runJobSequentially(
  cfg: ServerConfig,
  jobId: string,
  archiveNames: string[],
  processOne: (archiveName: string) => ItemOutcome | Promise<ItemOutcome>,
  onBeforeComplete?: () => void | Promise<void>
): Promise<void> {
  let completed = 0;
  let failedCount = 0;
  try {
    for (const archiveName of archiveNames) {
      let outcome: ItemOutcome;
      try {
        outcome = await processOne(archiveName);
      } catch (e) {
        outcome = { error: String((e as Error)?.message ?? e) };
      }
      try {
        const db = openDb(cfg);
        try {
          if ('error' in outcome) {
            db.prepare('UPDATE batch_job_items SET status = ?, error = ? WHERE job_id = ? AND archive_name = ?')
              .run('error', outcome.error, jobId, archiveName);
            failedCount++;
          } else {
            db.prepare('UPDATE batch_job_items SET status = ? WHERE job_id = ? AND archive_name = ?')
              .run('ok', jobId, archiveName);
          }
          completed++;
          db.prepare('UPDATE batch_jobs SET completed = ?, failed_count = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?')
            .run(completed, failedCount, jobId);
        } finally {
          db.close();
        }
      } catch (writeError) {
        // The DB write for THIS item's outcome threw (e.g. a transient
        // SQLITE_BUSY) - treat the item as an error and keep going, the same
        // way a throwing processOne is handled above, rather than letting
        // the exception escape the loop and wedge the whole job at
        // 'running'. Retry once with a plainer write; if that also fails,
        // the in-memory counters still advance so the job still reaches a
        // terminal state, even though this one item's row may be stuck at
        // 'pending'.
        failedCount++;
        completed++;
        try {
          const db = openDb(cfg);
          try {
            db.prepare('UPDATE batch_job_items SET status = ?, error = ? WHERE job_id = ? AND archive_name = ?')
              .run('error', `db write failed: ${String((writeError as Error)?.message ?? writeError)}`, jobId, archiveName);
            db.prepare('UPDATE batch_jobs SET completed = ?, failed_count = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?')
              .run(completed, failedCount, jobId);
          } finally {
            db.close();
          }
        } catch {
          // Even the retry failed - fall through; the loop still continues
          // and the top-level catch below is the final backstop.
        }
      }
      broadcastJobEvent({ jobId, status: 'running', completed, total: archiveNames.length, failedCount });
    }
    if (onBeforeComplete) {
      await onBeforeComplete();
    }
    const db = openDb(cfg);
    try {
      db.prepare('UPDATE batch_jobs SET status = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?').run('done', jobId);
    } finally {
      db.close();
    }
    broadcastJobEvent({ jobId, status: 'done', completed, total: archiveNames.length, failedCount });
  } catch (e) {
    markJobFailed(cfg, jobId, completed, archiveNames.length, failedCount);
  }
}
