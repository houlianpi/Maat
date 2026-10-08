import assert from 'node:assert/strict';
import test from 'node:test';

import { createExecJsTool } from '../packages/pi/src/tools/exec-js-tool.ts';
import type { StepRecorder } from '../packages/core/src/core/cases/step-recorder.ts';
import type { JavaScriptSession } from '../packages/core/src/core/exploration/runtime.ts';

test('exe_js exposes the JavaScript execution contract', async () => {
  const session: JavaScriptSession = {
    close: async () => undefined,
    execute: async () => [{ type: 'text', text: 'tool-result' }],
  };
  const recorded: string[] = [];
  const recorder: StepRecorder = {
    async recordFailedStep() {},
    async recordSuccessfulStep(code, _observations, _execution, name) {
      recorded.push(`${name}:${code}`);
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
  assert.deepEqual(result.details, { observationCount: 1, recorded: false });
  assert.deepEqual(recorded, []);

  const recordedResult = await tool.execute(
    'tool-call-record',
    { code: `console.log('tool-result');`, record: true, stepName: 'Verify result' },
    undefined,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );
  assert.deepEqual(recordedResult.details, { observationCount: 1, recorded: true });
  assert.deepEqual(recorded, [`Verify result:console.log('tool-result');`]);

  await assert.rejects(
    tool.execute(
      'tool-call-missing-name',
      { code: 'void 0;', record: true },
      undefined,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    ),
    /stepName is required/,
  );
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
