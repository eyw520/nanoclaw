import { getDb } from './connection.js';

/**
 * Cross-VM a2a reply-affinity correlation (table created in migration 018).
 *
 * Local `source_session_id` ids are meaningless on a peer VM, so the wire
 * `msg_id` is the cross-VM handle. For every a2a message THIS box sends over
 * the bridge we record `msg_id -> originating local session`. When the peer's
 * reply comes back with `in_reply_to = <that msg_id>`, we resolve it to the
 * exact originating session — preserving reply-affinity across VMs.
 */

export interface A2aCorrelation {
  msg_id: string;
  source_session_id: string;
  peer: string;
  created_at: string;
}

/** Record the originating session for an outbound bridge message. */
export function recordOutboundCorrelation(msgId: string, sourceSessionId: string, peer: string): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO a2a_outbound_correlation (msg_id, source_session_id, peer, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(msgId, sourceSessionId, peer, new Date().toISOString());
}

/** Resolve a reply's `in_reply_to` (a msg_id this box minted) → its origin. */
export function getOutboundCorrelation(msgId: string): A2aCorrelation | undefined {
  return getDb().prepare('SELECT * FROM a2a_outbound_correlation WHERE msg_id = ?').get(msgId) as
    | A2aCorrelation
    | undefined;
}
