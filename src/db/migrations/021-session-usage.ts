import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Per-session, per-model token + cost ledger for cost monitoring.
 *
 * Populated by the host sweep, which drains each session's cumulative usage
 * (accumulated container-side in outbound.db `session_state['usage']` — see
 * container/agent-runner/src/db/usage.ts) and upserts it here. One row per
 * (agent_group, session, model); the columns are cumulative for the life of
 * the session, so the sweep upsert is a plain REPLACE with the latest totals.
 *
 * `cost_usd` is the provider-reported (SDK-computed) figure — good for
 * per-agent attribution; reconcile against the provider invoice for truth.
 * Aggregate by agent_group_id for per-agent spend, by model for per-API.
 */
export const migration021: Migration = {
  version: 21,
  name: 'session-usage',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE session_usage (
        agent_group_id        TEXT NOT NULL,
        session_id            TEXT NOT NULL,
        model                 TEXT NOT NULL,
        input_tokens          INTEGER NOT NULL DEFAULT 0,
        output_tokens         INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd              REAL NOT NULL DEFAULT 0,
        turns                 INTEGER NOT NULL DEFAULT 0,
        updated_at            TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, session_id, model)
      );
    `);
    db.exec(`CREATE INDEX idx_session_usage_group ON session_usage(agent_group_id);`);
  },
};
