import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'TZ',
  'NANOCLAW_DM_THREAD_PER_MESSAGE',
  'CONTAINER_CEILING_MS',
  'MAX_CONCURRENT_CONTAINERS',
  'A2A_BRIDGE_ENDPOINT',
  'A2A_SELF_PEER',
]);

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Per-box toggle: treat each top-level DM message as its own thread/session, so
// a task-oriented agent (e.g. a coding bot) gets one isolated session per
// message. Off by default — conversational DMs keep single-session continuity.
export const DM_THREAD_PER_MESSAGE =
  (process.env.NANOCLAW_DM_THREAD_PER_MESSAGE || envConfig.NANOCLAW_DM_THREAD_PER_MESSAGE) === 'true';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Per-checkout image tag so two installs on the same host don't share
// `nanoclaw-agent:latest` and clobber each other on rebuild.
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Install slug — stamped onto every spawned container via --label so
// cleanupOrphans only reaps containers from this install, not peers.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
// (IDLE_TIMEOUT removed: it was dead config — no idle reaper reads it. Container
// lifetime is governed solely by the host-sweep absolute ceiling below; the old
// IDLE_TIMEOUT setTimeout it replaced is gone. See host-sweep.ts.)
// Absolute idle ceiling for a running container (host-sweep). MUST read through
// envConfig like the rest of this file — .env is parsed into envConfig, NOT
// injected into process.env, so a process.env-only read silently falls back to
// the default. Coding/orchestrator bots run long blocking subprocesses (a nested
// `claude -p` build that doesn't touch the heartbeat) and get reaped mid-task at
// 30min; bump via CONTAINER_CEILING_MS in .env. Default 30min.
export const CONTAINER_CEILING_MS = parseInt(
  process.env.CONTAINER_CEILING_MS || envConfig.CONTAINER_CEILING_MS || String(30 * 60 * 1000),
  10,
);
// Global concurrent-container cap (enforced in wakeContainer). MUST read through
// envConfig like CONTAINER_CEILING_MS above — .env is parsed into envConfig, NOT
// injected into process.env, so a process.env-only read silently defaults to 5 and
// the cap appears stuck at 5 regardless of .env (which deadlocks a busy box: 5 slots
// jam, every due wake defers forever). Default 5.
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || envConfig.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);
// Per-container resource caps, passed through to `docker run`. Default empty =
// no flag added = today's unbounded behavior (don't OOM existing OSS workloads).
// Operators opt in: CONTAINER_CPU_LIMIT=2, CONTAINER_MEMORY_LIMIT=8g.
export const CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || '';
export const CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || '';

// Cross-VM a2a bridge (see src/modules/a2a-bridge). Both empty by default →
// the bridge is fully inert (no group is ever marked remote_peer without eva
// also setting these, and the send path no-ops/throws if the endpoint is
// unset). MUST read through envConfig like the rest of this file — .env is
// parsed into envConfig, NOT injected into process.env.
//   A2A_BRIDGE_ENDPOINT — local URL the host POSTs outbound frames to (eva's
//     SSH-tunnel ingress, e.g. http://127.0.0.1:<port>).
//   A2A_SELF_PEER — this box's peer name; received frames whose to_peer differs
//     are rejected.
export const A2A_BRIDGE_ENDPOINT = process.env.A2A_BRIDGE_ENDPOINT || envConfig.A2A_BRIDGE_ENDPOINT || '';
export const A2A_SELF_PEER = process.env.A2A_SELF_PEER || envConfig.A2A_SELF_PEER || '';

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
