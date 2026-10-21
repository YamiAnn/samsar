import path from 'node:path';
import { realpathSync } from 'node:fs';

// Docker returns the immutable container ID alongside the conflicting name.
// Never infer a deletion target from a name prefix or from a port-bind error.
const CONTAINER_NAME_CONFLICT = /container name ["']\/?([a-z0-9][a-z0-9_.-]*)["'] is already in use by container ["']([a-f0-9]{12,64})["']/i;

function checkoutPath(directory) {
  try {
    return realpathSync(directory);
  } catch {
    return path.resolve(directory);
  }
}

function composeWorkingDirectories(args, rootDir) {
  let composeFile;
  let projectDirectory;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--project-directory') projectDirectory = args[++index];
    else if (arg.startsWith('--project-directory=')) projectDirectory = arg.slice('--project-directory='.length);
    else if (arg === '-f' || arg === '--file') {
      const file = args[++index];
      composeFile ??= file;
    } else if (arg.startsWith('--file=')) composeFile ??= arg.slice('--file='.length);
    else if (arg.startsWith('-f') && arg.length > 2) composeFile ??= arg.slice(2);
  }
  // Compose defaults working_dir to the first compose file's directory, even
  // when Docker was launched from the repository root. Older runs may use root.
  const directory = projectDirectory || (composeFile && path.dirname(composeFile)) || '.';
  return new Set([checkoutPath(rootDir), checkoutPath(path.resolve(rootDir, directory))]);
}

export async function runComposeWithContainerRecovery(args, {
  runCommand,
  captureCommand,
  rootDir,
  projectName = 'samsar',
  onRecovery = () => {},
  shouldRecover = () => true,
}) {
  const upIndex = args.indexOf('up');
  const removed = new Set();
  const removedNames = new Set();
  const workingDirectories = composeWorkingDirectories(args.slice(0, upIndex), rootDir);
  let services;
  let startupArgs = args;

  while (true) {
    try {
      return await runCommand('docker', startupArgs);
    } catch (error) {
      const conflict = CONTAINER_NAME_CONFLICT.exec(`${error?.stderr || ''}\n${error?.message || ''}`);
      if (args[0] !== 'compose' || upIndex < 0 || !conflict ||
          removed.has(conflict[2]) || removedNames.has(conflict[1]) || !shouldRecover()) {
        throw error;
      }
      const [, name, containerId] = conflict;
      let labels;
      try {
        // Only read labels: inspecting the full container could expose its env.
        labels = JSON.parse(await captureCommand('docker', [
          'inspect', '--format', '{{json .Config.Labels}}', containerId,
        ]));
        services ??= (await captureCommand('docker', [
          ...args.slice(0, upIndex), 'config', '--services',
        ])).trim().split(/\s+/);
      } catch {
        throw error;
      }
      const workingDir = labels?.['com.docker.compose.project.working_dir'];
      if (labels?.['com.docker.compose.project'] !== projectName ||
          !services.includes(labels?.['com.docker.compose.service']) ||
          !workingDir || !workingDirectories.has(checkoutPath(workingDir)) ||
          !shouldRecover()) {
        throw error;
      }

      onRecovery(`Recreating existing Samsar container ${name}; keeping its data volumes.`);
      await runCommand('docker', ['rm', '--force', containerId]);
      removed.add(containerId);
      // Cover the entire stack, but stop if another deployment replaces a
      // container with this same name while recovery is running.
      removedNames.add(name);

      // Compose builds before creating containers. Reuse those images on retry.
      startupArgs = args.filter((arg) => arg !== '--build');
      const retryOptions = ['--force-recreate', '--no-build']
        .filter((arg) => !startupArgs.includes(arg));
      startupArgs.splice(upIndex + 1, 0, ...retryOptions);
    }
  }
}
