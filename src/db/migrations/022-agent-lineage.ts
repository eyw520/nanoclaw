import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Builder/sub-agent lineage, for rolling cost up to the agent that spawned the
 * work (Phase 2a of cost monitoring).
 *
 * 1. `agent_groups.root_agent_id` — NULL for a top-level/owner group; for a
 *    sub-agent it is the id of the TOPMOST ancestor (so a grandchild shares its
 *    parent's root, not the immediate parent). Set once at creation in
 *    create-agent.ts; lineage never changes after.
 *
 * 2. `session_usage.root_agent_id` — the resolved root, stamped by the host
 *    sweep at drain time from (1). Denormalized ON PURPOSE: Builders are
 *    routinely harvested (their agent_groups row is deleted), so resolving the
 *    root by JOIN at query time would silently drop a harvested child's spend.
 *    Stamping it while the group still exists keeps the rollup harvest-proof —
 *    aggregation is then a plain GROUP BY root_agent_id, no join required.
 *
 * Pre-existing session_usage rows keep NULL here; aggregation falls back to
 * `agent_group_id` for them (COALESCE), so they bucket as their own root.
 */
export const migration022: Migration = {
  version: 22,
  name: 'agent-lineage',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE agent_groups ADD COLUMN root_agent_id TEXT;`);
    db.exec(`ALTER TABLE session_usage ADD COLUMN root_agent_id TEXT;`);
    db.exec(`CREATE INDEX idx_session_usage_root ON session_usage(root_agent_id);`);
  },
};
