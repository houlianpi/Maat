import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createMaat } from '../packages/core/src/api/create-maat.ts';
import { aggregateSetup } from '../packages/core/src/setup-assistant/model.ts';
import { createPlatformTools } from '../packages/pi/src/tools/platform-tools.ts';
import { createSetupTools } from '../packages/pi/src/tools/setup-tools.ts';
import { registerMaatSetupCommands } from '../packages/pi/src/setup-extension.ts';
import { createMaatPiTools } from '../packages/pi/src/tools.ts';
import { resultText } from '../packages/pi/src/mobile-summary.ts';
import { MobilePreparation } from '../packages/pi/src/mobile-preparation.ts';

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

for (const platform of ['android', 'ios'] as const) {
  test(`${platform} all setup producers and execution diagnostics use the registered preparation availability`, async () => {
    const maat = createMaat();
    await maat.platforms.select(platform);
    const snapshot = aggregateSetup({
      platform,
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
    maat.setup.check = async () => snapshot;
    maat.setup.current = () => snapshot;
    const original = new Error('ECONNREFUSED');
    maat.exploration.executeJavaScript = async () => {
      throw original;
    };
    const preparation = new MobilePreparation(maat);
    const verify = (text: string, available: boolean) => {
      assert.doesNotMatch(
        text,
        /appium --address|host-supported.*background|node .*android-tools\.mjs.*appium/,
      );
      if (available) {
        assert.match(text, /"tool":"prepare_mobile"/);
        assert.match(
          text,
          /"arguments":\{"action":"start-appium","taskId":null,"waitSeconds":20\}/,
        );
        assert.match(text, /same returned taskId/);
      } else {
        assert.match(text, /HOST_TRACKED_PREPARATION_UNAVAILABLE/);
        assert.doesNotMatch(text, /prepare_mobile/);
      }
    };
    try {
      for (const owner of [undefined, preparation]) {
        const tools = createMaatPiTools(maat, owner);
        assert.equal(
          tools.some((tool) => tool.name === 'prepare_mobile'),
          !!owner,
        );
        for (const name of [
          'check_platform_setup',
          'open_setup_step',
          'retry_setup_step',
          'get_setup_diagnostics',
        ]) {
          const tool = tools.find((item) => item.name === name)!;
          verify(
            resultText(await tool.execute('check', {}, undefined, undefined, context)),
            !!owner,
          );
        }
        const execute = tools.find((item) => item.name === 'exe_js')!;
        await assert.rejects(
          execute.execute('exec', { code: 'action()' }, undefined, undefined, context),
          (error) => {
            assert.ok(error instanceof Error);
            assert.equal(error.cause, original);
            verify(error.message, !!owner);
            return true;
          },
        );
      }
    } finally {
      await maat.close();
      await preparation.close();
    }
  });
}

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
    assert.match(messages[0]!, /HOST_TRACKED_PREPARATION_UNAVAILABLE/);
    assert.doesNotMatch(messages[0]!, /prepare_mobile|android-tools\.mjs.*appium/);
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

test('iOS readiness schema removes initialization gate and only forwards explicit first-install grant', async () => {
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
    assert.deepEqual(Object.keys(tool.parameters.properties), [
      'jobId',
      'jobAction',
      'waitSeconds',
      'screenshot',
      'allowWdaInstallation',
      'targetSelection',
    ]);
    assert.equal(tool.parameters.required?.length ?? 0, 0);
    assert.equal(tool.parameters.properties.allowWdaInstallation.type, 'boolean');
    assert.equal(tool.parameters.properties.waitSeconds.minimum, 0);
    assert.equal(tool.parameters.properties.waitSeconds.maximum, 20);
    const schemaText = JSON.stringify(tool.parameters);
    assert.match(schemaText, /explicitly authorizes first installation/);
    assert.match(schemaText, /Never infer|Not permission for signing changes, restart or unlock/);
    assert.doesNotMatch(schemaText + tool.description, /allowWdaInitialization/);
    const call = { type: 'toolCall' as const, id: 'ready', name: tool.name, arguments: {} };
    assert.deepEqual(validateToolArguments(tool, call), {});
    assert.throws(() =>
      validateToolArguments(tool, { ...call, arguments: { allowWdaInitialization: false } }),
    );
    assert.throws(() =>
      validateToolArguments(tool, {
        ...call,
        arguments: { allowWdaInstallation: { approve: true } },
      }),
    );
    assert.deepEqual(
      validateToolArguments(tool, {
        ...call,
        arguments: { jobId: 'opaque-job-id', jobAction: 'cancel', waitSeconds: 2 },
      }),
      { jobId: 'opaque-job-id', jobAction: 'cancel', waitSeconds: 2 },
    );
    assert.deepEqual(
      validateToolArguments(tool, {
        ...call,
        arguments: {
          targetSelection: { discoveryId: 'ephemeral-discovery', candidateNumber: 2 },
        },
      }),
      { targetSelection: { discoveryId: 'ephemeral-discovery', candidateNumber: 2 } },
    );
    const result = await tool.execute('ready', { screenshot: false }, signal, undefined, context);
    assert.deepEqual(calls[0], { screenshot: false, allowWdaInstallation: undefined, signal });
    assert.match(resultText(result), /iOS|phoneUnlocked|source|viewport/);
    assert.equal(result.details.platform, 'ios');
    await tool.execute('next', {}, undefined, undefined, context);
    assert.deepEqual(calls[1], {
      screenshot: undefined,
      allowWdaInstallation: undefined,
      signal: undefined,
    });

    test('check_device_ready returns model-visible selection without claiming readiness', async () => {
      const maat = createMaat();
      await maat.platforms.select('android');
      maat.setup.ready = async () =>
        ({
          ready: false,
          platform: 'android',
          status: 'selection-required',
          discoveryId: 'ephemeral-discovery',
          candidates: [
            {
              candidateNumber: 1,
              displayName: 'Alpha Phone',
              platform: 'android',
              kind: 'device',
              discriminator: 'phone-a1b2',
            },
            {
              candidateNumber: 2,
              displayName: 'Beta Phone',
              platform: 'android',
              kind: 'device',
              discriminator: 'phone-c3d4',
            },
          ],
        }) as never;
      const tool = createSetupTools(maat).find((item) => item.name === 'check_device_ready')!;
      try {
        const result = await tool.execute('select', {}, undefined, undefined, context);
        assert.match(resultText(result), /selection|required|Alpha Phone|Beta Phone/i);
        assert.doesNotMatch(resultText(result), /can start|可以开始手机任务/);
        assert.equal(result.details.status, 'selection-required');
      } finally {
        await maat.close();
      }
    });
    await tool.execute('grant', { allowWdaInstallation: true }, signal, undefined, context);
    assert.deepEqual(calls[2], { screenshot: undefined, allowWdaInstallation: true, signal });
    await tool.execute('deny', { allowWdaInstallation: false }, signal, undefined, context);
    assert.deepEqual(calls[3], { screenshot: undefined, allowWdaInstallation: false, signal });
    await tool.execute(
      'select',
      {
        targetSelection: {
          discoveryId: 'ephemeral-discovery',
          candidateNumber: 2,
        },
      },
      signal,
      undefined,
      context,
    );
    assert.deepEqual(calls[4], {
      screenshot: undefined,
      allowWdaInstallation: undefined,
      targetSelection: {
        discoveryId: 'ephemeral-discovery',
        candidateNumber: 2,
      },
      signal,
    });
    // Even a stale direct caller cannot reintroduce the model initialization opt-out gate.
    await tool.execute('legacy', { allowWdaInitialization: false }, signal, undefined, context);
    assert.deepEqual(calls[5], { screenshot: undefined, allowWdaInstallation: undefined, signal });
    assert.equal(maat.platforms.status().session, 'idle');
  } finally {
    await maat.close();
  }
});

test('check_device_ready discloses target selection and requires an explicit readiness continuation', async () => {
  const maat = createMaat();
  await maat.platforms.select('android');
  maat.setup.ready = async () =>
    ({
      ready: false,
      platform: 'android',
      status: 'target-selected',
      selectedBy: 'single-candidate',
      candidate: {
        candidateNumber: 1,
        displayName: 'Alpha Phone',
        platform: 'android',
        kind: 'device',
        discriminator: 'device-a1b2',
      },
    }) as never;
  const tool = createSetupTools(maat).find((item) => item.name === 'check_device_ready')!;
  try {
    const result = await tool.execute('selected', {}, undefined, undefined, context);
    const text = resultText(result);
    assert.match(text, /Alpha Phone|target selected/i);
    assert.match(text, /not readiness|again|再次调用/);
    assert.match(text, /no doctor check|Session creation|尚未执行环境检查/);
    assert.doesNotMatch(text, /phone tasks can start|可以开始手机任务/);
    assert.equal(result.details.status, 'target-selected');
  } finally {
    await maat.close();
  }
});

test('check_device_ready maps creation uncertainty to creation-unconfirmed recovery', async () => {
  const maat = createMaat();
  await maat.platforms.select('android');
  const tool = createSetupTools(maat).find((item) => item.name === 'check_device_ready')!;
  const uncertain = Object.assign(
    new Error('safe creation uncertainty; a Session resource may exist'),
    { code: 'phone-session-creation-uncertain' },
  );
  maat.setup.ready = async () => {
    throw uncertain;
  };
  try {
    await assert.rejects(
      tool.execute('uncertain', {}, undefined, undefined, context),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, uncertain);
        assert.match(error.message, /PHONE_READINESS_RECOVERY_REQUIRED/);
        assert.match(error.message, /readiness: creation-unconfirmed/);
        assert.match(error.message, /Session resource may exist/);
        assert.match(error.message, /Do not call check_device_ready, exe_js, configure, release/);
        assert.doesNotMatch(error.message, /timeout|retry ready|read-only exe_js/i);
        return true;
      },
    );
  } finally {
    await maat.close();
  }
});

test('iOS readiness errors preserve original diagnostics, fail once and guide English/Chinese without initialization gate', async () => {
  const maat = createMaat();
  await maat.platforms.select('ios');
  const tool = createSetupTools(maat).find((item) => item.name === 'check_device_ready')!;
  try {
    for (const [code, expected] of [
      ['IOS_DEVICE_LOCKED', /本人点亮并解锁|Wake and unlock it yourself/],
      ['IOS_DEVICE_LOCK_STATE_UNKNOWN', /live WDA.*未能返回|live WDA did not return/],
      ['IOS_WDA_SECURITY_REJECTED', /若已信任或没有入口|if already trusted or no entry/],
      [
        'IOS_WDA_INSTALLATION_AUTHORIZATION_REQUIRED',
        /本人明确授权首次安装|explicit user approval of first installation/,
      ],
      ['IOS_WDA_SIGNING_REQUIRED', /不能自动续签|do not renew automatically/],
      [
        'IOS_WDA_INSPECTION_FAILED',
        /本机有效构建不等于手机已安装|valid local build proves neither phone installation/,
      ],
      ['IOS_CONNECTION_INITIALIZATION_DISABLED', /existingSession/],
      [
        'IOS_WDA_CONFIGURATION_CONFLICT',
        /仅报告明确配置冲突|Report the explicit configuration conflict/,
      ],
      ['IOS_READINESS_UNSUPPORTED', /不符合安全 WDA 复用路径|incompatible with safe WDA reuse/],
    ] as const) {
      for (const language of ['请继续手机任务', 'Continue my phone task']) {
        const ctx = {
          ...context,
          sessionManager: {
            getEntries: () => [{ type: 'message', message: { role: 'user', content: language } }],
          },
        } as unknown as ExtensionContext;
        const original = new Error(`${code}: synthetic primary inspection/lock failure`);
        let calls = 0;
        maat.setup.ready = async () => {
          calls += 1;
          throw original;
        };
        await assert.rejects(
          tool.execute('ready', { screenshot: true }, undefined, undefined, ctx),
          (error) => {
            assert.ok(error instanceof Error);
            assert.equal(error.cause, original);
            assert.ok(error.message.startsWith(`${original.message}\n`));
            assert.match(error.message, expected);
            assert.doesNotMatch(error.message, /allowWdaInitialization|Android|SDK|一定未信任/);
            if (code === 'IOS_DEVICE_LOCK_STATE_UNKNOWN') {
              assert.match(
                error.message,
                /不读取 source、截图或执行业务 UI|do not read source, take screenshots or perform business UI/,
              );
              assert.match(error.message, /不重放|do not replay/);
            }
            if (code === 'IOS_WDA_CONFIGURATION_CONFLICT' || code === 'IOS_READINESS_UNSUPPORTED') {
              assert.match(
                error.message,
                /不自动.*重装.*改 Team|Do not automatically.*reinstall.*change Team/,
              );
            }
            return true;
          },
        );
        assert.equal(calls, 1); // Host guidance never retries initialization or performs UI.
      }
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
