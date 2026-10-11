import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createExplorationWorker } from '../packages/core/src/core/exploration/worker-client.ts';
import { ExplorationExecutionError } from '../packages/core/src/core/exploration/runtime.ts';

test('closing a Worker leaves no deadline timers delaying parent process exit', async () => {
  const workerModule = new URL(
    '../packages/core/src/core/exploration/worker-client.ts',
    import.meta.url,
  ).href;
  const runtimeModule = new URL('./fixtures/execution-runtime.ts', import.meta.url).href;
  const source = `
    import { createExplorationWorker } from ${JSON.stringify(workerModule)};
    const session = await createExplorationWorker(new URL(${JSON.stringify(runtimeModule)}), {});
    await Promise.all([session.close(), session.close()]);
    console.log('closed');
  `;
  const result = await promisify(execFile)(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', source],
    { timeout: 1_800, maxBuffer: 16 * 1024 },
  );
  assert.equal(result.stdout.trim(), 'closed');
});

test('initialization failure is not a reusable execution error', async () => {
  await assert.rejects(
    createExplorationWorker(
      new URL('./fixtures/execution-runtime.ts', import.meta.url),
      { failInitialization: true },
      5_000,
      5_000,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof ExplorationExecutionError, false);
      assert.match(error.message, /Exploration initialization failed/);
      assert.match(error.message, /Fixture runtime initialization failed/);
      return true;
    },
  );
});

test('Worker classifies failures without replaying uncertain execution', async () => {
  const session = await createExplorationWorker(
    new URL('./fixtures/execution-runtime.ts', import.meta.url),
    {},
    5_000,
    5_000,
  );
  try {
    await assert.rejects(session.execute('const broken: = 1;'), (error: unknown) => {
      assert.ok(error instanceof ExplorationExecutionError);
      assert.equal(error.details.category, 'syntax-error');
      assert.equal(error.details.phase, 'compile');
      assert.equal(error.details.actionState, 'not-started');
      return true;
    });
    await assert.rejects(session.execute('setTimeout(() => {}, 1);'), (error: unknown) => {
      assert.ok(error instanceof ExplorationExecutionError);
      assert.equal(error.details.category, 'reference-error');
      assert.equal(error.details.phase, 'execute');
      assert.equal(error.details.actionState, 'uncertain');
      return true;
    });
    await assert.rejects(
      session.execute(`state.set('possibly changed'); globalThis.slowScroll();`),
      (error: unknown) => {
        assert.ok(error instanceof ExplorationExecutionError);
        assert.equal(error.details.category, 'type-error');
        assert.equal(error.details.actionState, 'uncertain');
        return true;
      },
    );
    assert.deepEqual(await session.execute(`console.log(state.get());`), [
      { type: 'text', text: 'possibly changed' },
    ]);
  } finally {
    await session.close();
  }
});
