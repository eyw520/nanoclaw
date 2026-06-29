import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Cross-VM agent-to-agent (a2a) support.
 *
 * Two additions, both inert unless a cross-VM peer is configured (see the
 * a2a-bridge module + eva's `apply a2a`):
 *
 * 1. `agent_groups.remote_peer` — NULL on every real, runnable agent group.
 *    A non-NULL value marks a "stand-in" group: a session-less placeholder
 *    that represents a peer agent group living on ANOTHER VM. The stand-in is
 *    a normal agent_groups row (so destinations/projection/formatter/reply
 *    machinery all work unchanged), but it is never spawned (it has no
 *    sessions) and the host's a2a send path ships its messages over the
 *    bridge instead of routing them locally. The value is the peer name.
 *
 * 2. `a2a_outbound_correlation` — the cross-VM reply-affinity bridge. Local
 *    `source_session_id` ids are meaningless on the peer VM, so each box
 *    records, for every a2a message IT sends over the bridge, the wire
 *    `msg_id` -> the originating local session. When the peer's reply comes
 *    back referencing that `msg_id` (as `in_reply_to`), this box resolves it
 *    to the exact originating session — preserving reply-affinity across VMs.
 */
export const migration020: Migration = {
  version: 20,
  name: 'a2a-remote-peer',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE agent_groups ADD COLUMN remote_peer TEXT;`);
    db.exec(`
      CREATE TABLE a2a_outbound_correlation (
        msg_id            TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL,
        peer              TEXT NOT NULL,
        created_at        TEXT NOT NULL
      );
    `);
  },
};
