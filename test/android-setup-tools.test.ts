import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { MaatApi } from '../packages/core/src/api/maat-api.ts';
import { aggregateSetup } from '../packages/core/src/setup-assistant/model.ts';
import { PlatformRegistry } from '../packages/core/src/core/platforms/registry.ts';
import type { PlatformAdapter } from '../packages/core/src/core/platforms/contracts.ts';
import { createSetupTools } from '../packages/pi/src/tools/setup-tools.ts';
import { createPlatformTools } from '../packages/pi/src/tools/platform-tools.ts';
import { registerMaatSetupCommands } from '../packages/pi/src/setup-extension.ts';

function fixture() {
  const adapter: PlatformAdapter = {
    id: 'android',
    label: 'Android',
    codeContext: { language: 'javascript', globals: [], guidelines: [] },
    initialize: async () => {},
    execute: async () => [],
    status: () => ({
      id: 'android',
      label: 'Android',
      session: 'idle',
    }),
    close: async () => {},
  };
  const maat = new MaatApi(new PlatformRegistry([adapter], 'android'), '/tmp/maat-android-setup');
  const snapshot = aggregateSetup({
    platform: 'android',
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
        },
      },
    ],
  });
  const checks: Array<Parameters<typeof maat.setup.check>[0]> = [];
  maat.setup.check = async (input) => {
    checks.push(input);
    return snapshot;
  };
  maat.setup.current = () => snapshot;
  const ctx = {
    mode: 'print',
    waitForIdle: async () => {},
    sessionManager: {
      getEntries: () => [
        { type: 'message', message: { role: 'user', content: '帮我准备 Android 手机' } },
      ],
    },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
  return { maat, checks, ctx };
}

test('Android setup and diagnostics remain on Android and propagate cancellation', async () => {
  const { maat, checks, ctx } = fixture();
  const signal = new AbortController().signal;
  for (const name of ['check_platform_setup', 'retry_setup_step', 'get_setup_diagnostics']) {
    const tool = createSetupTools(maat).find((item) => item.name === name);
    assert.ok(tool);
    const result = await tool.execute('check', {}, signal, undefined, ctx);
    assert.equal(checks.at(-1)?.platform, 'android');
    assert.equal(checks.at(-1)?.signal, signal);
    const text = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    assert.match(text, /Maat · Android/);
    assert.match(text, /APPIUM_SERVER_UNAVAILABLE/);
    assert.match(text, /"status":"action-required"/);
    assert.doesNotMatch(text, /macOS|开始测试/);
  }
  assert.equal('cases' in maat, false);
});

test('Android preparation instructions do not launch a service or mutate preferences', async () => {
  const { maat, ctx } = fixture();
  maat.setup.action = async () => {
    throw new Error('Android instructions must not enter the macOS preference workflow.');
  };
  const tool = createSetupTools(maat).find((item) => item.name === 'open_setup_step');
  assert.ok(tool);
  const result = await tool.execute('step', {}, undefined, undefined, ctx);
  const text = result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  assert.match(text, /maat-setup Skill/);
  assert.doesNotMatch(text, /appium --address/);
  assert.match(text, /尚未执行任何系统修改/);
  await assert.rejects(
    tool.execute('step', { actionId: 'not-a-step' }, undefined, undefined, ctx),
    /no matching preparation step/,
  );
});

test('Android readiness forwards observations without formal persistence and exposes failure', async () => {
  const { maat, ctx } = fixture();
  const signal = new AbortController().signal;
  let requestedScreenshot: boolean | undefined;
  maat.setup.ready = async (input = {}) => {
    assert.equal(input.signal, signal);
    requestedScreenshot = input.screenshot;
    return {
      platform: 'android',
      ready: true,
      proof: {
        phoneUnlocked: true,
        sessionUsable: true,
        sourceReadable: true,
        viewportReadable: true,
        screenshotReadable: input.screenshot === true,
      },
      observations: [
        { type: 'text', text: '<hierarchy />' },
        ...(input.screenshot
          ? [{ type: 'image' as const, data: 'image-observation', mimeType: 'image/png' }]
          : []),
      ],
    };
  };
  const tool = createSetupTools(maat).find((item) => item.name === 'check_device_ready');
  assert.ok(tool);
  const result = await tool.execute('ready', { screenshot: false }, signal, undefined, ctx);
  assert.equal(requestedScreenshot, false);
  assert.ok(result.content.some((item) => item.type === 'text' && item.text === '<hierarchy />'));
  assert.equal('cases' in maat, false);
  assert.equal('evidence' in maat, false);
  const imageResult = await tool.execute('image', { screenshot: true }, signal, undefined, ctx);
  assert.ok(
    imageResult.content.some((item) => item.type === 'image' && item.data === 'image-observation'),
  );
  maat.setup.ready = async () => {
    throw new Error('Phone channel failed');
  };
  await assert.rejects(tool.execute('ready', {}, signal, undefined, ctx), /Phone channel failed/);
});

test('locked phone readiness is a visible failure with a user-only next step', async () => {
  const { maat, ctx } = fixture();
  const locked = new Error('ANDROID_DEVICE_LOCKED: device is locked');
  maat.setup.ready = async () => {
    throw locked;
  };
  const tool = createSetupTools(maat).find((item) => item.name === 'check_device_ready');
  assert.ok(tool);
  await assert.rejects(
    tool.execute('locked', { screenshot: true }, undefined, undefined, ctx),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, locked);
      assert.match(error.message, /ANDROID_DEVICE_LOCKED/);
      assert.match(error.message, /请本人点亮并解锁手机/);
      assert.match(error.message, /不要重启服务或重复之前的操作/);
      return true;
    },
  );
});

test('Android setup command hands preparation to the host, while doctor stays diagnostic', async () => {
  const { maat, checks, ctx } = fixture();
  const commands = new Map<
    string,
    { handler: (args: string, context: ExtensionContext) => unknown }
  >();
  const messages: Array<{ content: string; triggerTurn: boolean }> = [];
  const notifications: string[] = [];
  const pi = {
    registerCommand(
      name: string,
      command: { handler: (args: string, context: ExtensionContext) => unknown },
    ) {
      commands.set(name, command);
    },
    sendMessage(message: { content: string }, options: { triggerTurn: boolean }) {
      messages.push({ content: message.content, triggerTurn: options.triggerTurn });
    },
  } as unknown as ExtensionAPI;
  ctx.ui.notify = (message) => notifications.push(message);
  registerMaatSetupCommands(pi, maat);
  await commands.get('maat-setup')?.handler('', ctx);
  assert.equal(checks.at(-1)?.platform, 'android');
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.triggerTurn, true);
  assert.match(messages[0]!.content, /maat-setup Skill/);
  assert.match(messages[0]!.content, /继续原任务/);
  await commands.get('maat-doctor')?.handler('', ctx);
  assert.equal(checks.at(-1)?.platform, 'android');
  assert.equal(messages.length, 1);
  assert.match(notifications.at(-1)!, /诊断不会创建手机 Session/);
});

test('the host tool can explicitly clear legacy App routing for readiness recovery', async () => {
  const { maat, ctx } = fixture();
  let cleared = false;
  maat.platforms.configureSession = async (input) => {
    assert.deepEqual(input, { clearAppTarget: true });
    cleared = true;
  };
  const tool = createPlatformTools(maat).find((item) => item.name === 'configure_session');
  assert.ok(tool);
  await tool.execute('clear-routing', { clearAppTarget: true }, undefined, undefined, ctx);
  assert.equal(cleared, true);
  assert.equal('cases' in maat, false);
});
