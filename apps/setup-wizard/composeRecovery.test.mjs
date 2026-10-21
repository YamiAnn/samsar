import assert from 'node:assert/strict';
import test from 'node:test';
import { runComposeWithContainerRecovery } from './composeRecovery.mjs';

const rootDir = '/workspace/samsar';
const containerId = 'a'.repeat(64);
const args = ['compose', '--env-file', '/runtime/root.env', '-f', '/deploy/compose.yml',
  '--profile', 'core', 'up', '-d', '--build', '--wait'];
const conflict = (id = containerId, name = 'samsar-processor-1') => new Error(
  `Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${id}". You have to remove (or rename) that container to be able to reuse that name.`,
);
const labels = {
  'com.docker.compose.project': 'samsar',
  'com.docker.compose.service': 'processor',
  'com.docker.compose.project.working_dir': rootDir,
};

function fixture({ errors = [], containerLabels = labels, services = 'processor\nclient\n', shouldRecover } = {}) {
  const calls = [];
  const messages = [];
  let attempt = 0;
  return {
    calls, messages,
    run: (commandArgs = args) => runComposeWithContainerRecovery(commandArgs, {
      rootDir,
      shouldRecover,
      onRecovery: (message) => messages.push(message),
      runCommand: async (command, commandArgs) => {
        calls.push({ command, args: commandArgs });
        if (commandArgs.includes('up')) {
          const error = errors[attempt++];
          if (error) throw error;
        }
      },
      captureCommand: async (command, commandArgs) => {
        calls.push({ command, args: commandArgs });
        return commandArgs[0] === 'inspect'
          ? JSON.stringify(typeof containerLabels === 'function' ? containerLabels(commandArgs.at(-1)) : containerLabels)
          : services;
      },
    }),
  };
}

test('successful Compose startup does not inspect or remove containers', async () => {
  const state = fixture();
  await state.run();
  assert.deepEqual(state.calls, [{ command: 'docker', args }]);
});

test('F2P: stale container name is recovered and startup continues without rebuilding', async () => {
  const state = fixture({ errors: [conflict()] });
  await state.run();
  const commands = state.calls.map(({ args }) => args);
  assert.deepEqual(commands[1], ['inspect', '--format', '{{json .Config.Labels}}', containerId]);
  assert.deepEqual(commands[2], [...args.slice(0, args.indexOf('up')), 'config', '--services']);
  assert.deepEqual(commands[3], ['rm', '--force', containerId]);
  const retry = commands[4];
  assert.ok(retry.includes('--force-recreate'));
  assert.ok(retry.includes('--no-build'));
  assert.ok(retry.includes('--wait'));
  assert.ok(!retry.includes('--build'));
  assert.equal(state.messages.length, 1);
  assert.ok(commands.every((command) => !command.includes('-v') && !command.includes('down')));
});

for (const [description, containerLabels, services] of [
  ['another project', { ...labels, 'com.docker.compose.project': 'other' }, 'processor\n'],
  ['another checkout', { ...labels, 'com.docker.compose.project.working_dir': '/other/samsar' }, 'processor\n'],
  ['an inactive service', { ...labels, 'com.docker.compose.service': 'mongo' }, 'processor\n'],
  ['an unlabelled container', {}, 'processor\n'],
]) {
  test(`does not remove a conflicting container belonging to ${description}`, async () => {
    const error = conflict();
    const state = fixture({ errors: [error], containerLabels, services });
    await assert.rejects(state.run(), (result) => result === error);
    assert.ok(!state.calls.some(({ args }) => args[0] === 'rm'));
  });
}

test('real port conflicts and build failures remain failures without deleting containers', async () => {
  for (const message of [
    'ports are not available: listen tcp4 127.0.0.1:27017: bind: address already in use',
    'failed to solve: image build failed',
  ]) {
    const error = new Error(message);
    const state = fixture({ errors: [error] });
    await assert.rejects(state.run(), (result) => result === error);
    assert.equal(state.calls.length, 1);
  }
});

test('does not recover container conflicts from non-startup commands', async () => {
  const error = conflict();
  let calls = 0;
  await assert.rejects(runComposeWithContainerRecovery(['compose', 'down'], {
    rootDir,
    runCommand: async () => { calls += 1; throw error; },
    captureCommand: async () => assert.fail('must not inspect'),
  }), (result) => result === error);
  assert.equal(calls, 1);
});

test('recovery never removes the same container or a replacement with the same name twice', async () => {
  const state = fixture({ errors: [conflict(), conflict()] });
  await assert.rejects(state.run(), /already in use/);
  assert.equal(state.calls.filter(({ args }) => args[0] === 'rm').length, 1);

  const multiple = fixture({ errors: ['a', 'b'].map((letter) => conflict(letter.repeat(64))) });
  await assert.rejects(multiple.run(), /already in use/);
  assert.equal(multiple.calls.filter(({ args }) => args[0] === 'rm').length, 1);
});

test('F2P: recovery covers every conflicting service in a full stack', async () => {
  const serviceNames = Array.from({ length: 20 }, (_, index) => `service-${index}`);
  const state = fixture({
    services: serviceNames.join('\n'),
    containerLabels: (id) => ({
      ...labels, 'com.docker.compose.service': serviceNames[Number.parseInt(id, 16) - 1],
    }),
    errors: serviceNames.map((service, index) => conflict(
      (index + 1).toString(16).padStart(64, '0'), `samsar-${service}-1`,
    )),
  });
  await state.run();
  assert.equal(state.calls.filter(({ args }) => args[0] === 'rm').length, serviceNames.length);
  const starts = state.calls.filter(({ args }) => args.includes('up'));
  assert.equal(starts.length, serviceNames.length + 1);
  assert.ok(starts.slice(1).every(({ args }) => args.includes('--no-build') && !args.includes('--build')));
  assert.ok(state.calls.every(({ args }) => !args.includes('-v') && !args.includes('down')));
});

test('F2P: recognizes Compose working_dir at the nested compose-file directory', async () => {
  const state = fixture({
    errors: [conflict()],
    containerLabels: { ...labels, 'com.docker.compose.project.working_dir': `${rootDir}/deploy/compose` },
  });
  const nestedArgs = [...args];
  nestedArgs[nestedArgs.indexOf('-f') + 1] = `${rootDir}/deploy/compose/docker-compose.yml`;
  await state.run(nestedArgs);
  assert.equal(state.calls.filter(({ args }) => args[0] === 'rm').length, 1);
});

test('recognizes an explicit Compose project directory', async () => {
  const state = fixture({
    errors: [conflict()],
    containerLabels: { ...labels, 'com.docker.compose.project.working_dir': `${rootDir}/runtime` },
  });
  await state.run(['compose', '--project-directory', `${rootDir}/runtime`, ...args.slice(1)]);
  assert.equal(state.calls.filter(({ args }) => args[0] === 'rm').length, 1);
});

test('F2P: recovers conflicts retained in stderr when the displayed error is truncated', async () => {
  const error = new Error('Compose startup failed: progress output after the conflict');
  error.stderr = conflict().message + '\n' + 'Container samsar-client-1 Starting\n'.repeat(100);
  const state = fixture({ errors: [error] });
  await state.run();
  assert.equal(state.calls.filter(({ args }) => args[0] === 'rm').length, 1);
});

test('cancelled setup cannot remove containers or retry', async () => {
  const state = fixture({ errors: [conflict()], shouldRecover: () => false });
  await assert.rejects(state.run(), /already in use/);
  assert.equal(state.calls.length, 1);
});

test('a failed ownership inspection preserves the original error without cleanup', async () => {
  const error = conflict();
  await assert.rejects(runComposeWithContainerRecovery(args, {
    rootDir,
    runCommand: async () => { throw error; },
    captureCommand: async () => { throw new Error('Docker unavailable'); },
  }), (result) => result === error);
});
