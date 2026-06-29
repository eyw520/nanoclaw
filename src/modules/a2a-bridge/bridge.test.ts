/**
 * Cross-VM a2a bridge — send → frame → receive → reply-affinity, exercised in
 * a single in-memory install (one box plays both "edge real group" and the
 * everest-facing receiver, since the A↔stand-in destination pair models both
 * directions). Verifies: frame shape, outbound correlation, a2a inbound row
 * attribution, and that a reply (in_reply_to = a minted msg_id) lands back in
 * the exact originating session.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-a2a-bridge';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    // Literal (not TEST_DIR) — the factory is hoisted above the const.
    DATA_DIR: '/tmp/nanoclaw-test-a2a-bridge',
    A2A_BRIDGE_ENDPOINT: 'http://127.0.0.1:59999',
    A2A_SELF_PEER: 'edge',
  };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getOutboundCorrelation } from '../../db/a2a-correlation.js';
import { createSession, getSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import { initSessionFolder, inboundDbPath } from '../../session-manager.js';
import { createDestination } from '../agent-to-agent/db/agent-destinations.js';
import { parseA2aFrame } from './frame.js';
import { routeRemoteAgentMessage } from './send.js';
import { receiveRemoteAgentMessage } from './receive.js';

const now = (): string => new Date().toISOString();
const REAL = 'ag-edge-real';
const STANDIN = 'ag-everest-standin';
const SESSION = 'sess-edge-1';

interface InRow {
  id: string;
  channel_type: string;
  platform_id: string;
  content: string;
  source_session_id: string | null;
  session_id: string;
}

/** Scan every session of an agent group for inbound rows (robust to whichever
 *  session resolveSession picks for an agent-shared message). */
function readInbound(agentGroupId: string): InRow[] {
  const out: InRow[] = [];
  for (const s of getSessionsByAgentGroup(agentGroupId)) {
    const path = inboundDbPath(agentGroupId, s.id);
    if (!fs.existsSync(path)) continue;
    const db = new Database(path, { readonly: true });
    for (const r of db
      .prepare('SELECT id, channel_type, platform_id, content, source_session_id FROM messages_in ORDER BY rowid')
      .all() as Omit<InRow, 'session_id'>[]) {
      out.push({ ...r, session_id: s.id });
    }
    db.close();
  }
  return out;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: REAL, name: 'edge', folder: 'edge', agent_provider: null, created_at: now() });
  // Stand-in for the remote Everest peer.
  createAgentGroup({ id: STANDIN, name: 'everest', folder: 'everest', agent_provider: null, created_at: now() });
  db.prepare('UPDATE agent_groups SET remote_peer = ? WHERE id = ?').run('everest', STANDIN);

  // Bidirectional destinations (the pair eva provisions).
  createDestination({
    agent_group_id: REAL,
    local_name: 'everest',
    target_type: 'agent',
    target_id: STANDIN,
    created_at: now(),
  });
  createDestination({
    agent_group_id: STANDIN,
    local_name: 'edge',
    target_type: 'agent',
    target_id: REAL,
    created_at: now(),
  });

  createSession({
    id: SESSION,
    agent_group_id: REAL,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder(REAL, SESSION);

  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('parseA2aFrame', () => {
  it('accepts a well-formed frame and rejects malformed ones', () => {
    expect(
      parseA2aFrame({ v: 1, msg_id: 'm', in_reply_to: null, from_peer: 'a', to_peer: 'b', text: 'hi' }),
    ).toMatchObject({
      msg_id: 'm',
      from_peer: 'a',
      to_peer: 'b',
      text: 'hi',
    });
    expect(parseA2aFrame({ v: 2, msg_id: 'm', from_peer: 'a', to_peer: 'b', text: 'x' })).toBeNull();
    expect(parseA2aFrame({ v: 1, from_peer: 'a', to_peer: 'b', text: 'x' })).toBeNull();
    expect(parseA2aFrame('nope')).toBeNull();
  });
});

describe('send → bridge frame + correlation', () => {
  it('ships a frame to the endpoint and records reply-correlation', async () => {
    const session = getSession(SESSION)!;
    await routeRemoteAgentMessage(
      { id: 'out-1', platform_id: STANDIN, content: JSON.stringify({ text: 'hello everest' }), in_reply_to: null },
      session,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toMatchObject({
      v: 1,
      from_peer: 'edge',
      to_peer: 'everest',
      text: 'hello everest',
      in_reply_to: null,
    });
    expect(typeof body.msg_id).toBe('string');

    const corr = getOutboundCorrelation(body.msg_id);
    expect(corr).toMatchObject({ source_session_id: SESSION, peer: 'everest' });
  });
});

describe('receive → a2a inbound + reply-affinity', () => {
  it('injects a forward as an agent inbound attributed to the stand-in', async () => {
    await receiveRemoteAgentMessage({
      v: 1,
      msg_id: 'E1',
      in_reply_to: null,
      from_peer: 'everest',
      to_peer: 'edge',
      text: 'hi edge',
    });

    const row = readInbound(REAL).find((r) => r.id === 'E1');
    expect(row).toBeTruthy();
    expect(row!.channel_type).toBe('agent');
    expect(row!.platform_id).toBe(STANDIN);
    expect(JSON.parse(row!.content).text).toBe('hi edge');
  });

  it('routes a reply (in_reply_to = a minted msg_id) back to the originating session', async () => {
    const session = getSession(SESSION)!;
    await routeRemoteAgentMessage(
      { id: 'out-2', platform_id: STANDIN, content: JSON.stringify({ text: 'question' }), in_reply_to: null },
      session,
    );
    const sentMsgId = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body).msg_id as string;

    // Everest's reply references the msg_id this box minted.
    await receiveRemoteAgentMessage({
      v: 1,
      msg_id: 'V1',
      in_reply_to: sentMsgId,
      from_peer: 'everest',
      to_peer: 'edge',
      text: 'answer',
    });

    const reply = readInbound(REAL).find((r) => r.id === 'V1');
    expect(reply).toBeTruthy();
    // Reply-affinity: landed in the exact session that sent the original.
    expect(reply!.session_id).toBe(SESSION);
    expect(reply!.channel_type).toBe('agent');
    expect(JSON.parse(reply!.content).text).toBe('answer');
  });

  it('rejects a frame addressed to a different peer', async () => {
    await receiveRemoteAgentMessage({
      v: 1,
      msg_id: 'X1',
      in_reply_to: null,
      from_peer: 'everest',
      to_peer: 'someone-else',
      text: 'misrouted',
    });
    expect(readInbound(REAL).find((r) => r.id === 'X1')).toBeUndefined();
  });
});
