import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../packages/maat/bin/maat.mjs', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('maat shows command help', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cli, '--help'], {
    cwd: repositoryRoot,
  });

  assert.match(stdout, /Maat - conversational UI verification/);
  assert.match(stdout, /maat test --suite smoke/);
  assert.match(stdout, /--app-id com\.microsoft\.emmx\.canary/);
});

test('maat rejects unknown commands', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cli, 'unknown'], { cwd: repositoryRoot }),
    /Unknown command: unknown/,
  );
});

test('maat test dispatches the Case runner and preserves failure status', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cli, 'test', '--case', 'does-not-exist'], {
      cwd: repositoryRoot,
    }),
    /Unknown Case: does-not-exist/,
  );
});
