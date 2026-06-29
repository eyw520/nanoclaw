/**
 * Central per-session, per-model token + cost ledger (`session_usage` table).
 *
 * Written only by the host sweep, which drains the cumulative totals the
 * container accumulates in outbound.db `session_state['usage']`. Because those
 * counts are already cumulative, the write is a plain upsert (REPLACE) of the
 * latest totals — never an increment — so it is safe to run every sweep.
 *
 * Aggregate by `agent_group_id` for per-agent spend, by `model` for per-API.
 */
import { getDb } from './connection.js';

/** Per-model cumulative totals for one session (matches the container's JSON). */
export interface SessionModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  turns: number;
}

export function upsertSessionUsage(
  agentGroupId: string,
  sessionId: string,
  totalsByModel: Record<string, SessionModelTotals>,
  updatedAt: string,
  /** Topmost ancestor for cost rollup; the caller resolves it while the group
   *  still exists (harvest-proof). Defaults to the group's own id. */
  rootAgentId: string = agentGroupId,
): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO session_usage
       (agent_group_id, session_id, model, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, cost_usd, turns, updated_at, root_agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_group_id, session_id, model) DO UPDATE SET
       input_tokens          = excluded.input_tokens,
       output_tokens         = excluded.output_tokens,
       cache_read_tokens     = excluded.cache_read_tokens,
       cache_creation_tokens = excluded.cache_creation_tokens,
       cost_usd              = excluded.cost_usd,
       turns                 = excluded.turns,
       updated_at            = excluded.updated_at,
       root_agent_id         = excluded.root_agent_id`,
  );
  const apply = db.transaction((rows: Array<[string, SessionModelTotals]>) => {
    for (const [model, t] of rows) {
      stmt.run(
        agentGroupId,
        sessionId,
        model,
        t.inputTokens,
        t.outputTokens,
        t.cacheReadTokens,
        t.cacheCreationTokens,
        t.costUsd,
        t.turns,
        updatedAt,
        rootAgentId,
      );
    }
  });
  apply(Object.entries(totalsByModel));
}
