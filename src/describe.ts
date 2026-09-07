/**
 * The door-description extractor now lives in `contract/`, because the BBS
 * needs to run the SAME rules over the same input and get the same reading.
 *
 * It qualified for `contract/` on its own merits: no imports at all, pure text
 * processing, and rules tuned over fifteen rounds against the 3301-door corpus
 * and pinned by `tests/describe.test.ts`.
 *
 * This re-export exists so that every importer in this repo - submissions,
 * public-routes, manifest, admin-routes, catalog and two scripts - is
 * untouched by the move.
 */
export * from '../contract/describe';
