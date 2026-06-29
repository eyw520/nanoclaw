/**
 * Per-session token + cost ledger, accumulated in outbound.db's `session_state`
 * under the `usage` key — cumulative per model for the life of the session.
 *
 * The host drains this (read-only) on each sweep into the central
 * `session_usage` table (see src/db/session-usage.ts + src/host-sweep.ts). It
 * rides the existing session_state carrier rather than a new transport table,
 * so it needs no extra seq/ack/drain plumbing and respects the single-writer
 * invariant (only the container writes outbound.db; the host reads).
 */
import type { ModelTurnUsage } from '../providers/types.js';
import { getOutboundDb } from './connection.js';

const USAGE_KEY = 'usage';

interface ModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  turns: number;
}

type UsageTotals = Record<string, ModelTotals>;

function read(): UsageTotals {
  const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?').get(USAGE_KEY) as
    | { value: string }
    | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.value) as UsageTotals;
  } catch {
    return {};
  }
}

/**
 * Fold one completed turn's per-model usage into the session's cumulative
 * totals. Call once per `result` event. Never throws — metering is best-effort
 * and must never break a turn.
 */
export function recordTurnUsage(usage: ModelTurnUsage[] | undefined): void {
  if (!usage || usage.length === 0) return;
  try {
    const totals = read();
    for (const u of usage) {
      const t = totals[u.model] ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        turns: 0,
      };
      t.inputTokens += u.inputTokens;
      t.outputTokens += u.outputTokens;
      t.cacheReadTokens += u.cacheReadTokens;
      t.cacheCreationTokens += u.cacheCreationTokens;
      t.costUsd += u.costUsd;
      t.turns += 1;
      totals[u.model] = t;
    }
    getOutboundDb()
      .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(USAGE_KEY, JSON.stringify(totals), new Date().toISOString());
  } catch {
    // best-effort: a metering write must never fail the turn
  }
}
