import assert from 'node:assert/strict';
import test from 'node:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { createExecJsTool } from '../packages/pi/src/tools/exec-js-tool.ts';
import type { JavaScriptSession } from '../packages/core/src/core/exploration/runtime.ts';

test('exe_js returns observations and exposes only the execution input', async () => {
  const session: JavaScriptSession = {
    close: async () => {},
    execute: async () => [{ type: 'text', text: 'observed' }],
  };
  const tool = createExecJsTool(session);
  const call = { type: 'toolCall' as const, id: 'input', name: 'exe_js' };
  const schema = {
    name: tool.name,
    description: 'Execute JavaScript',
    parameters: tool.parameters,
  };
  assert.deepEqual(validateToolArguments(schema, { ...call, arguments: { code: 'void 0' } }), {
    code: 'void 0',
  });
  assert.throws(() =>
    validateToolArguments(schema, { ...call, arguments: { code: 'void 0', record: true } }),
  );
  assert.throws(() =>
    validateToolArguments(schema, { ...call, arguments: { code: 'void 0', stepName: 'old step' } }),
  );
  const result = await tool.execute(
    'execution',
    { code: 'console.log("observed")' },
    undefined,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );
  assert.deepEqual(result.content, [{ type: 'text', text: 'observed' }]);
  assert.deepEqual(result.details, { observationCount: 1 });
});

test('exe_js preserves execution failure without a recorder or fallback', async () => {
  const primary = new Error('execution failed');
  const tool = createExecJsTool({
    close: async () => {},
    execute: async () => {
      throw primary;
    },
  });
  await assert.rejects(
    tool.execute(
      'failure',
      { code: 'broken()' },
      undefined,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    ),
    (error: unknown) => error === primary,
  );
});

test('supplemental diagnosis retains the primary error and cancellation signal', async () => {
  const primary = new Error('ECONNREFUSED: original execution failure');
  const signal = new AbortController().signal;
  const tool = createExecJsTool(
    {
      close: async () => {},
      execute: async () => {
        throw primary;
      },
    },
    undefined,
    async (error, _ctx, diagnosticSignal) => {
      assert.equal(error, primary);
      assert.equal(diagnosticSignal, signal);
      throw new Error('diagnostic probe failed');
    },
  );
  await assert.rejects(
    tool.execute(
      'double-failure',
      { code: 'void 0' },
      signal,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, primary);
      assert.match(error.message, /original execution failure/);
      assert.match(error.message, /diagnostic probe failed/);
      return true;
    },
  );
});
