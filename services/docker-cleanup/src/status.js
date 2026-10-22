import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DEFAULT_STATUS_FILE = '/run/docker-cleanup/status.json';

export async function writeCleanupStatus(status, env = process.env) {
  const statusFile = env.CLEANUP_STATUS_FILE;
  if (!statusFile) return;

  await fs.mkdir(path.dirname(statusFile), { recursive: true });
  const pendingFile = `${statusFile}.pending-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(pendingFile, `${JSON.stringify(status)}\n`, { mode: 0o644 });
    await fs.rename(pendingFile, statusFile);
  } catch (error) {
    await fs.rm(pendingFile, { force: true }).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await writeCleanupStatus({ state: 'starting', startedAt: new Date().toISOString() });
  } catch (error) {
    console.error(`[docker-cleanup] Could not initialize cleanup health state: ${error.message}`);
    process.exitCode = 1;
  }
}
