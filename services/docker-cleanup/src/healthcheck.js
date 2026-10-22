import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STATUS_FILE } from './status.js';

const DEFAULT_MAX_AGE_HOURS = 4;
const DEFAULT_MAX_RUN_HOURS = 0.5;

export function evaluateCleanupHealth(status, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeHours = options.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const maxRunHours = options.maxRunHours ?? DEFAULT_MAX_RUN_HOURS;
  const cronProcessName = options.cronProcessName ?? 'cron';

  if (cronProcessName !== 'cron') return 'cron is not running as PID 1';
  if (status?.state === 'running') {
    const startedAtMs = Date.parse(status.startedAt);
    if (!Number.isFinite(startedAtMs)) return 'current cleanup start time is invalid';
    if (startedAtMs > nowMs + 60_000) return 'current cleanup start time is in the future';
    if (nowMs - startedAtMs > maxRunHours * 3_600_000) return 'current cleanup has exceeded its run limit';
    return null;
  }
  if (status?.state !== 'success') return `last cleanup state is ${status?.state || 'missing'}`;

  const completedAtMs = Date.parse(status.completedAt);
  if (!Number.isFinite(completedAtMs)) return 'last cleanup completion time is invalid';
  if (completedAtMs > nowMs + 60_000) return 'last cleanup completion time is in the future';
  if (nowMs - completedAtMs > maxAgeHours * 3_600_000) return 'last successful cleanup is stale';
  return null;
}

export async function checkCleanupHealth(options = {}) {
  const env = options.env ?? process.env;
  const maxAgeHours = Number(env.CLEANUP_HEALTH_MAX_AGE_HOURS || DEFAULT_MAX_AGE_HOURS);
  const maxRunHours = Number(env.CLEANUP_HEALTH_MAX_RUN_HOURS || DEFAULT_MAX_RUN_HOURS);
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    return 'CLEANUP_HEALTH_MAX_AGE_HOURS must be a positive number';
  }
  if (!Number.isFinite(maxRunHours) || maxRunHours <= 0) {
    return 'CLEANUP_HEALTH_MAX_RUN_HOURS must be a positive number';
  }

  try {
    const cronProcessName = (await fs.readFile(options.cronCommFile || '/proc/1/comm', 'utf8')).trim();
    const status = JSON.parse(await fs.readFile(env.CLEANUP_STATUS_FILE || DEFAULT_STATUS_FILE, 'utf8'));
    return evaluateCleanupHealth(status, {
      nowMs: options.nowMs,
      maxAgeHours,
      maxRunHours,
      cronProcessName,
    });
  } catch (error) {
    return `cleanup health state unavailable: ${error.message}`;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failure = await checkCleanupHealth();
  if (failure) {
    console.error(`[docker-cleanup] Unhealthy: ${failure}`);
    process.exitCode = 1;
  }
}
