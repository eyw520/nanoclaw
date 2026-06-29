/**
 * Cross-VM a2a wire frame. Transport-agnostic: the host produces/consumes
 * this shape; eva's SSH tunnel only moves the bytes. One JSON object per line.
 *
 * Increment 1 is text-only. File forwarding (inline base64) is a later
 * increment — the local-a2a `forwardAttachedFiles` path is unaffected.
 */
export interface A2aFrame {
  v: 1;
  /** Minted by the SENDER box; the cross-VM reply-correlation key. */
  msg_id: string;
  /** A msg_id the sender previously RECEIVED (i.e. one the OTHER box minted),
   *  or null for first contact. Used by the receiver to route replies home. */
  in_reply_to: string | null;
  /** Sender's peer name (eva-configured, stable). */
  from_peer: string;
  /** Intended receiver's peer name; the receiver rejects a mismatch. */
  to_peer: string;
  text: string;
}

/** Validate/parse an untrusted frame (off the wire). Returns null if malformed. */
export function parseA2aFrame(raw: unknown): A2aFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  if (f.v !== 1) return null;
  if (typeof f.msg_id !== 'string' || !f.msg_id) return null;
  if (typeof f.from_peer !== 'string' || !f.from_peer) return null;
  if (typeof f.to_peer !== 'string' || !f.to_peer) return null;
  if (typeof f.text !== 'string') return null;
  const inReplyTo = typeof f.in_reply_to === 'string' ? f.in_reply_to : null;
  return {
    v: 1,
    msg_id: f.msg_id,
    in_reply_to: inReplyTo,
    from_peer: f.from_peer,
    to_peer: f.to_peer,
    text: f.text,
  };
}
