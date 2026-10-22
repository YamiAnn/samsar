import path from 'node:path';
import { fileURLToPath } from 'node:url';

function validateSchedule(schedule) {
  const fields = schedule.trim().split(/\s+/);
  const limits = [
    [0, 59, []], [0, 23, []], [1, 31, []],
    [1, 12, ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']],
    [0, 7, ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']],
  ];
  if (fields.length !== 5 || /[\r\n]/.test(schedule)) {
    throw new Error('CLEANUP_CRON_SCHEDULE must contain five cron fields');
  }
  fields.forEach((field, index) => {
    const [min, max, names] = limits[index];
    const fail = () => { throw new Error(`Invalid CLEANUP_CRON_SCHEDULE field ${index + 1}: ${field}`); };
    const number = (value) => {
      const parsed = /^\d+$/.test(value) ? Number(value) : names.indexOf(value.toUpperCase()) + min;
      if (parsed < min || parsed > max) fail();
      return parsed;
    };
    for (const part of field.split(',')) {
      const [range, step, extra] = part.split('/');
      if (extra !== undefined || (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1))) fail();
      if (range === '*') continue;
      const bounds = range.split('-');
      if (bounds.length > 2 || bounds.some((bound) => !bound)) fail();
      const start = number(bounds[0]);
      if (bounds.length === 2 && number(bounds[1]) < start) fail();
    }
  });
}

// cron.d uses its own environment syntax, not shell assignment syntax. In
// particular, an unquoted empty value makes Debian cron reject the whole file.
export function renderCleanupCrontab(env = process.env) {
  const schedule = env.CLEANUP_CRON_SCHEDULE || '17 */3 * * *';
  // Debian's crontab dry-run accepts some out-of-range fields, so check these
  // ourselves as well as validating the rendered file with the installed cron.
  validateSchedule(schedule);

  const settings = {
    SHELL: '/bin/sh',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    SAMSAR_ASSETS_V2_ROOT: env.SAMSAR_ASSETS_V2_ROOT || '/assets_v2',
    CLEANUP_MIN_AGE_HOURS: env.CLEANUP_MIN_AGE_HOURS || '168',
    CLEANUP_DRY_RUN: env.CLEANUP_DRY_RUN || 'false',
  };
  for (const name of [
    'CLEANUP_FRAME_MIN_AGE_HOURS',
    'CLEANUP_TEMP_MIN_AGE_HOURS',
    'CLEANUP_STATUS_FILE',
    'CLEANUP_TARGETS',
    'ALLOW_NON_ASSETS_V2_ROOT',
  ]) {
    if (env[name]) settings[name] = env[name];
  }

  const lines = Object.entries(settings).map(([name, value]) => {
    if (/[\r\n"\0]/.test(String(value))) {
      throw new Error(`${name} contains characters unsupported by cron environment syntax`);
    }
    return `${name}="${value}"`;
  });
  lines.push(`${schedule} root node /app/src/cleanup.js >> /proc/1/fd/1 2>> /proc/1/fd/2`);
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(renderCleanupCrontab());
}
