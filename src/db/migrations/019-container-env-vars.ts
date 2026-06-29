import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Per-agent-group container environment variables.
 *
 * Some integrations need a secret/value present IN the container's environment
 * — e.g. GH_TOKEN for `git push` + `gh pr create` (the OneCLI gateway can only
 * inject bearer headers, not HTTPS basic-auth for git), or a token a stdio MCP
 * reads from env at startup. The gateway/vault can't cover these, so they live
 * here as a JSON map injected via `-e KEY=VALUE` at spawn. Stripped from the
 * materialized container.json so values never land on disk in the group folder.
 */
export const migration019: Migration = {
  version: 19,
  name: 'container-env-vars',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN env_vars TEXT NOT NULL DEFAULT '{}';`);
  },
};
