import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { formatWithOptions } from 'node:util';
import { MaatApi } from '../packages/core/src/api/maat-api.ts';
import type { PlatformAdapter } from '../packages/core/src/core/platforms/contracts.ts';
import { PlatformRegistry } from '../packages/core/src/core/platforms/registry.ts';
import {
  maxOutputBytes,
  type JavaScriptObservation,
} from '../packages/core/src/core/exploration/protocol.ts';
import type {
  NativeAppTarget,
  NativeEnvironment,
} from '../packages/core/src/platforms/appium/schema.ts';
import { AppiumPlatformAdapter } from '../packages/core/src/platforms/appium/appium-adapter.ts';
import {
  detectAndroidSetup,
  type AndroidSetupDetectorDependencies,
  type AndroidSetupCommandResult,
} from '../packages/core/src/setup-assistant/android-detector.ts';
import { SetupAssistant } from '../packages/core/src/setup-assistant/setup-assistant.ts';
import type {
  SetupSnapshot,
  AndroidSetupCheckInput,
} from '../packages/core/src/setup-assistant/types.ts';

const serial = 'PRIVATE_DEVICE_SERIAL_123456';
const privateRoot = '/Users/private-user/secret-sdk';
const adbPath = `${privateRoot}/platform-tools/adb`;
const aapt2Path = `${privateRoot}/build-tools/35.0.0/aapt2`;
const online = `${serial}\tdevice product:pixel model:Pixel_8 device:husky\n`;
const success = (stdout: string): AndroidSetupCommandResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
});
const failed: AndroidSetupCommandResult = {
  stdout: '{"uiautomator2":{"version":"installed-but-command-failed"}}',
  stderr: `${serial} ${privateRoot} secret=value`,
  exitCode: 1,
  failure: 'failed',
};
const missing: AndroidSetupCommandResult = {
  stdout: '',
  stderr: '',
  exitCode: null,
  failure: 'not-found',
};
const image = {
  type: 'image',
  mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=',
} satisfies JavaScriptObservation;

function dependencies(overrides: Partial<AndroidSetupDetectorDependencies> = {}) {
  const commands: Array<{ file: string; args: string[] }> = [];
  const urls: string[] = [];
  let queries = 0;
  const base: AndroidSetupDetectorDependencies = {
    command: async (file, args) => {
      commands.push({ file, args });
      if (file === 'adb' || file === adbPath)
        return success('Android Debug Bridge version 1.0.41\n');
      if (file === aapt2Path) return success('Android Asset Packaging Tool (aapt) 2.19\n');
      if (file === 'appium' && args[0] === '--version') return success('3.0.0\n');
      if (file === 'appium' && args[0] === 'driver')
        return success('{"uiautomator2":{"version":"4.2.0"}}');
      throw new Error(`Unexpected probe: ${file} ${args.join(' ')}`);
    },
    fetchStatus: async (url) => {
      urls.push(url);
      return true;
    },
    adbDevices: async () => {
      queries += 1;
      return online;
    },
    sdkTools: async () => ({ rootConfigured: true, adbPath, aapt2Path }),
  };
  return { deps: { ...base, ...overrides }, base, commands, urls, queryCount: () => queries };
}

const capability = (snapshot: SetupSnapshot, id: string) => {
  const result = snapshot.capabilities.find((item) => item.id === id);
  assert.ok(result, `Missing capability ${id}`);
  return result;
};

test('Android doctor reports installed prerequisites independently of a stopped Appium server', async () => {
  const fake = dependencies({ fetchStatus: async () => false });
  const snapshot = await detectAndroidSetup({}, fake.deps);
  assert.equal(snapshot.platform, 'android');
  assert.equal(snapshot.canContinue, false);
  assert.equal(capability(snapshot, 'appiumServer').errorCode, 'APPIUM_SERVER_UNAVAILABLE');
  assert.equal(capability(snapshot, 'appiumServer').action?.command, undefined);
  assert.equal(capability(snapshot, 'uiautomator2Driver').status, 'ready');
  assert.equal(capability(snapshot, 'androidSdk').status, 'ready');
  assert.equal(capability(snapshot, 'adb').status, 'ready');
  assert.equal(capability(snapshot, 'androidDevice').status, 'ready');
  assert.equal(snapshot.technicalDetails?.preparationOnly, true);
  assert.deepEqual(snapshot.fingerprint, {});
  assert.equal(
    fake.commands.some(({ args }) => args.includes('start-server') || args.includes('devices')),
    false,
  );
  assert.equal(
    fake.commands.some(({ args }) => args.includes('doctor')),
    false,
  );
  assert.equal(fake.queryCount(), 1);
  const output = JSON.stringify(snapshot);
  assert.equal(output.includes(serial), false);
  assert.equal(output.includes(privateRoot), false);
  assert.equal(output.includes('secret=value'), false);
});

test('Android doctor checks the default or exact custom Appium endpoint, without fallback', async () => {
  const fake = dependencies();
  assert.equal((await detectAndroidSetup({}, fake.deps)).canContinue, true);
  assert.deepEqual(fake.urls, ['http://127.0.0.1:4723/']);
  await detectAndroidSetup({ serverUrl: 'http://localhost:5555/wd/hub' }, fake.deps);
  assert.equal(fake.urls.at(-1), 'http://localhost:5555/wd/hub');
  const down = await detectAndroidSetup(
    { serverUrl: 'http://localhost:5555/wd/hub' },
    {
      ...fake.deps,
      fetchStatus: async () => false,
    },
  );
  assert.equal(capability(down, 'appiumServer').action?.command, undefined);
});

test('Android doctor rejects credentials, invalid endpoints, and invalid selectors before probing', async () => {
  const fake = dependencies();
  for (const serverUrl of [
    'http://user:password@localhost:4723/',
    'file:///tmp/appium',
    'http://localhost/?secret=abc',
  ]) {
    await assert.rejects(detectAndroidSetup({ serverUrl }, fake.deps));
  }
  await assert.rejects(detectAndroidSetup({ device: { name: ' ' } }, fake.deps), /selector/);
  assert.deepEqual(fake.commands, []);
  assert.deepEqual(fake.urls, []);
});

test('ADB absent is actionable; nonzero, timeout, and malformed output are unknown, never install claims', async () => {
  for (const result of [
    missing,
    failed,
    { ...failed, failure: 'timeout' as const },
    success('garbage'),
  ]) {
    const fake = dependencies();
    const snapshot = await detectAndroidSetup(
      {},
      {
        ...fake.deps,
        command: async (file, args, signal) =>
          file === 'adb' ? result : fake.base.command(file, args, signal),
      },
    );
    const adb = capability(snapshot, 'adb');
    assert.equal(adb.status, result === missing ? 'action-required' : 'unknown');
    assert.equal(adb.action?.id, result === missing ? 'install-adb' : 'recheck');
    assert.equal(snapshot.canContinue, false);
    assert.equal(JSON.stringify(snapshot).includes(serial), false);
  }
});

test('SDK roots and actual adb/aapt2 availability are required, but Java and a full developer environment are not', async () => {
  const configurations = [
    { rootConfigured: false },
    { rootConfigured: true, adbPath },
    { rootConfigured: true, rootsConflict: true, adbPath, aapt2Path },
  ];
  for (const sdk of configurations) {
    const fake = dependencies({ sdkTools: async () => sdk });
    const snapshot = await detectAndroidSetup({}, fake.deps);
    assert.equal(capability(snapshot, 'androidSdk').action?.id, 'configure-android-sdk');
    assert.equal(snapshot.canContinue, false);
  }
  const fake = dependencies();
  const snapshot = await detectAndroidSetup({}, fake.deps);
  assert.equal(snapshot.canContinue, true);
  assert.equal(
    fake.commands.some(({ file }) => /java|studio|emulator|sdkmanager/.test(file)),
    false,
  );
  assert.match(String(snapshot.technicalDetails?.java), /signing or installation/);
  for (const tool of [adbPath, aapt2Path]) {
    const failedSnapshot = await detectAndroidSetup(
      {},
      {
        ...fake.deps,
        command: async (file, args, signal) =>
          file === tool ? failed : fake.base.command(file, args, signal),
      },
    );
    assert.equal(capability(failedSnapshot, 'androidSdk').status, 'unknown');
    assert.equal(capability(failedSnapshot, 'androidSdk').action?.id, 'recheck');
  }
  const unreadable = await detectAndroidSetup(
    {},
    {
      ...fake.deps,
      sdkTools: async () => {
        throw new Error(privateRoot);
      },
    },
  );
  assert.equal(capability(unreadable, 'androidSdk').status, 'unknown');
  assert.equal(JSON.stringify(unreadable).includes(privateRoot), false);
});

test('UiAutomator2 absence is distinct from Appium CLI and driver-list execution/JSON failure', async () => {
  const cases = [
    { result: success('{}'), expected: 'action-required' },
    { result: failed, expected: 'unknown' },
    { result: success('not JSON'), expected: 'unknown' },
    { result: success('[]'), expected: 'unknown' },
    { result: success('{"uiautomator2":true}'), expected: 'unknown' },
  ];
  for (const { result, expected } of cases) {
    const fake = dependencies();
    const snapshot = await detectAndroidSetup(
      {},
      {
        ...fake.deps,
        command: async (file, args, signal) =>
          file === 'appium' && args[0] === 'driver'
            ? result
            : fake.base.command(file, args, signal),
      },
    );
    assert.equal(capability(snapshot, 'uiautomator2Driver').status, expected);
    assert.equal(
      capability(snapshot, 'uiautomator2Driver').action?.id,
      expected === 'unknown' ? 'recheck' : 'install-uiautomator2',
    );
  }
  const fake = dependencies();
  const noAppium = await detectAndroidSetup(
    {},
    {
      ...fake.deps,
      command: async (file, args, signal) =>
        file === 'appium' ? missing : fake.base.command(file, args, signal),
    },
  );
  assert.equal(noAppium.technicalDetails?.appiumCli, 'missing');
  assert.equal(capability(noAppium, 'appiumCli').errorCode, 'APPIUM_CLI_MISSING');
  assert.equal(noAppium.recommendedAction?.id, 'install-appium');
  assert.equal(capability(noAppium, 'uiautomator2Driver').status, 'unknown');
  assert.equal(capability(noAppium, 'appiumServer').status, 'ready');
});

test('Android doctor preserves absent, unauthorized, offline, and multiple device facts', async () => {
  const cases = [
    { text: '', key: 'missing', action: 'connect-android-device' },
    { text: `${serial}\tunauthorized`, key: 'unauthorized', action: 'authorize-android-device' },
    { text: `${serial}\toffline model:Pixel_8`, key: 'offline', action: 'connect-android-device' },
    {
      text: `${online}other\tdevice model:Pixel_9\n`,
      key: 'select',
      action: 'select-android-device',
    },
    { text: `${online}other\tunauthorized\n`, key: 'select', action: 'select-android-device' },
  ];
  for (const { text, key, action } of cases) {
    const fake = dependencies({ adbDevices: async () => text });
    const snapshot = await detectAndroidSetup({}, fake.deps);
    assert.equal(snapshot.canContinue, false);
    assert.equal(
      capability(snapshot, 'androidDevice').messageKey,
      `capability.androidDevice.${key}`,
    );
    assert.equal(capability(snapshot, 'androidDevice').action?.id, action);
    assert.equal(JSON.stringify(snapshot).includes(serial), false);
    assert.ok(Array.isArray(snapshot.technicalDetails?.devices));
  }
});

test('Appium CLI failures are explained as unknown, never install claims; concrete fixes beat recheck', async () => {
  for (const result of [failed, { ...failed, failure: 'timeout' as const }, success('invalid')]) {
    const fake = dependencies({ adbDevices: async () => undefined });
    const snapshot = await detectAndroidSetup(
      {},
      {
        ...fake.deps,
        command: async (file, args, signal) =>
          file === 'appium' ? result : fake.base.command(file, args, signal),
      },
    );
    assert.equal(capability(snapshot, 'appiumCli').status, 'unknown');
    assert.equal(
      capability(snapshot, 'appiumCli').details?.reason,
      result.failure ?? 'invalid-output',
    );
    assert.equal(snapshot.technicalDetails?.appiumCliCheck, result.failure ?? 'invalid-output');
    assert.equal(snapshot.recommendedAction?.id, 'start-adb');
    assert.equal(JSON.stringify(snapshot).includes(privateRoot), false);
    assert.equal(JSON.stringify(snapshot).includes(serial), false);
  }
});

test('Android doctor respects stable selectors without guessing another online device', async () => {
  const fake = dependencies({
    adbDevices: async () => `${online}emulator-5554\tdevice model:Pixel_9\n`,
  });
  const selected = await detectAndroidSetup(
    { device: { name: 'Pixel_9', kind: 'emulator' } },
    fake.deps,
  );
  assert.equal(selected.canContinue, true);
  assert.deepEqual(selected.technicalDetails?.devices, [
    { kind: 'device', status: 'device', matchesSelector: false },
    { kind: 'emulator', status: 'device', matchesSelector: true },
  ]);
  const absent = await detectAndroidSetup({ device: { name: 'Old_Phone' } }, dependencies().deps);
  assert.equal(absent.canContinue, false);
  assert.equal(capability(absent, 'androidDevice').messageKey, 'capability.androidDevice.missing');
  const unauthorized = await detectAndroidSetup(
    { device: { name: 'Pixel_9' } },
    dependencies({ adbDevices: async () => `${online}other\tunauthorized model:Pixel_9\n` }).deps,
  );
  assert.equal(
    capability(unauthorized, 'androidDevice').messageKey,
    'capability.androidDevice.unauthorized',
  );
  const duplicate = await detectAndroidSetup(
    { device: { name: 'Pixel_8' } },
    dependencies({ adbDevices: async () => `${online}other\tdevice model:Pixel_8\n` }).deps,
  );
  assert.equal(
    capability(duplicate, 'androidDevice').messageKey,
    'capability.androidDevice.select',
  );
});

test('a stopped or failed ADB daemon query never invokes CLI devices/start-server or misreports a failed query as no device', async () => {
  const fake = dependencies({ adbDevices: async () => undefined });
  const snapshot = await detectAndroidSetup({}, fake.deps);
  assert.equal(snapshot.technicalDetails?.adbServer, 'not-running');
  assert.equal(capability(snapshot, 'adbServer').errorCode, 'ADB_SERVER_NOT_RUNNING');
  assert.equal(capability(snapshot, 'androidDevice').status, 'unknown');
  assert.equal(snapshot.recommendedAction?.id, 'start-adb');
  assert.equal(snapshot.canContinue, false);
  assert.equal(
    fake.commands.some(({ args }) => args.includes('devices') || args.includes('start-server')),
    false,
  );
  for (const adbDevices of [
    async () => {
      throw new Error(`${serial} ${privateRoot}`);
    },
    async () => 'unexpected data',
  ]) {
    const failedSnapshot = await detectAndroidSetup({}, { ...fake.deps, adbDevices });
    assert.equal(capability(failedSnapshot, 'androidDevice').status, 'unknown');
    assert.equal(failedSnapshot.technicalDetails?.adbServer, 'unknown');
    assert.equal(JSON.stringify(failedSnapshot).includes(serial), false);
  }
});

test('remote Appium does not inspect or claim local tools represent remote prerequisites/devices', async () => {
  const fake = dependencies();
  for (const remoteDeviceConfigured of [false, true]) {
    const snapshot = await detectAndroidSetup(
      {
        serverUrl: 'https://remote.example/wd/hub',
        remoteDeviceConfigured,
      },
      fake.deps,
    );
    assert.equal(snapshot.canContinue, remoteDeviceConfigured);
    assert.equal(snapshot.technicalDetails?.serverScope, 'remote');
    assert.equal(capability(snapshot, 'adb').required, false);
    assert.equal(capability(snapshot, 'uiautomator2Driver').status, 'unknown');
    assert.equal(capability(snapshot, 'uiautomator2Driver').errorCode, undefined);
  }
  assert.deepEqual(fake.commands, []);
  assert.equal(fake.queryCount(), 0);
});

test('Android assistant check/action never reads or writes macOS preferences and restores state on abort', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-android-setup-'));
  const file = path.join(root, 'macos.json');
  await writeFile(file, 'existing macOS permission cache');
  const fake = dependencies({ adbDevices: async () => '' });
  const assistant = new SetupAssistant({
    preferencesFile: file,
    detector: async () => {
      throw new Error('macOS detector must not run');
    },
    androidDetectorDependencies: fake.deps,
  });
  try {
    await assistant.check({ platform: 'android' });
    assert.equal((await assistant.action()).id, 'connect-android-device');
    assert.equal(assistant.current().state, 'waiting-for-recheck');
    await assistant.check({ platform: 'android' });
    assert.equal(assistant.current().state, 'action-required');
    assert.equal(await readFile(file, 'utf8'), 'existing macOS permission cache');
    assert.deepEqual(await readdir(root), ['macos.json']);
    await assert.rejects(assistant.skip('androidDevice'), /required/);
    const previous = assistant.current();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await assert.rejects(
      assistant.check({ platform: 'android', signal: controller.signal }),
      /cancelled/,
    );
    assert.equal(assistant.current(), previous);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakeMaat(
  root: string,
  options: {
    deps?: AndroidSetupDetectorDependencies;
    hints?: NativeEnvironment;
    source?: string;
    viewport?: { width: number; height: number };
    screenshot?: 'missing' | 'failed' | 'invalid';
    observations?: JavaScriptObservation[];
    execute?: PlatformAdapter['execute'];
    platform?: string;
    appTarget?: boolean;
    runtimeAppTarget?: boolean;
    runtimeRunning?: boolean;
    isLocked?: (signal?: AbortSignal) => Promise<unknown>;
  } = {},
) {
  const fake = dependencies();
  const hints: NativeEnvironment = options.hints ?? {
    platform: 'android',
    capabilities: {},
    device: { name: 'Pixel_8' },
  };
  let executes = 0;
  let closes = 0;
  let initializes = 0;
  const codes: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const reads: string[] = [];
  const adapter: PlatformAdapter & {
    sessionHints: NativeEnvironment;
    appTarget?: NativeAppTarget;
    runtime?: { isRunning: boolean; currentApp?: NativeAppTarget };
  } = {
    id: options.platform ?? 'android',
    label: 'Fake',
    sessionHints: hints,
    appTarget: options.appTarget ? { 'appium:appPackage': 'com.example.legacy' } : undefined,
    runtime: {
      isRunning: Boolean(options.runtimeAppTarget || options.runtimeRunning),
      currentApp: options.runtimeAppTarget
        ? { 'appium:appPackage': 'com.example.runtime' }
        : undefined,
    },
    codeContext: { language: 'javascript', globals: [], guidelines: [] },
    initialize: async () => {
      initializes += 1;
    },
    execute: async (code, signal) => {
      executes += 1;
      codes.push(code);
      signals.push(signal);
      if (options.execute) return options.execute(code, signal);
      if (options.observations) return options.observations;
      const observations: JavaScriptObservation[] = [];
      await new vm.Script(`(async () => {\n${code}\n})()`).runInNewContext({
        driver: {
          isLocked: async () => {
            reads.push('lock');
            return options.isLocked ? options.isLocked(signal) : false;
          },
          getPageSource: async () => {
            reads.push('source');
            return options.source ?? '<hierarchy />';
          },
          getWindowSize: async () => {
            reads.push('viewport');
            return options.viewport ?? { width: 1080, height: 2400 };
          },
        },
        evidence: {
          screenshot: async () => {
            reads.push('screenshot');
            if (options.screenshot === 'failed') throw new Error('screenshot command failed');
            if (options.screenshot === 'missing') return;
            observations.push(
              options.screenshot === 'invalid' ? { ...image, data: 'invalid' } : image,
            );
          },
        },
        console: {
          log: (...values: unknown[]) =>
            observations.push({
              type: 'text',
              text: formatWithOptions({ getters: false, maxStringLength: 2_000 }, ...values),
            }),
        },
      });
      return observations;
    },
    executeReadiness: (code, signal) => adapter.execute(code, signal),
    status: () => ({ id: options.platform ?? 'android', label: 'Fake', session: 'idle' }),
    close: async () => {
      closes += 1;
    },
  };
  const maat = new MaatApi(new PlatformRegistry([adapter], adapter.id), root, {
    preferencesFile: path.join(root, 'macos-preferences.json'),
    detector: async () => {
      throw new Error('must not run macOS probes');
    },
    androidDetectorDependencies: options.deps ?? fake.deps,
  });
  return {
    maat,
    adapter,
    fake,
    codes,
    signals,
    reads,
    counts: () => ({ executes, closes, initializes }),
  };
}

test('MaatApi check fills current Android hints, accepts explicit overrides, and never creates a Session', async () => {
  const inputs: AndroidSetupCheckInput[] = [];
  const fake = fakeMaat('/unused', {
    hints: {
      platform: 'android',
      serverUrl: 'http://localhost:5555/',
      device: { name: 'Pixel_8' },
      capabilities: {},
    },
  });
  const maat = new MaatApi(new PlatformRegistry([fake.adapter], 'android'), '/unused', {
    androidDetector: async (input = {}) => {
      inputs.push(input);
      return detectAndroidSetup(input, fake.fake.deps);
    },
  });
  await maat.setup.check();
  assert.equal(inputs[0]?.serverUrl, 'http://localhost:5555/');
  assert.deepEqual(inputs[0]?.device, { name: 'Pixel_8' });
  await maat.setup.check({
    platform: 'android',
    serverUrl: 'http://localhost:8888/',
    device: { name: 'Different' },
  });
  assert.equal(inputs[1]?.serverUrl, 'http://localhost:8888/');
  assert.deepEqual(inputs[1]?.device, { name: 'Different' });
  assert.equal(fake.counts().executes, 0);
});

test('Android ready returns deterministic Worker proof and optional image without recording or persistence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-android-ready-'));
  const fake = fakeMaat(root);
  try {
    for (const removed of ['drafts', 'cases', 'evidence', 'tests'])
      assert.equal(removed in fake.maat, false);
    const result = await fake.maat.setup.ready();
    assert.equal(result.ready, true);
    assert.equal(result.platform, 'android');
    assert.deepEqual(result.proof, {
      phoneUnlocked: true,
      sessionUsable: true,
      sourceReadable: true,
      viewportReadable: true,
      screenshotReadable: false,
    });
    const current = result.observations.find((observation) => observation.type === 'text');
    assert.ok(current && current.type === 'text');
    const observed = JSON.parse(current.text);
    assert.equal(observed.phoneUnlocked, true);
    assert.equal(observed.source, '<hierarchy />');
    assert.deepEqual(observed.viewport, { width: 1080, height: 2400 });
    const screenshot = await fake.maat.setup.ready({ screenshot: true });
    assert.equal(screenshot.proof.screenshotReadable, true);
    assert.ok(screenshot.observations.some((observation) => observation.type === 'image'));
    assert.deepEqual(fake.reads, [
      'lock',
      'source',
      'viewport',
      'lock',
      'lock',
      'source',
      'viewport',
      'screenshot',
      'lock',
    ]);
    assert.equal(fake.counts().executes, 2);
    assert.equal(fake.counts().closes, 0);
    assert.ok(fake.signals.every((signal) => signal instanceof AbortSignal));
    assert.ok(
      fake.codes.every(
        (code) =>
          !/click|setValue|deleteSession|activateApp|terminateApp|saveCase|driver\.(unlock|lock|pressKeyCode|wake)/.test(
            code,
          ),
      ),
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Android ready rejects locked/screen-off phones before source, viewport or screenshot, without retry', async () => {
  for (const screenshot of [false, true]) {
    const fake = fakeMaat('/unused', { isLocked: async () => true });
    await assert.rejects(
      fake.maat.setup.ready({ screenshot }),
      /ANDROID_DEVICE_LOCKED: phone locked or screen off; unlock\/wake yourself then recheck/,
    );
    assert.deepEqual(fake.reads, ['lock']);
    assert.equal(fake.counts().executes, 1);
    assert.equal(fake.counts().closes, 0);
  }
});

test('Android ready rejects non-boolean lock results without claiming observation or screenshot availability', async () => {
  for (const locked of [undefined, null, 0, 1, 'false', 'true', {}, []]) {
    const fake = fakeMaat('/unused', { isLocked: async () => locked });
    await assert.rejects(
      fake.maat.setup.ready({ screenshot: true }),
      /ANDROID_DEVICE_LOCK_STATE_UNKNOWN: lock query did not return a boolean/,
    );
    assert.deepEqual(fake.reads, ['lock']);
    assert.equal(fake.counts().executes, 1);
  }
});

test('Android ready preserves a failed lock cause in-process and exposes a redacted reason', async () => {
  const original = new Error(`lock query failed serial=${serial} ${privateRoot} token=secret`);
  const fake = fakeMaat('/unused', {
    isLocked: async () => {
      throw original;
    },
  });
  await assert.rejects(fake.maat.setup.ready({ screenshot: true }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /ANDROID_DEVICE_LOCK_STATE_UNKNOWN: could not check/);
    assert.match(error.message, /Original failure: lock query failed/);
    assert.match(error.message, /check the connection and unlock\/wake yourself then recheck/);
    assert.equal(error.message.includes(serial), false);
    assert.equal(error.message.includes(privateRoot), false);
    assert.equal(error.message.includes('token=secret'), false);
    // This fake runs in-process in another VM realm; it does not prove IPC cause identity.
    assert.ok(error.cause && typeof error.cause === 'object' && 'cause' in error.cause);
    assert.equal(error.cause.cause, original);
    return true;
  });
  assert.deepEqual(fake.reads, ['lock']);
  assert.equal(fake.counts().executes, 1);
});

test('Android ready rejects a lock transition or unknown final lock state after reading the UI, without retry', async () => {
  for (const screenshot of [false, true]) {
    for (const finalState of [true, undefined, new Error('final lock query failed')]) {
      let queries = 0;
      const fake = fakeMaat('/unused', {
        isLocked: async () => {
          if (++queries === 1) return false;
          if (finalState instanceof Error) throw finalState;
          return finalState;
        },
      });
      await assert.rejects(
        fake.maat.setup.ready({ screenshot }),
        /ANDROID_DEVICE_LOCKED|ANDROID_DEVICE_LOCK_STATE_UNKNOWN/,
      );
      assert.deepEqual(fake.reads, [
        'lock',
        'source',
        'viewport',
        ...(screenshot ? ['screenshot'] : []),
        'lock',
      ]);
      assert.equal(fake.counts().executes, 1);
    }
  }
});

test('Android ready fails closed when an adapter has no safe readiness bootstrap contract', async () => {
  const fake = fakeMaat('/unused');
  delete fake.adapter.executeReadiness;
  await assert.rejects(fake.maat.setup.ready(), /ANDROID_READINESS_UNLOCK_UNSAFE/);
  assert.equal(fake.counts().executes, 0);
});

test('Android ready propagates Abort during a lock query without reading source/image or retrying', async () => {
  const controller = new AbortController();
  const fake = fakeMaat('/unused', {
    isLocked: async (signal) => {
      controller.abort(new Error('cancelled lock query'));
      signal!.throwIfAborted();
      return false;
    },
  });
  await assert.rejects(
    fake.maat.setup.ready({ screenshot: true, signal: controller.signal }),
    /readiness cancelled: .*ANDROID_DEVICE_LOCK_STATE_UNKNOWN/,
  );
  assert.deepEqual(fake.reads, ['lock']);
  assert.equal(fake.counts().executes, 1);
  assert.equal(fake.counts().closes, 0);
});

test('Android ready rejects unreadable source, invalid viewport, missing/malformed image and missing proof', async () => {
  const cases = [
    { source: '' },
    { source: '  ' },
    { viewport: { width: 0, height: 10 } },
    { viewport: { width: 1, height: Number.NaN } },
    { viewport: { width: 1, height: -1 } },
    { screenshot: 'failed' as const },
    { screenshot: 'missing' as const },
    { screenshot: 'invalid' as const },
    { observations: [{ type: 'text' as const, text: 'command succeeded' }] },
  ];
  for (const options of cases) {
    const fake = fakeMaat('/unused', options);
    await assert.rejects(fake.maat.setup.ready({ screenshot: true }), /readiness/);
    assert.equal(fake.counts().executes, 1);
    assert.equal(fake.counts().closes, 0);
  }
});

test('Android ready never executes on failed doctor/selector or unsupported platform/legacy App route', async () => {
  const cases = [
    { deps: dependencies({ fetchStatus: async () => false }).deps },
    { deps: dependencies({ adbDevices: async () => '' }).deps },
    { hints: { platform: 'android' as const, device: { name: 'Wrong_Device' }, capabilities: {} } },
    { platform: 'macos' },
    { platform: 'ios' },
    { platform: 'web' },
    { appTarget: true },
    { runtimeAppTarget: true },
    { hints: { platform: 'android' as const, capabilities: { 'appium:deviceName': 'Pixel_8' } } },
  ];
  for (const options of cases) {
    const fake = fakeMaat('/unused', options);
    await assert.rejects(
      fake.maat.setup.ready(),
      /blocked|unsupported|base Session|stable device selector/,
    );
    assert.equal(fake.counts().executes, 0);
    assert.equal(fake.counts().closes, 0);
  }
});

test('healthy remote Android ready uses its configured Session rather than local probes', async () => {
  const fake = fakeMaat('/unused', {
    runtimeRunning: true,
    hints: {
      platform: 'android',
      serverUrl: 'https://remote.example/wd/hub',
      capabilities: { 'appium:deviceName': 'Remote Phone' },
    },
  });
  assert.equal((await fake.maat.setup.ready()).ready, true);
  assert.deepEqual(fake.fake.commands, []);
  assert.equal(fake.fake.queryCount(), 0);
});

test('Android ready returns only deterministic proof and image observations, not adapter routing notices', async () => {
  const proof: JavaScriptObservation = {
    type: 'text',
    text: JSON.stringify({
      maatSetupReadiness: 1,
      phoneUnlocked: true,
      sessionUsable: true,
      sourceReadable: true,
      viewportReadable: true,
      source: '<hierarchy />',
      viewport: { width: 1080, height: 2400 },
    }),
  };
  const fake = fakeMaat('/unused', {
    observations: [{ type: 'text', text: `${serial} ${privateRoot} secret=value` }, proof, image],
  });
  const result = await fake.maat.setup.ready({ screenshot: true });
  assert.deepEqual(result.observations, [proof, image]);
  assert.equal(JSON.stringify(result).includes(serial), false);
  assert.equal(JSON.stringify(result).includes(privateRoot), false);
});

test('Android ready retains the complete current tree beyond console inspection limits and enforces the Worker output limit', async () => {
  const source = `<hierarchy><node text="${'tree'.repeat(2_000)}" /></hierarchy>`;
  const fake = fakeMaat('/unused', { source, viewport: { width: 360, height: 800 } });
  const result = await fake.maat.setup.ready();
  const observation = result.observations.find((item) => item.type === 'text');
  assert.ok(observation && observation.type === 'text');
  const current = JSON.parse(observation.text);
  assert.equal(current.source, source);
  assert.deepEqual(current.viewport, { width: 360, height: 800 });
  const oversized = fakeMaat('/unused', { source: 'x'.repeat(maxOutputBytes) });
  await assert.rejects(oversized.maat.setup.ready(), /12 MiB/);
});

test('Android ready rejects old/boolean-only or non-unlocked proof and invalid returned source/viewport fields', async () => {
  const proof = {
    maatSetupReadiness: 1,
    sessionUsable: true,
    sourceReadable: true,
    viewportReadable: true,
  };
  const valid = {
    ...proof,
    phoneUnlocked: true,
    source: '<hierarchy />',
    viewport: { width: 360, height: 800 },
  };
  for (const observation of [
    proof,
    { ...proof, source: valid.source, viewport: valid.viewport },
    { ...valid, phoneUnlocked: undefined },
    { ...valid, phoneUnlocked: false },
    { ...valid, phoneUnlocked: 'true' },
    { ...valid, source: ' ', viewport: { width: 1, height: 1 } },
    { ...valid, viewport: { width: '360', height: 800 } },
    { ...valid, viewport: { width: 0, height: 800 } },
  ]) {
    const fake = fakeMaat('/unused', {
      observations: [{ type: 'text', text: JSON.stringify(observation) }],
    });
    await assert.rejects(fake.maat.setup.ready(), /nonempty source and valid viewport/);
  }
});

test('Android ready exposes the original error summary while redacting diagnostic secrets and retaining the cause', async () => {
  const empty = fakeMaat('/unused', { source: '' });
  await assert.rejects(empty.maat.setup.ready(), /page source is empty/);
  const viewport = fakeMaat('/unused', { viewport: { width: 0, height: 10 } });
  await assert.rejects(viewport.maat.setup.ready(), /viewport is invalid/);
  const screenshot = fakeMaat('/unused', { screenshot: 'failed' });
  await assert.rejects(
    screenshot.maat.setup.ready({ screenshot: true }),
    /screenshot command failed/,
  );
  const original = new Error(`ECONNRESET serial=${serial} ${privateRoot} token=secret-value`);
  const fake = fakeMaat('/unused', {
    execute: async () => {
      throw original;
    },
  });
  await assert.rejects(fake.maat.setup.ready(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /ECONNRESET/);
    assert.equal(error.message.includes(serial), false);
    assert.equal(error.message.includes(privateRoot), false);
    assert.equal(error.message.includes('secret-value'), false);
    assert.equal(error.cause, original);
    return true;
  });
});

test('explicit App target clearing restores Android ready in the same API without automatic clearing or fallback', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-android-clear-target-'));
  const previousHintsDirectory = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const adapter = new AppiumPlatformAdapter({
    id: 'android',
    label: 'Android',
    platformName: 'Android',
    automationName: 'UiAutomator2',
  });
  const fake = fakeMaat(root);
  adapter.executeReadiness = fake.adapter.executeReadiness!;
  let closes = 0;
  adapter.runtime.close = async () => {
    closes += 1;
  };
  const maat = new MaatApi(new PlatformRegistry([adapter], 'android'), root, {
    androidDetectorDependencies: fake.fake.deps,
  });
  try {
    await maat.platforms.configureSession({
      device: { kind: 'device', name: 'Pixel_8' },
      capabilities: { 'appium:appPackage': 'com.example.legacy' },
    });
    await maat.platforms.configureSession({ capabilities: {} });
    assert.deepEqual(adapter.appTarget, { 'appium:appPackage': 'com.example.legacy' });
    await assert.rejects(maat.setup.ready(), /configureSession\(\{clearAppTarget:true\}\)/);
    assert.equal(fake.counts().executes, 0);
    // A closed runtime may retain its last target as a hint; it is not an active App route.
    await adapter.runtime.configure(adapter.sessionHints!, adapter.appTarget);
    await assert.rejects(
      maat.platforms.configureSession({
        clearAppTarget: true,
        capabilities: { 'appium:appPackage': 'com.example.conflict' },
      }),
      /cannot be combined/,
    );
    assert.deepEqual(adapter.appTarget, { 'appium:appPackage': 'com.example.legacy' });
    const closesBeforeClear = closes;
    await maat.platforms.configureSession({ clearAppTarget: true });
    assert.equal(closes, closesBeforeClear + 1);
    assert.equal(adapter.appTarget, undefined);
    assert.deepEqual(adapter.runtime.currentApp, { 'appium:appPackage': 'com.example.legacy' });
    assert.deepEqual(adapter.sessionHints?.device, { kind: 'device', name: 'Pixel_8' });
    assert.deepEqual(adapter.sessionHints?.capabilities, {});
    assert.equal((await maat.setup.ready()).ready, true);
    assert.equal(fake.counts().executes, 1);
    assert.deepEqual(await readdir(root), []);
    await maat.platforms.configureSession({
      clearAppTarget: false,
      capabilities: { 'appium:appPackage': 'com.example.next' },
    });
    assert.deepEqual(adapter.appTarget, { 'appium:appPackage': 'com.example.next' });
  } finally {
    if (previousHintsDirectory === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHintsDirectory;
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Android ready propagates Abort before probes and during Worker execution, without retry or cleanup changes', async () => {
  const aborted = new AbortController();
  aborted.abort(new Error('cancelled before ready'));
  const first = fakeMaat('/unused');
  await assert.rejects(
    first.maat.setup.ready({ signal: aborted.signal }),
    /cancelled before ready/,
  );
  assert.equal(first.counts().executes, 0);
  assert.deepEqual(first.fake.commands, []);
  const controller = new AbortController();
  const fake = fakeMaat('/unused', {
    execute: async (_code, signal) => {
      assert.ok(signal);
      controller.abort(new Error('cancelled in Worker'));
      signal.throwIfAborted();
      return [];
    },
  });
  await assert.rejects(fake.maat.setup.ready({ signal: controller.signal }), /cancelled in Worker/);
  assert.equal(fake.counts().executes, 1);
  assert.equal(fake.counts().closes, 0);
});

test('Android doctor stops before later commands when cancelled mid-probe', async () => {
  const controller = new AbortController();
  const fake = dependencies({
    fetchStatus: async () => {
      controller.abort(new Error('cancelled doctor'));
      return true;
    },
  });

  await assert.rejects(
    detectAndroidSetup({ signal: controller.signal }, fake.deps),
    /cancelled doctor/,
  );
  assert.deepEqual(fake.commands, []);
});

test('Android ready cancellation preserves execution/cleanup errors in the cause and redacts the visible summary', async () => {
  const controller = new AbortController();
  const primary = new Error('Worker execution cancelled', { cause: new Error('original cause') });
  const cleanup = new Error(`DELETE Session cleanup failed serial=${serial} ${privateRoot}`);
  const failure = new AggregateError(
    [primary, cleanup],
    `Worker execution cancelled; DELETE Session cleanup failed serial=${serial} ${privateRoot}`,
    { cause: primary },
  );
  const fake = fakeMaat('/unused', {
    execute: async () => {
      controller.abort(new Error('caller Abort reason'));
      throw failure;
    },
  });
  await assert.rejects(fake.maat.setup.ready({ signal: controller.signal }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.cause, failure);
    assert.equal(failure.cause, primary);
    assert.match(error.message, /Worker execution cancelled.*DELETE Session cleanup failed/);
    assert.equal(error.message.includes(serial), false);
    assert.equal(error.message.includes(privateRoot), false);
    assert.equal(error.message.includes('caller Abort reason'), false);
    return true;
  });
});
