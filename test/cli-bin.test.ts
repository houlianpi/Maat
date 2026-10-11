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

  assert.match(stdout, /Maat - UI execution for Coding Agents/);
  assert.match(stdout, /maat agent/);
  assert.doesNotMatch(stdout, /maat (test|cases|replay)/);
});

test('maat rejects unknown commands', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cli, 'unknown'], { cwd: repositoryRoot }),
    /Unknown command: unknown/,
  );
});

test('removed formal-test and replay commands fail explicitly', async () => {
  for (const command of ['test', 'cases', 'replay'])
    await assert.rejects(
      execFileAsync(process.execPath, [cli, command], { cwd: repositoryRoot }),
      new RegExp(`Unknown command: ${command}`),
    );
});
