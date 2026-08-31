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
 * Processes `archiveNames` one at a time via `processOne`, never in
 * parallel - see the reasoning in the module doc comment. The caller
 * (a route handler) does NOT await this: it fires the job and responds
 * with the job id immediately, letting this run across subsequent event
 * loop turns.
 */
export async function runJobSequentially(
  cfg: ServerConfig,
  jobId: string,
  archiveNames: string[],
  processOne: (archiveName: string) => ItemOutcome | Promise<ItemOutcome>
): Promise<void> {
  let completed = 0;
  let failedCount = 0;
  for (const archiveName of archiveNames) {
    let outcome: ItemOutcome;
    try {
      outcome = await processOne(archiveName);
    } catch (e) {
      outcome = { error: String((e as Error)?.message ?? e) };
    }
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
    broadcastJobEvent({ jobId, status: 'running', completed, total: archiveNames.length, failedCount });
  }
  const db = openDb(cfg);
  try {
    db.prepare('UPDATE batch_jobs SET status = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?').run('done', jobId);
  } finally {
    db.close();
  }
  broadcastJobEvent({ jobId, status: 'done', completed, total: archiveNames.length, failedCount });
}
