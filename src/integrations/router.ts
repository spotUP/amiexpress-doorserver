/**
 * Public read-only integrations surface for chatbots (operator chats).
 *
 * BOT-API stance: no keys, CORS open (see doorRepoCors), {error} failures,
 * documented in docs/BOT-API.md. The BBS operator chat calls /answer, never
 * sources directly (keys must never leave the server; Amiga stacks do TLS
 * poorly). Admin management (toggles, keys, health dashboard) is a separate
 * admin router + panel (Phase 6); this router only READS config state.
 */
import { Router } from 'express';
import type { ServerConfig } from '../config';
import { openDb } from '../db';
import { createFetchJson, createFetchText, createHeadStatus, assertPublicUrl } from './fetch';
import { checkLink } from './sceneorg';
import type { FetchJson, FetchText, HeadStatus } from './types';
import { ADAPTERS, STATUS_ADAPTERS, answer, type AnswerMode } from './answer';
import { getSecretForAdapter } from './store';

const MODES: AnswerMode[] = ['search', 'random', 'latest'];

export function createIntegrationsRouter(
  cfg: ServerConfig,
  deps?: { fetchJson?: FetchJson; fetchText?: FetchText; head?: HeadStatus }
): Router {
  const router = Router();
  const fetchJson = deps?.fetchJson ?? createFetchJson();
  const fetchText = deps?.fetchText ?? createFetchText();
  const head = deps?.head ?? createHeadStatus();

  /** One question, attributed hits from every enabled source. */
  router.get('/answer', async (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 120);
    const rawMode = String(req.query.mode ?? 'search');
    const mode: AnswerMode = (MODES as string[]).includes(rawMode) ? (rawMode as AnswerMode) : 'search';
    if (!q) {
      res.status(400).json({ error: 'q is required' });
      return;
    }
    const db = openDb(cfg);
    try {
      const out = await answer(db, fetchJson, q, mode, { fetchText, head });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: `answer failed: ${(e as Error).message}` });
    } finally {
      db.close();
    }
  });

  /** What the panel's health dashboard reads: per-source id/name/needsKey,
   *  live check latency, and whether a secret is stored (names only). */
  router.get('/status', async (_req, res) => {
    const db = openDb(cfg);
    try {
      const out = await Promise.all(
        STATUS_ADAPTERS.map(async (a) => {
          const h = await a.health({
            fetchJson,
            fetchText,
            head,
            getSecret: (keyName) => getSecretForAdapter(db, a.id, keyName),
            settings: {},
          });
          return {
            id: a.id,
            name: a.name,
            needsKey: a.needsKey,
            hasSecret: a.needsKey
              ? getSecretForAdapter(db, a.id, 'api_key') !== null
              : undefined,
            ...h,
          };
        })
      );
      res.json({ sources: out });
    } catch (e) {
      res.status(500).json({ error: `status failed: ${(e as Error).message}` });
    } finally {
      db.close();
    }
  });

  /** HEAD-check a download URL before the chat hands it to a caller. */
  router.get('/check', async (req, res) => {
    const raw = String(req.query.url ?? '').trim().slice(0, 500);
    if (!raw) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    try {
      const parsed = await assertPublicUrl(raw);
      const out = await checkLink(parsed.toString(), {
        fetchJson, fetchText, head,
        getSecret: () => null, settings: {},
      });
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  return router;
}
