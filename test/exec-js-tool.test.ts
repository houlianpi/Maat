import assert from 'node:assert/strict';
import test from 'node:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { createExecJsTool } from '../packages/pi/src/tools/exec-js-tool.ts';
import { createPlatformTools } from '../packages/pi/src/tools/platform-tools.ts';
import { createMaat } from '../packages/core/src/api/create-maat.ts';
import { isRecord } from '../packages/core/src/core/exploration/protocol.ts';
import {
  ExplorationExecutionError,
  WorkerTerminatedError,
  type JavaScriptSession,
} from '../packages/core/src/core/exploration/runtime.ts';

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

test('list_platforms exposes mobile control-first strategies in model-visible content', async () => {
  const maat = createMaat();
  try {
    const tool = createPlatformTools(maat).find((item) => item.name === 'list_platforms');
    assert.ok(tool);
    const result = await tool.execute(
      'context',
      {},
      undefined,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    );
    const text = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    const platforms: unknown = JSON.parse(text);
    assert.ok(Array.isArray(platforms));
    for (const id of ['android', 'ios']) {
      const platform = platforms.find((item: unknown) => isRecord(item) && item.id === id);
      assert.ok(
        isRecord(platform) &&
          isRecord(platform.codeContext) &&
          Array.isArray(platform.codeContext.guidelines),
      );
      assert.ok(platform.codeContext.guidelines.every((line: unknown) => typeof line === 'string'));
      const guidelines = platform.codeContext.guidelines.join('\n');
      assert.match(guidelines, /Generate Appium JavaScript for exe_js/);
      assert.match(guidelines, /Controls first/);
      assert.match(guidelines, /Only use visual absolute-coordinate actions when/);
      assert.match(guidelines, /Appium viewport units/);
    }
  } finally {
    await maat.close();
  }
});

test('exe_js leaves control and permitted coordinate choices in the supplied JavaScript', async () => {
  const calls: string[] = [];
  const signal = new AbortController().signal;
  const tool = createExecJsTool({
    close: async () => {},
    execute: async (code, receivedSignal) => {
      assert.equal(receivedSignal, signal);
      calls.push(code);
      return [{ type: 'text', text: 'current observation' }];
    },
  });
  const code = [
    "await driver.$('~observed-control').click();",
    "await driver.execute('mobile: tap', {x: 10, y: 20});",
  ];
  for (const input of code) {
    const result = await tool.execute(
      'generated',
      { code: input },
      signal,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    );
    assert.deepEqual(result.content, [{ type: 'text', text: 'current observation' }]);
  }
  assert.deepEqual(calls, code);
});

test('exe_js classifies an unknown execution failure without a success fallback', async () => {
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
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, primary);
      assert.match(error.message, /category: unknown/);
      assert.match(error.message, /actionState: uncertain/);
      assert.match(error.message, /Do not replay this code/);
      return true;
    },
  );
});

test('exe_js gives the model safe recovery for compile and runtime failures', async () => {
  const failures = [
    {
      error: new ExplorationExecutionError('Unexpected token', {
        name: 'SyntaxError',
        message: 'Unexpected token',
        category: 'syntax-error',
        phase: 'compile',
        actionState: 'not-started',
      }),
      expected: [/category: syntax-error/, /No UI action ran/, /session: reusable/],
    },
    {
      error: new ExplorationExecutionError('setTimeout is not defined', {
        name: 'ReferenceError',
        message: 'setTimeout is not defined',
        category: 'reference-error',
        phase: 'execute',
        actionState: 'uncertain',
      }),
      expected: [/category: reference-error/, /driver\.pause/, /Do not replay/],
    },
    {
      error: new ExplorationExecutionError('globalThis.slowScroll is not a function', {
        name: 'TypeError',
        message: 'globalThis.slowScroll is not a function',
        category: 'type-error',
        phase: 'execute',
        actionState: 'uncertain',
      }),
      expected: [/category: type-error/, /earlier exe_js call do not persist/, /read-only exe_js/],
    },
    {
      error: new WorkerTerminatedError('Exploration execution exceeded 60000ms.'),
      expected: [/category: execution-terminated/, /session: closed/, /actionState: uncertain/],
    },
  ];

  for (const failure of failures) {
    const tool = createExecJsTool({
      close: async () => {},
      execute: async () => {
        throw failure.error;
      },
    });

    await assert.rejects(
      tool.execute(
        'classified',
        { code: 'broken()' },
        undefined,
        undefined,
        {} as Parameters<typeof tool.execute>[4],
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, failure.error);
        for (const expected of failure.expected) assert.match(error.message, expected);
        return true;
      },
    );
  }
});

test('exe_js classifies a mobile slot conflict as not-started without exposing request data', async () => {
  const busy = Object.assign(new Error('Another mobile operation is already in progress.'), {
    code: 'mobile-busy',
  });
  const tool = createExecJsTool({
    close: async () => {},
    execute: async () => {
      throw busy;
    },
  });
  await assert.rejects(
    tool.execute(
      'busy',
      { code: 'secret javascript' },
      undefined,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /category: mobile-busy/);
      assert.match(error.message, /code: mobile-busy/);
      assert.match(error.message, /actionState: not-started/);
      assert.match(error.message, /Wait for the current mobile operation to settle/);
      assert.doesNotMatch(error.message, /secret javascript|device|endpoint|session id/i);
      return true;
    },
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
