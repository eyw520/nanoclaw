/**
 * Cross-VM a2a — SEND side.
 *
 * Dispatched from delivery.ts when an outbound `channel_type='agent'` message
 * targets a stand-in group (one with `remote_peer` set). Instead of the local
 * `routeAgentMessage` (which would fail — the real target lives on another
 * VM), we mint a wire frame, record reply-correlation, and POST it to the
 * locally-configured bridge endpoint (eva's SSH-tunnel ingress). On any
 * failure we THROW, which lands in delivery.ts's existing retry/backoff/
 * dead-letter machinery — identical semantics to a transient local failure.
 */
import { A2A_BRIDGE_ENDPOINT, A2A_SELF_PEER } from '../../config.js';
import { recordOutboundCorrelation } from '../../db/a2a-correlation.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import type { RoutableAgentMessage } from '../agent-to-agent/agent-route.js';
import { hasDestination } from '../agent-to-agent/db/agent-destinations.js';
import type { A2aFrame } from './frame.js';

function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.text === 'string') return parsed.text;
  } catch {
    /* not JSON — fall through */
  }
  return content;
}

export async function routeRemoteAgentMessage(msg: RoutableAgentMessage, session: Session): Promise<void> {
  const targetId = msg.platform_id;
  if (!targetId) {
    throw new Error(`a2a-bridge: message ${msg.id} is missing a target agent group id`);
  }
  // ACL — the stand-in is a normal destination target, so reuse the exact
  // check the local path uses.
  if (targetId !== session.agent_group_id && !hasDestination(session.agent_group_id, 'agent', targetId)) {
    throw new Error(`a2a-bridge: ${session.agent_group_id} has no destination for ${targetId}`);
  }
  const target = getAgentGroup(targetId);
  if (!target?.remote_peer) {
    // Defensive — delivery.ts only routes here when remote_peer is set.
    throw new Error(`a2a-bridge: target ${targetId} is not a remote stand-in`);
  }
  if (!A2A_BRIDGE_ENDPOINT) {
    throw new Error('a2a-bridge: A2A_BRIDGE_ENDPOINT not configured');
  }
  if (!A2A_SELF_PEER) {
    throw new Error('a2a-bridge: A2A_SELF_PEER not configured');
  }

  const msgId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Record BEFORE shipping so a reply that races back can always correlate.
  recordOutboundCorrelation(msgId, session.id, target.remote_peer);

  const frame: A2aFrame = {
    v: 1,
    msg_id: msgId,
    in_reply_to: msg.in_reply_to ?? null,
    from_peer: A2A_SELF_PEER,
    to_peer: target.remote_peer,
    text: extractText(msg.content),
  };

  const url = `${A2A_BRIDGE_ENDPOINT.replace(/\/+$/, '')}/a2a`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(frame),
    });
  } catch (err) {
    throw new Error(`a2a-bridge: POST to ${url} failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`a2a-bridge: POST to ${url} returned ${res.status}`);
  }
  log.info('Agent message bridged to remote peer', {
    from: session.agent_group_id,
    toPeer: target.remote_peer,
    msgId,
    inReplyTo: frame.in_reply_to,
  });
}
