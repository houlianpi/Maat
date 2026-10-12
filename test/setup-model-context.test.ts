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
import { createMaatPiTools } from '../packages/pi/src/tools.ts';
import { MobilePreparation } from '../packages/pi/src/mobile-preparation.ts';
import { setupAgentContext } from '../packages/pi/src/setup-ui.ts';

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
function response(final: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: 'done',
    reason: final.stopReason === 'toolUse' ? 'toolUse' : 'stop',
    message: final,
  });
  return stream;
}

for (const [platform, prepareAvailable, locale] of (
  [
    ['android', false],
    ['android', true],
    ['ios', false],
    ['ios', true],
  ] as const
).flatMap(([platform, prepareAvailable]) =>
  (['en', 'zh-CN'] as const).map((locale) => [platform, prepareAvailable, locale] as const),
)) {
  test(`${platform} mocked SDK agent-loop model content retains categories, connection policy and host availability (${prepareAvailable}, ${locale})`, async () => {
    const maat = createMaat();
    const snapshot = aggregateSetup({
      platform,
      capabilities: [
        {
          id: 'appiumServer',
          required: true,
          status: 'action-required',
          messageKey: 'capability.appium.start',
          errorCode: 'APPIUM_SERVER_UNAVAILABLE',
          action: {
            id: 'start-appium',
            labelKey: 'action.startAppium',
            command: 'appium --address 127.0.0.1 --port 4723',
          },
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
    const preparation = prepareAvailable ? new MobilePreparation(maat) : undefined;
    const tools = createMaatPiTools(maat, preparation);
    assert.equal(
      tools.some((item) => item.name === 'prepare_mobile'),
      prepareAvailable,
    );
    const tool = tools.find((item) => item.name === 'check_platform_setup');
    assert.ok(tool);
    const hostContext = {
      sessionManager: {
        getEntries: () => [
          {
            type: 'message',
            message: {
              role: 'user',
              content: locale === 'zh-CN' ? '请继续手机任务' : 'Continue my phone task',
            },
          },
        ],
      },
    } as unknown as ExtensionContext;
    let requests = 0;
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
              tool.execute(id, params, signal, undefined, hostContext),
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
          if (platform === 'android') {
            assert.match(text, /ANDROID_SDK_INVALID/);
            assert.match(text, /"toolsSource":"managed"/);
          } else {
            assert.match(text, /"platform":"ios"/);
            assert.match(text, /IOS_DEVICE_LOCK_STATE_UNKNOWN/);
            assert.match(text, /allowWdaInstallation/);
            assert.doesNotMatch(text, /allowWdaInitialization/);
            assert.match(
              text,
              /默认允许建立必要控制连接|allow necessary control connection initialization by default/,
            );
            assert.match(
              text,
              /已有有效构建和手机 helper 时直接|current valid build and existing phone helper/,
            );
            assert.match(text, /无 source、截图或业务 UI|no source, screenshot or business UI/);
            assert.match(text, /不自动勾选|never auto-select/);
            for (const code of [
              'IOS_WDA_INSTALLATION_AUTHORIZATION_REQUIRED',
              'IOS_WDA_SIGNING_REQUIRED',
              'IOS_WDA_INSPECTION_FAILED',
              'IOS_CONNECTION_INITIALIZATION_DISABLED',
              'IOS_WDA_CONFIGURATION_CONFLICT',
              'IOS_READINESS_UNSUPPORTED',
              'IOS_WDA_SECURITY_REJECTED',
            ])
              assert.ok(text.includes(code), code);
            assert.match(
              text,
              /不自动改配置、重装、改 Team|do not automatically change configuration, reinstall, change Team/,
            );
            assert.doesNotMatch(text, /android-tools\.mjs|"toolsSource"|Maat · macOS/);
          }
          assert.doesNotMatch(text, /private-sdk|private-value|never-show/);
          assert.doesNotMatch(
            text,
            /appium --address|android-tools\.mjs.*appium|host-supported.*background/,
          );
          const facts = JSON.parse(text.split('Maat setup facts:\n')[1]!);
          if (prepareAvailable) {
            assert.equal(facts.serviceStartup.status, 'available');
            assert.equal(facts.nextStep.tool, 'prepare_mobile');
            assert.deepEqual(facts.nextStep.arguments, {
              action: 'start-appium',
              taskId: null,
              waitSeconds: 20,
            });
            assert.match(facts.serviceStartup.instruction, /same returned taskId/);
            assert.match(facts.serviceStartup.instruction, /action:"status"/);
            assert.match(facts.serviceStartup.instruction, /not deviceReady/);
          } else {
            assert.equal(facts.serviceStartup.status, 'unavailable');
            assert.equal(facts.serviceStartup.category, 'HOST_TRACKED_PREPARATION_UNAVAILABLE');
            assert.doesNotMatch(text, /prepare_mobile/);
            assert.match(facts.nextStep.instruction, /Autonomous Appium startup is unavailable/);
          }
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
                    arguments: { platform },
                  },
                ],
                'toolUse',
              )
            : message([{ type: 'text', text: 'Setup category is visible.' }], 'stop');
        return response(final);
      },
    });
    try {
      await agent.prompt(`Prepare my ${platform} phone.`);
      assert.equal(requests, 2);
    } finally {
      await maat.close();
      await preparation?.close();
    }
  });
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`mocked SDK model content retains primary iOS readiness errors and ${locale} recovery, never retries UI`, async () => {
    const maat = createMaat();
    await maat.platforms.select('ios');
    const tool = createMaatPiTools(maat).find((item) => item.name === 'check_device_ready')!;
    const hostContext = {
      sessionManager: {
        getEntries: () => [
          {
            type: 'message',
            message: {
              role: 'user',
              content: locale === 'zh-CN' ? '请继续计算器任务' : 'Continue the Calculator task',
            },
          },
        ],
      },
    } as unknown as ExtensionContext;
    try {
      for (const code of [
        'IOS_DEVICE_LOCK_STATE_UNKNOWN',
        'IOS_DEVICE_LOCKED',
        'IOS_WDA_INSTALLATION_AUTHORIZATION_REQUIRED',
        'IOS_WDA_SIGNING_REQUIRED',
        'IOS_WDA_INSPECTION_FAILED',
        'IOS_CONNECTION_INITIALIZATION_DISABLED',
        'IOS_WDA_CONFIGURATION_CONFLICT',
        'IOS_READINESS_UNSUPPORTED',
        'IOS_WDA_SECURITY_REJECTED',
      ]) {
        const original = `${code}: synthetic primary failure retained`;
        let readyCalls = 0;
        let requests = 0;
        maat.setup.ready = async (input) => {
          readyCalls += 1;
          assert.equal(input?.allowWdaInstallation, undefined);
          assert.equal('allowWdaInitialization' in (input ?? {}), false);
          throw new Error(original);
        };
        const agent = new Agent({
          initialState: {
            model,
            tools: [
              {
                name: tool.name,
                label: tool.label,
                description: tool.description!,
                parameters: tool.parameters,
                execute: (id, params, signal) =>
                  tool.execute(id, params, signal, undefined, hostContext),
              },
            ],
          },
          streamFn: (_model, context) => {
            requests += 1;
            if (requests === 1) {
              // Pi 0.87 normalizes tool declarations into system transcript messages.
              const declarations = context.messages.flatMap((item) =>
                item.role === 'system' ? (item.toolsAdded ?? []) : [],
              );
              assert.equal(declarations.length, 1);
              assert.match(JSON.stringify(declarations), /allowWdaInstallation/);
              assert.doesNotMatch(JSON.stringify(declarations), /allowWdaInitialization/);
              return response(
                message(
                  [
                    {
                      type: 'toolCall',
                      id: 'ready',
                      name: tool.name,
                      arguments: { screenshot: true },
                    },
                  ],
                  'toolUse',
                ),
              );
            }
            const result = context.messages.find((item) => item.role === 'toolResult');
            assert.ok(result && result.role === 'toolResult');
            assert.equal(result.isError, true);
            const content = result.content
              .filter((item) => item.type === 'text')
              .map((item) => item.text)
              .join('\n');
            assert.ok(content.includes(original));
            assert.ok(content.includes(code));
            assert.match(
              content,
              locale === 'zh-CN'
                ? /所选|连接|签名|配置|本人|iOS 拒绝/
                : /selected|connection|signing|configuration|yourself|iOS rejected/,
            );
            assert.doesNotMatch(content, /allowWdaInitialization|<App\/>|phoneUnlocked.*true/);
            if (code === 'IOS_DEVICE_LOCK_STATE_UNKNOWN') {
              assert.match(
                content,
                /不读取 source、截图或执行业务 UI|do not read source, take screenshots or perform business UI/,
              );
            }
            if (code === 'IOS_WDA_CONFIGURATION_CONFLICT' || code === 'IOS_READINESS_UNSUPPORTED') {
              assert.match(
                content,
                /不自动.*重装.*改 Team|Do not automatically.*reinstall.*change Team/,
              );
            }
            return response(
              message([{ type: 'text', text: 'Synthetic recovery context inspected.' }], 'stop'),
            );
          },
        });
        await agent.prompt(
          locale === 'zh-CN' ? '请继续计算器任务' : 'Continue the Calculator task',
        );
        assert.equal(requests, 2, JSON.stringify(agent.state.messages));
        assert.equal(readyCalls, 1);
      }
    } finally {
      await maat.close();
    }
  });
}

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
