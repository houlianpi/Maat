import assert from 'node:assert/strict';
import test from 'node:test';

import { createExecJsTool } from '../src/tools/exec-js-tool.ts';
import type { StepRecorder } from '../src/recording/run-recorder.ts';
import type { JavaScriptSession } from '../src/worker/javascript-session.ts';

test('exe_js exposes the JavaScript execution contract', async () => {
  const session: JavaScriptSession = {
    close: async () => undefined,
    execute: async () => [{ type: 'text', text: 'tool-result' }],
  };
  const recorded: string[] = [];
  const recorder: StepRecorder = {
    async recordFailedStep() {},
    async recordSuccessfulStep(code) {
      recorded.push(code);
    },
  };
  const tool = createExecJsTool(session, recorder);

  const result = await tool.execute(
    'tool-call-1',
    { code: `console.log('tool-result');` },
    undefined,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );

  assert.equal(tool.name, 'exe_js');
  assert.ok(
    tool.promptGuidelines?.some((guideline) =>
      guideline.includes("user's explicit test objective"),
    ),
  );
  assert.deepEqual(result.content, [{ type: 'text', text: 'tool-result' }]);
  assert.deepEqual(result.details, { observationCount: 1 });
  assert.deepEqual(recorded, [`console.log('tool-result');`]);
});

test('exe_js does not record failed code', async () => {
  const session: JavaScriptSession = {
    close: async () => undefined,
    execute: async () => {
      throw new Error('execution failed');
    },
  };
  let recorded = false;
  let failedRecorded = false;
  const tool = createExecJsTool(session, {
    async recordFailedStep() {
      failedRecorded = true;
    },
    async recordSuccessfulStep() {
      recorded = true;
    },
  });

  await assert.rejects(
    tool.execute(
      'tool-call-2',
      { code: 'broken()' },
      undefined,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    ),
    /execution failed/,
  );
  assert.equal(recorded, false);
  assert.equal(failedRecorded, true);
});
