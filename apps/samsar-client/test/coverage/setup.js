import { afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

afterAll(() => {
  const directory = resolve(process.cwd(), 'coverage/raw');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, `unit-${randomUUID()}.json`), JSON.stringify(globalThis.__coverage__ || {}));
});
