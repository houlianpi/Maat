import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import { WorkerTerminatedError } from '../packages/core/src/core/exploration/runtime.ts';
import { createExecJsTool } from '../packages/pi/src/tools/exec-js-tool.ts';

test('Maat tool failure stays model-visible without terminating the Pi session', async () => {
  const model: Model<'openai-completions'> = {
    id: 'session-isolation-test',
    name: 'Session isolation test',
    api: 'openai-completions',
    provider: 'test',
    baseUrl: 'http://127.0.0.1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 1_024,
  };
  const message = (
    content: AssistantMessage['content'],
    stopReason: 'toolUse' | 'stop',
  ): AssistantMessage => ({
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const tool = createExecJsTool({
    close: async () => {},
    execute: async () => {
      throw new WorkerTerminatedError('Exploration Worker exited unexpectedly.');
    },
  });
  let requests = 0;
  const agent = new Agent({
    initialState: {
      model,
      tools: [
        {
          name: tool.name,
          label: tool.label,
          description: tool.description ?? 'Execute JavaScript',
          parameters: tool.parameters,
          execute: (id, params, signal, update) =>
            tool.execute(
              id,
              params,
              signal,
              update,
              {} as Parameters<typeof tool.execute>[4],
            ),
        },
      ],
    },
    streamFn: (_model, context) => {
      requests++;
      let response: AssistantMessage;
      if (requests === 1) {
        response = message(
          [
            {
              type: 'toolCall',
              id: 'maat-failure',
              name: 'exe_js',
              arguments: { code: 'while (true) {}' },
            },
          ],
          'toolUse',
        );
      } else if (requests === 2) {
        const result = context.messages.find(
          (item) => item.role === 'toolResult' && item.toolCallId === 'maat-failure',
        );
        assert.ok(result && result.role === 'toolResult');
        assert.equal(result.isError, true);
        assert.match(
          result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n'),
          /MAAT_EXECUTION_FAILED[\s\S]*category: execution-terminated[\s\S]*session: closed/,
        );
        response = message([{ type: 'text', text: 'Recovered in the same turn.' }], 'stop');
      } else {
        response = message([{ type: 'text', text: 'The next turn still works.' }], 'stop');
      }
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: 'done',
        reason: response.stopReason === 'toolUse' ? 'toolUse' : 'stop',
        message: response,
      });
      return stream;
    },
  });

  await agent.prompt('Trigger the Maat failure.');
  await agent.prompt('Continue after the failure.');

  assert.equal(requests, 3);
  assert.equal(agent.state.errorMessage, undefined);
  const assistantText = agent.state.messages
    .filter((item) => item.role === 'assistant')
    .flatMap((item) => item.content)
    .filter((item) => item.type === 'text')
    .map((item) => item.text);
  assert.ok(assistantText.includes('Recovered in the same turn.'));
  assert.ok(assistantText.includes('The next turn still works.'));
});
