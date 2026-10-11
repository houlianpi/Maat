import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createMaat } from '../packages/core/src/api/create-maat.ts';
import { aggregateSetup } from '../packages/core/src/setup-assistant/model.ts';
import { createSetupTools } from '../packages/pi/src/tools/setup-tools.ts';
import { setupAgentContext } from '../packages/pi/src/setup-ui.ts';

test('actual agent-loop model context retains setup categories and actions without MCP-only fields', async () => {
  const maat = createMaat();
  const snapshot = aggregateSetup({
    platform: 'android',
    capabilities: [
      {
        id: 'appiumServer',
        required: true,
        status: 'action-required',
        messageKey: 'capability.appium.start',
        errorCode: 'APPIUM_SERVER_UNAVAILABLE',
        action: { id: 'start-appium', labelKey: 'action.startAppium' },
      },
    ],
    technicalDetails: {
      androidToolsSource: 'managed',
      androidToolsWarnings: [
        { code: 'ANDROID_SDK_INVALID', summary: '/Users/private-sdk password=private-value' },
      ],
      secret: 'never-show',
    },
  });
  maat.setup.check = async () => snapshot;
  const tool = createSetupTools(maat).find((item) => item.name === 'check_platform_setup');
  assert.ok(tool);
  const model: Model<'openai-completions'> = {
    id: 'context-test',
    name: 'Context test',
    api: 'openai-completions',
    provider: 'test',
    baseUrl: 'http://127.0.0.1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16384,
    maxTokens: 1024,
  };
  let requests = 0;
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
  const agent = new Agent({
    initialState: {
      model,
      tools: [
        {
          name: tool.name,
          label: tool.label,
          description: tool.description ?? 'Check setup',
          parameters: tool.parameters,
          execute: (id, params, signal) =>
            tool.execute(id, params, signal, undefined, {} as ExtensionContext),
        },
      ],
    },
    streamFn: (_model, context) => {
      requests += 1;
      if (requests === 2) {
        const result = context.messages.find((item) => item.role === 'toolResult');
        assert.ok(result && result.role === 'toolResult');
        const text = result.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n');
        assert.match(text, /APPIUM_SERVER_UNAVAILABLE/);
        assert.match(text, /ANDROID_SDK_INVALID/);
        assert.match(text, /"toolsSource":"managed"/);
        assert.match(text, /android-tools\.mjs/);
        assert.doesNotMatch(text, /private-sdk|private-value|never-show/);
        assert.equal('structuredContent' in result, false);
      }
      const final =
        requests === 1
          ? message(
              [
                {
                  type: 'toolCall',
                  id: 'diagnose',
                  name: tool.name,
                  arguments: { platform: 'android' },
                },
              ],
              'toolUse',
            )
          : message([{ type: 'text', text: 'Setup category is visible.' }], 'stop');
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: 'done',
        reason: final.stopReason === 'toolUse' ? 'toolUse' : 'stop',
        message: final,
      });
      return stream;
    },
  });
  try {
    await agent.prompt('Prepare my phone.');
    assert.equal(requests, 2);
  } finally {
    await maat.close();
  }
});

test('model setup context does not tell a ready macOS caller to use the Android-only readiness tool', () => {
  const snapshot = aggregateSetup({
    platform: 'macos',
    capabilities: [
      {
        id: 'appiumServer',
        status: 'ready',
        required: true,
        messageKey: 'capability.appium.ready',
      },
    ],
  });

  assert.match(setupAgentContext(snapshot), /"tool":"exe_js"/);
  assert.doesNotMatch(setupAgentContext(snapshot), /"tool":"check_device_ready"/);
});

test('blocked macOS startup uses its own action instead of Android preparation', () => {
  const snapshot = aggregateSetup({
    platform: 'macos',
    capabilities: [
      {
        id: 'appiumServer',
        status: 'action-required',
        required: true,
        messageKey: 'capability.appium.start',
        action: {
          id: 'start-appium',
          labelKey: 'action.startAppium',
          command: 'appium --address 127.0.0.1 --port 4723',
        },
      },
    ],
  });
  const facts = setupAgentContext(snapshot);
  assert.match(facts, /appium --address/);
  assert.doesNotMatch(facts, /android-tools\.mjs/);
});
