import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  GENBLAZE_FINAL_UP_ARGS,
  hasValidatedGenBlazeRuntimeCatalog,
  splitGenBlazeComposeProfiles,
} from '../apps/setup-wizard/genblazeCompose.mjs';
import { runComposeWithContainerRecovery } from '../apps/setup-wizard/composeRecovery.mjs';

export const ALL_RUNTIME_COMPOSE_PROFILES = Object.freeze([
  'core',
  'workers',
  'local-mongo',
  'minio',
  'local-media',
  'logger',
  'reverse-proxy',
  'genblaze',
]);

export function getRuntimeComposeProfiles(config = {}, { genBlazeCatalog } = {}) {
  const services = config.services || {};
  const profiles = ['core'];

  if (services.workers !== false) profiles.push('workers');
  if (services.localMongo !== false) profiles.push('local-mongo');
  if (services.minio !== false) profiles.push('minio');
  if (services.mediaGateway !== false) profiles.push('local-media');
  if (services.logger !== false) profiles.push('logger');
  if (
    services.genblaze === true &&
    config.providers?.gmicloud?.enabled === true &&
    (genBlazeCatalog === undefined || hasValidatedGenBlazeRuntimeCatalog(config, genBlazeCatalog))
  ) {
    profiles.push('genblaze');
  }
  if (services.reverseProxy === true || config.reverseProxy?.enabled === true) {
    profiles.push('reverse-proxy');
  }

  return profiles;
}

function executeDocker(command, args, root, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, COMPOSE_BAKE: 'false' },
      stdio: ['inherit', capture ? 'pipe' : 'inherit', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-64_000);
      if (!capture) process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(stdout);
      const error = new Error(`docker ${args.join(' ')} failed with exit code ${code}: ${stderr.trim()}`);
      error.exitCode = code || 1;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function runDockerCompose(root, rootEnvPath, composeFile, profiles, args) {
  const profileArgs = profiles.flatMap((profile) => ['--profile', profile]);
  await runComposeWithContainerRecovery([
    'compose',
    '--env-file', rootEnvPath,
    '-f', composeFile,
    ...profileArgs,
    ...args,
  ], {
    rootDir: root,
    runCommand: (command, commandArgs) => executeDocker(command, commandArgs, root),
    captureCommand: (command, commandArgs) => executeDocker(command, commandArgs, root, { capture: true }),
    onRecovery: (message) => console.log(`[deploy] ${message}`),
  });
}

async function prepareLocalMongoAuthentication(runCompose, profiles) {
  if (!profiles.includes('local-mongo')) return;

  await runCompose(['local-mongo'], ['stop', 'mongo']);
  await runCompose(['local-mongo'], [
    'rm', '-s', '-f', 'mongo-auth-bootstrap',
  ]);
  await runCompose(['local-mongo'], [
    'up', '--force-recreate', '--no-deps', '--abort-on-container-exit',
    '--exit-code-from', 'mongo-auth-bootstrap', 'mongo-auth-bootstrap',
  ]);
}

async function synchronizeGrafanaAdminPassword(runCompose, profiles) {
  if (!profiles.includes('logger')) return;
  await runCompose(['logger'], [
    'exec',
    '-T',
    'grafana',
    'sh',
    '-ec',
    'grafana cli --homepath /usr/share/grafana admin reset-admin-password "$GF_SECURITY_ADMIN_PASSWORD" >/dev/null',
  ]);
}

export async function startRuntimeServices(profiles, { restart = false, runCompose }) {
  // Finish every image build before stopping or replacing running services.
  if (restart) await runCompose(profiles, ['build']);

  if (!profiles.includes('genblaze')) {
    await runCompose(['genblaze'], ['rm', '-s', '-f', 'genblaze']);
  }
  await prepareLocalMongoAuthentication(runCompose, profiles);
  const genBlazeComposePlan = splitGenBlazeComposeProfiles(profiles);
  await runCompose(genBlazeComposePlan.primaryProfiles, restart
    ? ['up', '-d', '--no-build', '--force-recreate', '--remove-orphans', '--wait', '--wait-timeout', '180']
    : ['up', '-d', '--build', '--force-recreate', '--remove-orphans', '--wait', '--wait-timeout', '180']);
  await synchronizeGrafanaAdminPassword(runCompose, profiles);
  if (profiles.includes('reverse-proxy')) {
    await runCompose(['core', 'reverse-proxy'], [
      'up', '-d', '--no-deps', '--force-recreate', 'reverse-proxy',
    ]);
  }
  if (genBlazeComposePlan.enabled) {
    await runCompose(['genblaze'], restart
      ? ['up', '-d', '--no-deps', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '180', 'genblaze']
      : [...GENBLAZE_FINAL_UP_ARGS, '--force-recreate']);
  }
}

async function main() {
  const action = process.argv[2];
  if (!['config', 'up', 'restart', 'down'].includes(action)) {
    throw new Error('Usage: node scripts/docker-compose-runtime.mjs <config|up|restart|down>');
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const configPath = path.join(root, 'runtime', 'config', 'samsar.config.json');
  const exampleConfigPath = path.join(root, 'samsar.config.example.json');
  const rootEnvPath = path.join(root, 'runtime', 'secrets', 'root.env');
  const genblazeEnvPath = path.join(root, 'runtime', 'secrets', 'genblaze.env');
  const infrastructureEnvPaths = [
    path.join(root, 'runtime', 'secrets', 'application.env'),
    path.join(root, 'runtime', 'secrets', 'mongo.env'),
    path.join(root, 'runtime', 'secrets', 'minio.env'),
    path.join(root, 'runtime', 'secrets', 'grafana.env'),
  ];
  const composeFile = path.join(root, 'deploy', 'compose', 'docker-compose.yml');
  fs.mkdirSync(path.dirname(rootEnvPath), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(rootEnvPath)) fs.writeFileSync(rootEnvPath, '', { mode: 0o600 });
  if (!fs.existsSync(genblazeEnvPath)) fs.writeFileSync(genblazeEnvPath, '', { mode: 0o600 });
  for (const infrastructureEnvPath of infrastructureEnvPaths) {
    if (!fs.existsSync(infrastructureEnvPath)) {
      fs.writeFileSync(infrastructureEnvPath, '', { mode: 0o600 });
    }
  }

  const config = JSON.parse(fs.readFileSync(
    fs.existsSync(configPath) ? configPath : exampleConfigPath,
    'utf8',
  ));
  let genBlazeCatalog = null;
  const genBlazeCatalogPath = path.join(root, 'runtime', 'config', 'genblaze-model-catalog.json');
  try {
    genBlazeCatalog = JSON.parse(fs.readFileSync(genBlazeCatalogPath, 'utf8'));
  } catch {}
  const profiles = action === 'down'
    ? ALL_RUNTIME_COMPOSE_PROFILES
    : getRuntimeComposeProfiles(config, { genBlazeCatalog });

  if (action === 'config') {
    // Resolved Compose output expands env_file values, including credentials.
    // Validate silently so `npm run docker:config` cannot print secrets.
    await runDockerCompose(root, rootEnvPath, composeFile, profiles, ['config', '--quiet']);
    return;
  }
  if (action === 'down') {
    await runDockerCompose(root, rootEnvPath, composeFile, profiles, ['down', '--remove-orphans']);
    return;
  }

  await startRuntimeServices(profiles, {
    restart: action === 'restart',
    runCompose: (selectedProfiles, args) => runDockerCompose(root, rootEnvPath, composeFile, selectedProfiles, args),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  });
}
