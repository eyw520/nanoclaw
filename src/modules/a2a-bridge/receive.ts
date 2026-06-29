/**
 * Cross-VM a2a — RECEIVE side.
 *
 * Invoked (via the CLI channel's `{a2a:…}` frame → `onA2aInbound` in
 * src/index.ts) when eva's SSH-tunnel terminator feeds a frame into the
 * owner-only `cli.sock`. Produces a normal a2a inbound row on the recipient's
 * session, attributed to the LOCAL stand-in for the sending peer — so the
 * receiving agent sees `from="<peer>"` and can reply through that stand-in,
 * with the reply bridged straight back out. Reuses the existing projection /
 * formatter / reply-affinity machinery; the only cross-VM-specific step is
 * resolving the reply target via the correlation table.
 */
import { A2A_SELF_PEER } from '../../config.js';
import { wakeContainer } from '../../container-runner.js';
import { getOutboundCorrelation } from '../../db/a2a-correlation.js';
import { getAgentGroupByRemotePeer } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import { getDestinationReferencers } from '../agent-to-agent/db/agent-destinations.js';
import { parseA2aFrame } from './frame.js';

export async function receiveRemoteAgentMessage(raw: unknown): Promise<void> {
  const frame = parseA2aFrame(raw);
  if (!frame) {
    log.warn('a2a-bridge: dropping malformed inbound frame');
    return;
  }
  // Integrity: the tunnel is point-to-point, but reject a misrouted frame.
  if (A2A_SELF_PEER && frame.to_peer !== A2A_SELF_PEER) {
    log.warn('a2a-bridge: dropping frame addressed to another peer', {
      to_peer: frame.to_peer,
      self: A2A_SELF_PEER,
    });
    return;
  }

  // Map the sending peer → its local stand-in group.
  const standin = getAgentGroupByRemotePeer(frame.from_peer);
  if (!standin) {
    log.warn('a2a-bridge: no local stand-in for peer — dropping', { from_peer: frame.from_peer });
    return;
  }

  // The recipient real group is the local group that has a destination to the
  // stand-in (the bidirectional pair eva provisions). There should be exactly
  // one; if several, the first is the canonical owner.
  const recipients = getDestinationReferencers(standin.id);
  if (recipients.length === 0) {
    log.warn('a2a-bridge: stand-in has no local owner group — dropping', {
      from_peer: frame.from_peer,
      standin: standin.id,
    });
    return;
  }
  const recipientGroupId = recipients[0];

  // Resolve the recipient session. A reply (in_reply_to references a msg_id
  // THIS box minted) routes to the exact originating session via the
  // correlation table; otherwise the agent-shared session — mirroring
  // routeAgentMessage's tiered resolution, adapted for the cross-VM id space.
  let targetSessionId: string | null = null;
  if (frame.in_reply_to) {
    const corr = getOutboundCorrelation(frame.in_reply_to);
    if (corr) {
      const candidate = getSession(corr.source_session_id);
      if (candidate && candidate.agent_group_id === recipientGroupId && candidate.status === 'active') {
        targetSessionId = candidate.id;
      }
    }
  }
  if (!targetSessionId) {
    targetSessionId = resolveSession(recipientGroupId, null, null, 'agent-shared').session.id;
  }

  // Write as an a2a inbound: channel_type='agent', platform_id=<stand-in id>
  // (so the formatter renders from="<peer>"), source_session_id=<this session>
  // (local return path for the receiver's peer-affinity). The row id REUSES
  // the wire msg_id — load-bearing: the receiver's reply derives in_reply_to
  // from this row id, and that must equal the msg_id so the SENDER box can
  // correlate the reply back home.
  writeSessionMessage(recipientGroupId, targetSessionId, {
    id: frame.msg_id,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: standin.id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text: frame.text, sender: frame.from_peer, senderId: `a2a:${frame.from_peer}` }),
    sourceSessionId: targetSessionId,
  });
  log.info('Remote agent message received + injected', {
    from_peer: frame.from_peer,
    standin: standin.id,
    recipient: recipientGroupId,
    targetSession: targetSessionId,
    msgId: frame.msg_id,
    inReplyTo: frame.in_reply_to,
  });

  const fresh = getSession(targetSessionId);
  if (fresh) await wakeContainer(fresh);
}
