/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { setCurrentInReplyTo, clearCurrentInReplyTo } from '../current-batch.js';
import { sendMessage } from './core.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  clearCurrentInReplyTo();
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps current batch in_reply_to on outbound rows', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // No setCurrentInReplyTo before this call — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('send_message MCP tool — new_thread routing', () => {
  beforeEach(() => {
    // Bind the session to a Slack DM thread, plus a named destination for
    // the same channel — the two paths that pin outbound to the thread.
    getInboundDb()
      .prepare(
        `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
         VALUES (1, 'slack', 'slack:D123', 'slack:D123:1111.2222')`,
      )
      .run();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('eden-dm', 'Eden DM', 'channel', 'slack', 'slack:D123', NULL)`,
      )
      .run();
  });

  it('defaults to the session thread', async () => {
    await sendMessage.handler({ text: 'in place' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('slack:D123:1111.2222');
  });

  it('new_thread posts top-level on the session channel', async () => {
    await sendMessage.handler({ text: 'fresh root', new_thread: true });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBeNull();
    expect(out[0].platform_id).toBe('slack:D123');
    expect(out[0].channel_type).toBe('slack');
  });

  it('new_thread drops the preserved thread on a same-channel named destination', async () => {
    await sendMessage.handler({ to: 'eden-dm', text: 'kept' });
    await sendMessage.handler({ to: 'eden-dm', text: 'fresh', new_thread: true });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    expect(out[0].thread_id).toBe('slack:D123:1111.2222');
    expect(out[1].thread_id).toBeNull();
  });
});
