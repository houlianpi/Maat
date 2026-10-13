import assert from 'node:assert/strict';
import test from 'node:test';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  detectIosSetup,
  type IosSetupDetectorDependencies,
} from '../packages/core/src/setup-assistant/ios-detector.ts';
import { SetupAssistant } from '../packages/core/src/setup-assistant/setup-assistant.ts';
import {
  assertIosColdReadiness,
  parseIosDeviceList,
  type IosDevice,
} from '../packages/core/src/setup/ios-devices.ts';
import { resolveIosReadinessSession } from '../packages/core/src/platforms/appium/session-resolver.ts';
import type { SetupCommandResult } from '../packages/core/src/setup-assistant/probes.ts';
import type { NativeEnvironment } from '../packages/core/src/platforms/appium/schema.ts';
import { discoverApplications } from '../packages/core/src/setup/applications.ts';
import {
  resolveAndroidTools,
  assertAdbServerCompatible,
} from '../packages/core/src/setup/android-tools.ts';

test('physical iOS App discovery includes default Apps, validates output and removes temporary data', async () => {
  const environment: NativeEnvironment = {
    platform: 'ios',
    device: { kind: 'device', name: 'Test iPhone' },
    capabilities: {},
  };
  let output: unknown = {
    result: {
      apps: [
        { name: 'Calculator', bundleIdentifier: 'com.apple.calculator' },
        { name: 'Example', bundleIdentifier: 'com.example.app' },
      ],
    },
  };
  let temporaryDirectory = '';
  const dependencies = {
    resolveDevice: async () => ({ environment, capabilities: { 'appium:udid': privateId } }),
    resolveAndroidTools,
    assertAdbServerCompatible,
    command: async (file: string, args: string[]) => {
      assert.equal(file, 'xcrun');
      assert.deepEqual(args.slice(0, 5), [
        'devicectl',
        'device',
        'info',
        'apps',
        '--include-default-apps',
      ]);
      assert.equal(args[args.indexOf('--device') + 1], privateId);
      const destination = args[args.indexOf('--json-output') + 1]!;
      temporaryDirectory = path.dirname(destination);
      await writeFile(destination, JSON.stringify(output));
      return { stdout: '' };
    },
  };
  assert.deepEqual(await discoverApplications(environment, 'calculator', dependencies), [
    { name: 'Calculator', id: 'com.apple.calculator' },
  ]);
  await assert.rejects(access(temporaryDirectory), /ENOENT/);
  for (const invalid of [{}, { result: { apps: [{ name: 'Calculator' }] } }]) {
    output = invalid;
    await assert.rejects(
      discoverApplications(environment, '', dependencies),
      /IOS_APP_DISCOVERY_FAILED/,
    );
    await assert.rejects(access(temporaryDirectory), /ENOENT/);
  }
});

test('physical iOS App discovery propagates mid-flight Abort and removes its temporary output', async () => {
  const controller = new AbortController();
  const reason = new Error('fixture app inspection abort');
  let temporaryDirectory = '';
  let commands = 0;
  let commandStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  const operation = discoverApplications(
    {
      platform: 'ios',
      device: { kind: 'device', name: 'Test iPhone' },
      capabilities: {},
    },
    '',
    {
      resolveDevice: async () => {
        throw new Error('exact identity must bypass legacy resolution');
      },
      resolveAndroidTools,
      assertAdbServerCompatible,
      discoverIosDevices: async () => [phone],
      command: async (_file, args, options) => {
        commands += 1;
        temporaryDirectory = path.dirname(args[args.indexOf('--json-output') + 1]!);
        commandStarted();
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        });
        return { stdout: '' };
      },
    },
    {
      platform: 'ios',
      providerInstanceId: 'local-core-device',
      routingId: privateId,
      kind: 'device',
      transportScope: 'core-device',
      displayName: phone.name,
    },
    controller.signal,
  );
  await started;
  controller.abort(reason);
  await assert.rejects(operation, (error) => error === reason);
  assert.equal(commands, 1);
  await assert.rejects(access(temporaryDirectory), /ENOENT/);
});

const privateId = 'PRIVATE_IPHONE_UDID';
const phone: IosDevice = {
  id: privateId,
  name: 'Test iPhone',
  kind: 'device',
  connected: true,
  paired: true,
  developerMode: 'enabled',
};
const success = (stdout: string): SetupCommandResult => ({ stdout, stderr: '', exitCode: 0 });
const failed: SetupCommandResult = {
  stdout: '',
  stderr: '/Users/private/signing secret=value ' + privateId,
  exitCode: 1,
  failure: 'failed',
};

function dependencies(overrides: Partial<IosSetupDetectorDependencies> = {}) {
  const calls: string[] = [];
  const defaults: IosSetupDetectorDependencies = {
    hostPlatform: 'darwin',
    command: async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      if (file === 'xcodebuild') return success('Xcode 27.0\nBuild version 27A266a\n');
      if (args[0] === '--version') return success('3.7.0\n');
      if (args[0] === 'driver') return success('{"xcuitest":{"version":"12.13.2"}}');
      throw new Error('Unexpected setup probe.');
    },
    fetchStatus: async (url) => {
      calls.push(url);
      return true;
    },
    devices: async () => {
      calls.push('devices');
      return [phone];
    },
  };
  return { calls, deps: { ...defaults, ...overrides }, defaults };
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    hardwareProperties: { platform: 'iOS', reality: 'physical', udid: privateId },
    deviceProperties: { name: phone.name, developerModeStatus: 'enabled' },
    connectionProperties: { tunnelState: 'connected', pairingState: 'paired' },
    ...overrides,
  };
}

test('iOS device discovery parses both CoreDevice formats and never uses a simulator as a phone', () => {
  const legacy = parseIosDeviceList(JSON.stringify({ result: { devices: [metadata()] } }));
  assert.deepEqual(legacy, [phone]);
  const modern = metadata({
    properties: {
      hardware: { platform: 'iOS', reality: 'physical', udid: privateId },
      state: { name: phone.name, developerModeStatus: { enabled: { mode: 1 } } },
      connection: { state: 'connected', pairingState: 'paired' },
    },
    deviceProperties: {},
  });
  const simulator = metadata({
    hardwareProperties: { platform: 'iOS', reality: 'simulated', udid: 'SIMULATOR' },
  });
  const mac = metadata({ hardwareProperties: { platform: 'macOS' } });
  assert.deepEqual(
    parseIosDeviceList(
      JSON.stringify({
        result: { devices: [simulator, mac, modern] },
      }),
    ),
    [phone],
  );
  for (const text of [
    '{}',
    '{"result":{"devices":{}}}',
    JSON.stringify({
      result: { devices: [metadata({ connectionProperties: {} })] },
    }),
  ])
    assert.throws(() => parseIosDeviceList(text), /IOS_DEVICE_CHECK_FAILED/);
});

test('iOS doctor is read-only, path-free and distinguishes preparation from WDA readiness', async () => {
  const fake = dependencies();
  const snapshot = await detectIosSetup({ device: { kind: 'device' } }, fake.deps);
  assert.equal(snapshot.canContinue, true);
  assert.equal(snapshot.platform, 'ios');
  assert.deepEqual(snapshot.available, [
    'xcode',
    'appiumCli',
    'xcuitestDriver',
    'iosDevice',
    'iosDeveloperMode',
    'appiumServer',
  ]);
  assert.match(String(snapshot.technicalDetails?.wda), /not-verified/);
  assert.match(
    String(snapshot.technicalDetails?.initializationAuthorization),
    /normal phone tasks/,
  );
  assert.doesNotMatch(String(snapshot.technicalDetails?.wda), /may build, sign/);
  assert.deepEqual(snapshot.fingerprint, {});
  assert.equal(
    fake.calls.some((call) => /\b(?:install|launch|sign|start-server|session)\b/.test(call)),
    false,
  );
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /PRIVATE_IPHONE|secret=value|private\/signing|Test iPhone/,
  );
});

test('iOS doctor preserves the exact endpoint and never checks a remote or unsupported host locally', async () => {
  const fake = dependencies({
    fetchStatus: async (url) => {
      fake.calls.push(url);
      return false;
    },
  });
  const snapshot = await detectIosSetup({ serverUrl: 'http://localhost:5555/wd/hub' }, fake.deps);
  assert.equal(snapshot.canContinue, false);
  assert.equal(snapshot.recommendedAction?.id, 'start-appium');
  assert.match(snapshot.recommendedAction?.command ?? '', /--port 5555 --base-path '\/wd\/hub'/);
  assert.doesNotMatch(fake.calls.join('\n'), /4723/);
  for (const input of [{ serverUrl: 'http://remote.example:4723' }, {}]) {
    const remote = dependencies({ hostPlatform: input.serverUrl ? 'darwin' : 'win32' });
    const result = await detectIosSetup(input, remote.deps);
    assert.equal(result.canContinue, false);
    assert.equal(
      result.capabilities[0]?.errorCode,
      input.serverUrl ? 'IOS_SETUP_REMOTE_UNSUPPORTED' : 'IOS_HOST_UNSUPPORTED',
    );
    assert.deepEqual(remote.calls, []);
  }
  const invalid = dependencies();
  await assert.rejects(
    detectIosSetup({ device: { kind: 'simulator' } }, invalid.deps),
    /IOS_SETUP_UNSUPPORTED/,
  );
  await assert.rejects(
    detectIosSetup({ device: { name: ' ' } }, invalid.deps),
    /IOS_SETUP_UNSUPPORTED/,
  );
  await assert.rejects(
    detectIosSetup({ serverUrl: 'file:///tmp/appium' }, invalid.deps),
    /Appium URL/,
  );
  assert.deepEqual(invalid.calls, []);
});

test('iOS doctor never substitutes another phone for an explicit unavailable selection', async () => {
  const offline = { ...phone, connected: false };
  const other = { ...phone, id: 'OTHER', name: 'Other iPhone' };
  const fake = dependencies({ devices: async () => [offline, other] });
  const snapshot = await detectIosSetup(
    { device: { kind: 'device', name: phone.name } },
    fake.deps,
  );
  assert.equal(snapshot.canContinue, false);
  assert.equal(snapshot.recommendedAction?.id, 'connect-ios-device');
  assert.equal(
    snapshot.capabilities.find((item) => item.id === 'iosDevice')?.errorCode,
    'IOS_DEVICE_OFFLINE',
  );
  const automatic = await detectIosSetup({ device: { kind: 'device' } }, fake.deps);
  assert.equal(automatic.canContinue, true);
  const multiple = await detectIosSetup(
    {},
    dependencies({ devices: async () => [phone, other] }).deps,
  );
  assert.equal(multiple.recommendedAction?.id, 'select-ios-device');
});

test('iOS doctor reports missing, failed, trust and Developer Mode conditions separately', async () => {
  const cases: Array<{
    overrides: Partial<IosSetupDetectorDependencies>;
    id: string;
    code: string;
  }> = [
    {
      overrides: { command: async () => ({ ...failed, exitCode: null, failure: 'not-found' }) },
      id: 'appiumCli',
      code: 'APPIUM_CLI_MISSING',
    },
    {
      overrides: { devices: async () => [{ ...phone, paired: false }] },
      id: 'iosDevice',
      code: 'IOS_DEVICE_UNPAIRED',
    },
    {
      overrides: { devices: async () => [{ ...phone, developerMode: 'disabled' }] },
      id: 'iosDeveloperMode',
      code: 'IOS_DEVELOPER_MODE_REQUIRED',
    },
    {
      overrides: {
        devices: async () => {
          throw new Error(privateId + ' private/signing');
        },
      },
      id: 'iosDevice',
      code: 'IOS_SETUP_CHECK_FAILED',
    },
  ];
  for (const item of cases) {
    const snapshot = await detectIosSetup({}, dependencies(item.overrides).deps);
    assert.equal(snapshot.canContinue, false);
    assert.equal(
      snapshot.capabilities.find((capability) => capability.id === item.id)?.errorCode,
      item.code,
    );
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_IPHONE|secret=value|private\/signing/);
  }
  const fake = dependencies();
  const absent = await detectIosSetup(
    {},
    dependencies({
      command: async (file, args, signal) =>
        args[0] === 'driver' ? success('{}') : fake.defaults.command(file, args, signal),
    }).deps,
  );
  assert.equal(
    absent.capabilities.find((item) => item.id === 'xcuitestDriver')?.errorCode,
    'XCUITEST_DRIVER_MISSING',
  );
  const timeout = await detectIosSetup(
    {},
    dependencies({
      command: async (file, args, signal) =>
        file === 'xcodebuild'
          ? { ...failed, exitCode: null, failure: 'timeout' }
          : fake.defaults.command(file, args, signal),
    }).deps,
  );
  assert.equal(timeout.capabilities.find((item) => item.id === 'xcode')?.status, 'unknown');
});

test('iOS checking aborts and restores the prior snapshot rather than reporting success', async () => {
  const controller = new AbortController();
  const fake = dependencies({
    command: async () => {
      controller.abort(new Error('user cancelled'));
      return success('Xcode 27.0');
    },
  });
  const assistant = new SetupAssistant({ iosDetectorDependencies: fake.deps });
  const before = assistant.current();
  await assert.rejects(
    assistant.check({ platform: 'ios', signal: controller.signal }),
    /user cancelled/,
  );
  assert.equal(assistant.current(), before);
  assert.equal(fake.calls.includes('devices'), false);
});

test('CoreDevice lock hints allow normal connection but are not a live unlocked proof', async () => {
  const calls: string[][] = [];
  const command = async (_file: string, args: string[]) => {
    calls.push(args);
    return success(
      JSON.stringify({
        result: {
          deviceIdentifier: privateId,
          passcodeRequired: false,
          unlockedSinceBoot: true,
        },
      }),
    );
  };
  assert.equal(await assertIosColdReadiness(privateId, undefined, command), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[calls[0].indexOf('--device') + 1], privateId);
  assert.equal(
    calls.some((args) => args.some((arg) => /launch|unlock|install/.test(arg))),
    false,
  );
  await assert.rejects(
    assertIosColdReadiness(privateId, undefined, async () =>
      success(
        JSON.stringify({
          result: { passcodeRequired: true, unlockedSinceBoot: true },
        }),
      ),
    ),
    /IOS_DEVICE_LOCKED/,
  );
  await assert.rejects(
    assertIosColdReadiness(privateId, undefined, async () => failed),
    /IOS_DEVICE_LOCK_STATE_UNKNOWN/,
  );
  await assert.rejects(
    assertIosColdReadiness(privateId, undefined, async () => success('invalid')),
    /IOS_DEVICE_LOCK_STATE_UNKNOWN/,
  );
  const controller = new AbortController();
  controller.abort(new Error('aborted'));
  await assert.rejects(assertIosColdReadiness(privateId, controller.signal, command), /aborted/);
  assert.equal(calls.length, 1);
});

test('iOS readiness resolver keeps identity and endpoint exact and checks before initialization', async () => {
  const calls: string[] = [];
  const environment: NativeEnvironment = {
    platform: 'ios',
    serverUrl: 'http://localhost:5555/wd/hub',
    device: { kind: 'device', name: phone.name },
    capabilities: {},
  };
  const deps = {
    serverReady: async (url: string) => {
      calls.push(url);
      return true;
    },
    devices: async () => [phone],
    checkColdLock: async (id: string) => {
      calls.push(id);
    },
    prepareWda: async (target: NativeEnvironment, allowed: boolean) => {
      assert.equal(target.capabilities['appium:udid'], privateId);
      assert.equal(allowed, false);
      return { 'appium:usePrebuiltWDA': true };
    },
  };
  const resolved = await resolveIosReadinessSession(environment, undefined, deps);
  assert.equal(resolved.capabilities['appium:udid'], privateId);
  assert.equal(resolved.environment.serverUrl, environment.serverUrl);
  assert.deepEqual(calls, [environment.serverUrl, privateId]);
  calls.length = 0;
  await assert.rejects(
    resolveIosReadinessSession(environment, undefined, {
      ...deps,
      serverReady: async (url) => {
        calls.push(url);
        return false;
      },
    }),
    /APPIUM_SERVER_UNAVAILABLE/,
  );
  assert.deepEqual(calls, [environment.serverUrl]);
  for (const capabilities of [
    { 'appium:options': null },
    { 'appium:options': [] },
    { 'appium:options': true },
    { 'appium:options': { udid: 'OTHER' } },
    { 'appium:options': { deviceName: 'OTHER' } },
    { 'appium:webDriverAgentUrl': 'http://localhost:8100' },
    { 'appium:options': { automationName: 'UiAutomator2' } },
    { 'appium:options': { useNewWDA: true } },
    { 'appium:options': { autoAcceptAlerts: true } },
    ...[
      'prebuildWDA',
      'useSimpleBuildTest',
      'useXctestrunFile',
      'allowProvisioningUpdates',
      'allowProvisioningDeviceRegistration',
      'launchWithIDB',
      'autoWebview',
    ].flatMap((key) => [
      { [`appium:${key}`]: true },
      { 'appium:options': { [key]: true } },
      { [`appium:${key}`]: 'true' },
    ]),
    ...[
      'agentPath',
      'bootstrapPath',
      'xcodeConfigFile',
      'prebuiltWDAPath',
      'keychainPath',
      'keychainPassword',
      'wdaBindingIP',
      'initialDeeplinkUrl',
      'safariInitialUrl',
      'app',
      'bundleId',
    ].flatMap((key) => [
      { [`appium:${key}`]: 'unverified-input' },
      { 'appium:options': { [key]: 'unverified-input' } },
    ]),
    { browserName: 'Safari' },
    { 'appium:options': { browserName: 'Safari' } },
  ]) {
    calls.length = 0;
    await assert.rejects(
      resolveIosReadinessSession({ ...environment, capabilities }, undefined, deps),
      /IOS_READINESS_UNSUPPORTED/,
    );
    assert.equal(calls.includes(privateId), false);
  }
  await assert.rejects(
    resolveIosReadinessSession(environment, undefined, {
      ...deps,
      devices: async () => [
        { ...phone, connected: false },
        { ...phone, id: 'OTHER', name: 'Other' },
      ],
    }),
    /IOS_DEVICE_UNAVAILABLE/,
  );
});
