import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createMaat } from '../packages/core/src/api/create-maat.ts';
import { aggregateSetup } from '../packages/core/src/setup-assistant/model.ts';
import { createPlatformTools } from '../packages/pi/src/tools/platform-tools.ts';
import { createSetupTools } from '../packages/pi/src/tools/setup-tools.ts';
import { registerMaatSetupCommands } from '../packages/pi/src/setup-extension.ts';
import { createMaatPiTools } from '../packages/pi/src/tools.ts';
import { resultText } from '../packages/pi/src/mobile-summary.ts';

function partialSnapshot() {
  return aggregateSetup({
    platform: 'macos',
    fingerprint: { appiumPid: 10, appiumStartedAt: 'now', wdaPid: 20, wdaStartedAt: 'now' },
    capabilities: [
      {
        id: 'appiumServer',
        status: 'ready',
        required: true,
        messageKey: 'capability.appium.ready',
      },
      {
        id: 'uiInteraction',
        status: 'ready',
        required: true,
        messageKey: 'capability.interaction.ready',
      },
      {
        id: 'screenCapture',
        status: 'action-required',
        required: false,
        messageKey: 'capability.screenshot.required',
        action: { id: 'open-screen-recording', labelKey: 'action.openScreenRecording' },
      },
    ],
  });
}

const context = {
  mode: 'print',
  waitForIdle: async () => {},
  sessionManager: {
    getEntries: () => [{ type: 'message', message: { role: 'user', content: '请检查操作环境' } }],
  },
} as unknown as ExtensionContext;

test('select_platform returns the macOS setup action panel without a test draft', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maat-setup-tools-'));
  const maat = createMaat({
    workspaceRoot: directory,
    setupAssistant: {
      preferencesFile: path.join(directory, 'setup.json'),
      detector: async () => partialSnapshot(),
    },
  });

  try {
    const tool = createPlatformTools(maat).find((item) => item.name === 'select_platform');
    assert.ok(tool);
    const result = await tool.execute(
      'select',
      { platform: 'macos' },
      undefined,
      undefined,
      context,
    );
    const text = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    assert.match(text, /Maat · macOS/);
    assert.match(text, /截图/);
    assert.equal('drafts' in maat, false);
  } finally {
    await maat.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('optional capabilities and permission recheck are independent of Case state', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maat-setup-tools-'));
  const maat = createMaat({
    workspaceRoot: directory,
    setupAssistant: {
      preferencesFile: path.join(directory, 'setup.json'),
      detector: async () => partialSnapshot(),
    },
  });
  try {
    await maat.platforms.select('macos');
    const tools = createSetupTools(maat);
    const skip = tools.find((item) => item.name === 'continue_without_capability');
    const retry = tools.find((item) => item.name === 'retry_setup_step');
    assert.ok(skip && retry);
    await skip.execute('skip', { capability: 'screenCapture' }, undefined, undefined, context);
    maat.setup.interrupt({ platform: 'macos', pendingAction: 'screenshot' });
    const result = await retry.execute('retry', {}, undefined, undefined, context);
    const text = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    assert.match(text, /准备状态已重新检查/);
    assert.doesNotMatch(text, /Case|业务断言/);
    assert.equal(maat.setup.pendingInterruption(), undefined);
  } finally {
    await maat.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Android setup is the first-use command default and the only user command', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maat-setup-command-'));
  const maat = createMaat({
    workspaceRoot: directory,
    setupAssistant: {
      preferencesFile: path.join(directory, 'setup.json'),
      detector: async () => partialSnapshot(),
      androidDetector: async () =>
        aggregateSetup({
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
        }),
    },
  });

  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
  const pi = {
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: ExtensionContext) => unknown },
    ) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  const notifications: string[] = [];
  const messages: string[] = [];
  pi.sendMessage = (message) => {
    messages.push(
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    );
  };
  const ctx = {
    ...context,
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;
  try {
    registerMaatSetupCommands(pi, maat);
    assert.deepEqual([...commands.keys()], ['maat-setup']);
    await commands.get('maat-setup')?.handler('android zh-CN', ctx);
    assert.equal(maat.platforms.current().id, 'android');
    assert.match(messages[0]!, /APPIUM_SERVER_UNAVAILABLE/);
    assert.match(messages[0]!, /android-tools\.mjs/);
    await maat.platforms.select('web');
    await commands.get('maat-setup')?.handler('', ctx);
    assert.equal(maat.platforms.current().id, 'android');
  } finally {
    await maat.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('iOS setup command and later retry/diagnostics remain iOS and read-only', async () => {
  const maat = createMaat();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
  const pi = {
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: ExtensionContext) => unknown },
    ) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  const notifications: string[] = [];
  const messages: Array<{ customType: string; content: string }> = [];
  pi.sendMessage = (message) => {
    messages.push(message as (typeof messages)[number]);
  };
  const ctx = {
    ...context,
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;
  const checks: string[] = [];
  maat.setup.check = async (input) => {
    checks.push(input?.platform ?? '');
    return aggregateSetup({ platform: 'ios', capabilities: [], state: 'unknown' });
  };
  maat.setup.ready = async () => {
    throw new Error('Doctor must not create a Session.');
  };
  maat.setup.action = async () => {
    throw new Error('iOS must not open macOS settings.');
  };
  try {
    registerMaatSetupCommands(pi, maat);
    await commands.get('maat-setup')?.handler('ios zh-CN', ctx);
    assert.equal(maat.platforms.current().id, 'ios');
    await commands.get('maat-setup')?.handler('', ctx);
    for (const name of ['retry_setup_step', 'get_setup_diagnostics']) {
      const tool = createSetupTools(maat).find((item) => item.name === name)!;
      const result = await tool.execute(name, {}, undefined, undefined, ctx);
      assert.match(resultText(result), /"platform":"ios"/);
      assert.doesNotMatch(resultText(result), /android-tools\.mjs|Maat · macOS/);
    }
    assert.deepEqual(checks, ['ios', 'ios', 'ios', 'ios']);
    assert.equal(messages[0]!.customType, 'maat-ios-setup');
    assert.match(messages[0]!.content, /iPhone|ios/);
    assert.equal(notifications.length, 0);
    assert.equal(maat.platforms.status().session, 'idle');
    await assert.rejects(
      Promise.resolve(commands.get('maat-setup')?.handler('not-a-platform', ctx)),
      /Use \/maat-setup/,
    );
  } finally {
    await maat.close();
  }
});

test('iOS readiness forwards transient WDA authorization and returns model-visible proof', async () => {
  const maat = createMaat();
  await maat.platforms.select('ios');
  const calls: unknown[] = [];
  maat.setup.ready = async (input) => {
    calls.push(input);
    return {
      ready: true,
      platform: 'ios',
      proof: {
        phoneUnlocked: true,
        sessionUsable: true,
        sourceReadable: true,
        viewportReadable: true,
        screenshotReadable: false,
      },
      observations: [
        {
          type: 'text',
          text: '{"phoneUnlocked":true,"source":"<App/>","viewport":{"width":390,"height":844}}',
        },
      ],
    };
  };
  const tool = createSetupTools(maat).find((item) => item.name === 'check_device_ready')!;
  const signal = new AbortController().signal;
  try {
    const result = await tool.execute(
      'ready',
      { screenshot: false, allowWdaInitialization: true },
      signal,
      undefined,
      context,
    );
    assert.deepEqual(calls[0], { screenshot: false, allowWdaInitialization: true, signal });
    assert.match(resultText(result), /iOS|phoneUnlocked|source|viewport/);
    assert.equal(result.details.platform, 'ios');
    await tool.execute('next', {}, undefined, undefined, context);
    assert.deepEqual(calls[1], {
      screenshot: undefined,
      allowWdaInitialization: undefined,
      signal: undefined,
    });
    assert.equal(maat.platforms.status().session, 'idle');
  } finally {
    await maat.close();
  }
});

test('iOS readiness errors preserve causes and distinguish lock uncertainty from WDA security rejection', async () => {
  const maat = createMaat();
  await maat.platforms.select('ios');
  const tool = createSetupTools(maat).find((item) => item.name === 'check_device_ready')!;
  try {
    for (const [code, expected] of [
      ['IOS_DEVICE_LOCKED', /本人点亮并解锁/],
      ['IOS_DEVICE_LOCK_STATE_UNKNOWN', /无法证明|allowWdaInitialization/],
      ['IOS_WDA_SECURITY_REJECTED', /若已信任或没有入口|有效期/],
    ] as const) {
      const original = new Error(code);
      maat.setup.ready = async () => {
        throw original;
      };
      await assert.rejects(tool.execute('ready', {}, undefined, undefined, context), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, original);
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /Android|SDK|一定未信任/);
        return true;
      });
    }
  } finally {
    await maat.close();
  }
});

test('iOS execution setup failure diagnoses only iOS without changing the original action failure', async () => {
  const maat = createMaat();
  await maat.platforms.select('ios');
  const original = new Error('ECONNREFUSED');
  maat.exploration.executeJavaScript = async () => {
    throw original;
  };
  const checks: string[] = [];
  maat.setup.check = async (input) => {
    checks.push(input?.platform ?? '');
    return aggregateSetup({ platform: 'ios', capabilities: [], state: 'unknown' });
  };
  maat.setup.interrupt = () => {
    throw new Error('No macOS interruption');
  };
  try {
    const tool = createMaatPiTools(maat).find((item) => item.name === 'exe_js')!;
    await assert.rejects(
      tool.execute('exec', { code: 'action()' }, undefined, undefined, context),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, original);
        assert.match(error.message, /MAAT_EXECUTION_FAILED|ECONNREFUSED|iOS/);
        assert.match(error.message, /Do not replay/);
        assert.doesNotMatch(error.message, /android-tools\.mjs|Maat · macOS/);
        return true;
      },
    );
    assert.deepEqual(checks, ['ios']);
  } finally {
    await maat.close();
  }
});

test('release_device_session supports iOS without releasing at model-turn boundaries', async () => {
  const maat = createMaat();
  await maat.platforms.select('ios');
  let closed = 0;
  maat.platforms.current().close = async () => {
    closed += 1;
  };
  try {
    const tool = createPlatformTools(maat).find((item) => item.name === 'release_device_session')!;
    assert.equal(closed, 0);
    assert.match(tool.description!, /Do not release while waiting|model-turn end/);
    const result = await tool.execute('release', {}, undefined, undefined, context);
    assert.equal(closed, 1);
    assert.deepEqual(result.details, { released: true, platform: 'ios' });
  } finally {
    await maat.close();
  }
});

test('setup waits for the current tool batch before switching its platform', async () => {
  const maat = createMaat({
    setupAssistant: {
      androidDetector: async () =>
        aggregateSetup({ platform: 'android', capabilities: [], state: 'unknown' }),
    },
  });
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionContext) => Promise<unknown> }
  >();
  const messages: string[] = [];
  const pi = {
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: ExtensionContext) => Promise<unknown> },
    ) {
      commands.set(name, command);
    },
    sendMessage(message: { content: string }) {
      messages.push(message.content);
    },
  } as unknown as ExtensionAPI;
  let finish!: () => void;
  const idle = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const ctx = { ...context, waitForIdle: () => idle } as unknown as ExtensionContext;
  try {
    registerMaatSetupCommands(pi, maat);
    const handler = commands.get('maat-setup');
    assert.ok(handler);
    const pending = handler.handler('android', ctx);
    await Promise.resolve();
    assert.equal(maat.platforms.current().id, 'web');
    assert.equal(messages.length, 0);
    finish();
    await pending;
    assert.equal(maat.platforms.current().id, 'android');
    assert.equal(messages.length, 1);
  } finally {
    await maat.close();
  }
});
