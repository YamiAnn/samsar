import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CONTAINER_RUNTIMES = new Set(['docker', 'container', 'compose', 'kubernetes', 'k8s']);
export const DEFAULT_CLEANUP_MIN_AGE_HOURS = 168;
export const DEFAULT_STALE_SESSION_FRAME_CLEANUP_HOURS = 24;
export const DEFAULT_INTERMEDIATE_MEDIA_CLEANUP_HOURS = 48;

const STAGE_RETENTION_DEFAULTS = Object.freeze({
  STALE_SESSION_FRAME_CLEANUP_HOURS: DEFAULT_STALE_SESSION_FRAME_CLEANUP_HOURS,
  INTERMEDIATE_MEDIA_CLEANUP_HOURS: DEFAULT_INTERMEDIATE_MEDIA_CLEANUP_HOURS,
});

export function isContainerRuntime(env = process.env, dockerMarkerPresent = fs.existsSync('/.dockerenv')) {
  return dockerMarkerPresent || [env.SAMSAR_RUNTIME, env.CURRENT_ENV].some(
    (value) => CONTAINER_RUNTIMES.has(String(value || '').trim().toLowerCase()),
  );
}

export function getProcessorAssetsRoot(folderName, {
  env = process.env,
  dockerMarkerPresent = fs.existsSync('/.dockerenv'),
  projectRoot = PROJECT_ROOT,
} = {}) {
  if (!['assets', 'assets_v2'].includes(folderName)) {
    throw new Error(`Unsupported processor assets folder: ${folderName}`);
  }
  const override = env[folderName === 'assets_v2' ? 'SAMSAR_ASSETS_V2_ROOT' : 'SAMSAR_ASSETS_ROOT'];
  if (override) return path.resolve(override);
  if (isContainerRuntime(env, dockerMarkerPresent)) return `/${folderName}`;

  // Resolve from the installed service, since host cron can start in any cwd.
  const processorName = path.basename(path.resolve(projectRoot)) === 'task-processor'
    ? 'processor'
    : 'samsar_processor';
  return path.resolve(projectRoot, '..', processorName, folderName);
}

export function getCleanupMinAgeHours(stageSetting, env = process.env) {
  const configuredStageValue = env[stageSetting];
  const hasStageOverride = configuredStageValue !== undefined && configuredStageValue !== '';
  const hasStageDefault = Object.hasOwn(STAGE_RETENTION_DEFAULTS, stageSetting);
  const setting = hasStageOverride || hasStageDefault ? stageSetting : 'CLEANUP_MIN_AGE_HOURS';
  const rawValue = hasStageOverride
    ? configuredStageValue
    : hasStageDefault
      ? STAGE_RETENTION_DEFAULTS[stageSetting]
      : env.CLEANUP_MIN_AGE_HOURS;
  if (rawValue === undefined || rawValue === '') return DEFAULT_CLEANUP_MIN_AGE_HOURS;
  const hours = Number(rawValue);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`${setting} must be a positive number; received "${rawValue}"`);
  }
  return hours;
}
