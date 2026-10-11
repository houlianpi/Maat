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

test('Android setup is the first-use command default and doctor remains read-only', async () => {
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
    await commands.get('maat-doctor')?.handler('', ctx);
    assert.match(notifications.at(-1)!, /Maat · Android/);
    assert.equal(maat.platforms.current().id, 'web');
    await commands.get('maat-setup')?.handler('android zh-CN', ctx);
    assert.equal(maat.platforms.current().id, 'android');
    assert.match(messages[0]!, /APPIUM_SERVER_UNAVAILABLE/);
    assert.match(messages[0]!, /android-tools\.mjs/);
    await maat.platforms.select('web');
    await commands.get('maat-setup')?.handler('', ctx);
    assert.equal(maat.platforms.current().id, 'android');
    await commands.get('maat-doctor')?.handler('macos en', ctx);
    assert.match(notifications.at(-1)!, /Maat · macOS/);
    assert.doesNotMatch(notifications.join('\n'), /恢复 Case|业务断言/);
    assert.equal(maat.platforms.current().id, 'android');
  } finally {
    await maat.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('setup respects an explicitly selected unsupported platform instead of checking macOS', async () => {
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
  const ctx = {
    ...context,
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;
  maat.setup.check = async () => {
    throw new Error('No macOS diagnostics should run.');
  };
  try {
    await maat.platforms.select('ios');
    registerMaatSetupCommands(pi, maat);
    await commands.get('maat-setup')?.handler('', ctx);
    await commands.get('maat-doctor')?.handler('', ctx);
    assert.equal(maat.platforms.current().id, 'ios');
    assert.match(notifications.join('\n'), /ios/);
    assert.doesNotMatch(notifications.join('\n'), /Maat · macOS/);
    await assert.rejects(
      Promise.resolve(commands.get('maat-setup')?.handler('not-a-platform', ctx)),
      /Use \/maat-setup/,
    );
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
