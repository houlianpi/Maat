import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import test from 'node:test';

import { MaatApi } from '../packages/core/src/api/maat-api.ts';
import { PlatformRegistry } from '../packages/core/src/core/platforms/registry.ts';
import { createApplicationFact } from '../packages/core/src/mobile/applications/port.ts';
import {
  resolveCapabilityBackend,
  type G3ReadOnlyCapability,
} from '../packages/core/src/mobile/contracts/backend-selection.ts';
import type { DeviceIdentity } from '../packages/core/src/mobile/contracts/device.ts';
import type {
  DiscoveryKey,
  EndpointKey,
  LifecycleTarget,
  LifecycleTargetKey,
} from '../packages/core/src/mobile/contracts/lifecycle.ts';
import { createEndpointStatusView } from '../packages/core/src/mobile/endpoint/port.ts';
import type { MobileReadonlyProvider } from '../packages/core/src/mobile/integration/readonly.ts';
import {
  createProductionAndroidReadonlyProvider,
  createProductionIosReadonlyProvider,
} from '../packages/core/src/mobile/integration/production-readonly.ts';
import type {
  PreparationFactsKey,
  PreparationFactsView,
} from '../packages/core/src/mobile/preparation/port.ts';
import {
  AppiumPlatformAdapter,
  createAppiumPlatformAdapterWithInspectionProvidersForTests,
  type AppiumAdapterDefinition,
} from '../packages/core/src/platforms/appium/appium-adapter.ts';
import type { NativeEnvironment } from '../packages/core/src/platforms/appium/schema.ts';
import { setDeviceLockStateDirectoryForTests } from '../packages/core/src/mobile/devices/device-lock.ts';
import {
  AndroidExactTransportUnavailableError,
  queryAndroidPackagesReadOnly,
} from '../packages/core/src/setup/devices.ts';
import {
  SetupAssistant,
  type SetupAssistantOptions,
} from '../packages/core/src/setup-assistant/setup-assistant.ts';

const definition = (platform: 'android' | 'ios' | 'macos'): AppiumAdapterDefinition => ({
  id: platform,
  label: platform,
  platformName: platform === 'android' ? 'Android' : platform === 'ios' ? 'iOS' : 'Mac',
  automationName:
    platform === 'android' ? 'UiAutomator2' : platform === 'ios' ? 'XCUITest' : 'Mac2',
});

function identity(platform: 'android' | 'ios'): DeviceIdentity {
  return platform === 'android'
    ? {
        platform,
        providerInstanceId: 'local-adb',
        routingId: 'PRIVATE_ANDROID_ROUTING_ID',
        kind: 'device',
        transportScope: 'local-adb',
        displayName: 'Fixture Android',
      }
    : {
        platform,
        providerInstanceId: 'local-core-device',
        routingId: 'PRIVATE_IOS_ROUTING_ID',
        kind: 'device',
        transportScope: 'core-device',
        displayName: 'Fixture iPhone',
      };
}

function controlledProvider(platform: 'android' | 'ios', failure?: Error) {
  const calls = { discovery: 0, preparation: 0, applications: 0, endpoint: 0 };
  const selectedIdentity = identity(platform);
  const provider: MobileReadonlyProvider = {
    inventory: {
      async discover(requested, signal) {
        signal?.throwIfAborted();
        calls.discovery += 1;
        assert.equal(requested, platform);
        if (failure) throw failure;
        return Object.freeze({
          discoveryKey: `discovery-${calls.discovery}` as DiscoveryKey,
          platform,
          candidates: Object.freeze([
            Object.freeze({
              identity: selectedIdentity,
              disclosure: Object.freeze({
                candidateNumber: 1,
                displayName: selectedIdentity.displayName!,
                platform,
                kind: 'device' as const,
                discriminator: 'device-a1b2c3d4',
              }),
            }),
          ]),
        });
      },
    },
    preparation: {
      async inspect(target, signal) {
        signal?.throwIfAborted();
        calls.preparation += 1;
        if (failure) throw failure;
        assert.deepEqual(target.identity, selectedIdentity);
        return Object.freeze({
          key: 'facts' as PreparationFactsKey,
          platform,
          capturedAt: '2026-10-14T00:00:00.000Z',
          policyVersion: 'integration-fixture',
          compatibility: 'compatible',
          blockerCategories: Object.freeze([]),
        }) satisfies PreparationFactsView;
      },
    },
    applications: {
      async inspect(target, query, signal) {
        signal?.throwIfAborted();
        calls.applications += 1;
        if (failure) throw failure;
        const id = platform === 'android' ? 'org.example.android' : 'org.example.ios';
        const name = platform === 'android' ? 'Android Fixture' : 'iOS Fixture';
        const fact = createApplicationFact(target, {
          name,
          id,
          capabilities:
            platform === 'android' ? { 'appium:appPackage': id } : { 'appium:bundleId': id },
        });
        return `${name} ${id}`.toLowerCase().includes(query.toLowerCase()) ? [fact] : [];
      },
    },
    endpoint: {
      async inspect(target, signal) {
        signal?.throwIfAborted();
        calls.endpoint += 1;
        if (failure) throw failure;
        assert.equal(target.endpoint, 'http://127.0.0.1:4723/' as EndpointKey);
        return createEndpointStatusView({
          state: 'reachable',
          compatibility: 'compatible',
        });
      },
    },
  };
  return { provider, calls };
}

function setupOptions(platform: 'android' | 'ios', legacyCalls: Record<string, number>) {
  const command = async (file: string, args: string[]) => {
    legacyCalls.command += 1;
    if (file === 'xcodebuild') return { stdout: 'Xcode 27.0\n', stderr: '', exitCode: 0 as const };
    if (file.includes('aapt2'))
      return { stdout: 'Android Asset Packaging Tool 2\n', stderr: '', exitCode: 0 as const };
    if (file === 'adb')
      return { stdout: 'Android Debug Bridge version 1.0.41\n', stderr: '', exitCode: 0 as const };
    if (args[0] === '--version') return { stdout: '3.0.0\n', stderr: '', exitCode: 0 as const };
    if (args[0] === 'driver')
      return {
        stdout:
          platform === 'android'
            ? '{"uiautomator2":{"version":"1"}}'
            : '{"xcuitest":{"version":"1"}}',
        stderr: '',
        exitCode: 0 as const,
      };
    throw new Error(`Unexpected command ${file} ${args.join(' ')}`);
  };
  return platform === 'android'
    ? ({
        androidDetectorDependencies: {
          command,
          fetchStatus: async () => {
            legacyCalls.endpoint += 1;
            return true;
          },
          adbDevices: async () => {
            legacyCalls.preparation += 1;
            return 'LEGACY\tdevice model:Legacy\n';
          },
          sdkTools: async () => ({
            rootConfigured: true,
            adbPath: 'adb',
            aapt2Path: 'aapt2',
          }),
        },
      } satisfies SetupAssistantOptions)
    : ({
        iosDetectorDependencies: {
          hostPlatform: 'darwin',
          command,
          fetchStatus: async () => {
            legacyCalls.endpoint += 1;
            return true;
          },
          devices: async () => {
            legacyCalls.preparation += 1;
            return [
              {
                id: 'LEGACY_IOS_ID',
                name: 'Fixture iPhone',
                kind: 'device' as const,
                connected: true,
                paired: true,
                developerMode: 'enabled' as const,
              },
            ];
          },
        },
      } satisfies SetupAssistantOptions);
}

let lockRoot = '';
test.beforeEach(() => {
  lockRoot = mkdtempSync(path.join(tmpdir(), 'maat-g3-integration-'));
  setDeviceLockStateDirectoryForTests(lockRoot);
});
test.afterEach(() => {
  setDeviceLockStateDirectoryForTests(undefined);
  rmSync(lockRoot, { recursive: true, force: true });
});

for (const platform of ['android', 'ios'] as const) {
  test(`${platform} local physical read-only production path dispatches all four capabilities through G3`, async () => {
    const controlled = controlledProvider(platform);
    const legacyCalls = {
      devices: 0,
      applications: 0,
      preparation: 0,
      endpoint: 0,
      command: 0,
    };
    const resolutions: G3ReadOnlyCapability[] = [];
    const adapter = createAppiumPlatformAdapterWithInspectionProvidersForTests(
      definition(platform),
      {
        devices: async () => {
          legacyCalls.devices += 1;
          return [];
        },
        applications: async () => {
          legacyCalls.applications += 1;
          return [];
        },
        mobileReadonly: controlled.provider,
        backendResolver(route, capability, configuration) {
          resolutions.push(capability);
          return resolveCapabilityBackend(route, capability, configuration);
        },
      },
    );
    const api = new MaatApi(
      new PlatformRegistry([adapter], platform),
      process.cwd(),
      setupOptions(platform, legacyCalls),
    );
    await adapter.configureSession({
      serverUrl: 'http://127.0.0.1:4723/',
      device: { kind: 'device' },
    });

    assert.deepEqual(await api.platforms.inspectSetup({ kind: 'devices' }), [
      {
        number: 1,
        displayName: identity(platform).displayName,
        platform,
        kind: 'device',
        discriminator: 'device-a1b2c3d4',
      },
    ]);
    const selection = await adapter.selectReadinessTarget();
    assert.equal(selection?.status, 'target-selected');
    assert.deepEqual(await api.platforms.inspectSetup({ kind: 'applications', query: 'fixture' }), [
      {
        name: platform === 'android' ? 'Android Fixture' : 'iOS Fixture',
        id: platform === 'android' ? 'org.example.android' : 'org.example.ios',
        capabilities:
          platform === 'android'
            ? { 'appium:appPackage': 'org.example.android' }
            : { 'appium:bundleId': 'org.example.ios' },
      },
    ]);
    const snapshot = await api.setup.check({ platform });
    const legacySnapshot = await new SetupAssistant(
      setupOptions(platform, {
        devices: 0,
        applications: 0,
        preparation: 0,
        endpoint: 0,
        command: 0,
      }),
    ).check({
      platform,
      serverUrl: 'http://127.0.0.1:4723/',
      device: {
        kind: 'device',
        name: platform === 'android' ? 'Legacy' : 'Fixture iPhone',
      },
    });

    assert.equal(snapshot.platform, platform);
    assert.equal(snapshot.capabilities.find(({ id }) => id === 'appiumServer')?.status, 'ready');
    assert.equal(
      snapshot.capabilities.find(({ id }) => id === `${platform}Device`)?.status,
      'ready',
    );
    assert.deepEqual(
      { ...snapshot, checkedAt: '<timestamp>' },
      { ...legacySnapshot, checkedAt: '<timestamp>' },
    );
    assert.deepEqual(controlled.calls, {
      discovery: 2,
      preparation: 1,
      applications: 1,
      endpoint: 1,
    });
    assert.deepEqual(legacyCalls, {
      devices: 0,
      applications: 0,
      preparation: 0,
      endpoint: 0,
      command: platform === 'android' ? 5 : 3,
    });
    assert.deepEqual(resolutions, [
      'discovery',
      'discovery',
      'application-inspection',
      'preparation-facts',
      'endpoint-status',
    ]);
    assert.equal(adapter.runtime.isRunning, false);
    assert.equal(adapter.runtime.currentSessionGeneration, undefined);
    assert.doesNotMatch(
      JSON.stringify({ devices: await api.platforms.inspectSetup({ kind: 'devices' }), snapshot }),
      /PRIVATE_(?:ANDROID|IOS)_ROUTING_ID|127\.0\.0\.1:4723/,
    );
    await adapter.close();
  });
}

test('G3 rejection and pre-Abort propagate without legacy fallback or later read-only probes', async () => {
  const failure = new Error('controlled G3 failure');
  const controlled = controlledProvider('android', failure);
  let legacyDevices = 0;
  const adapter = createAppiumPlatformAdapterWithInspectionProvidersForTests(
    definition('android'),
    {
      devices: async () => {
        legacyDevices += 1;
        return [];
      },
      applications: async () => [],
      mobileReadonly: controlled.provider,
    },
  );
  await assert.rejects(adapter.inspectSetup({ kind: 'devices' }), (error) => error === failure);
  assert.equal(controlled.calls.discovery, 1);
  assert.equal(legacyDevices, 0);

  const controller = new AbortController();
  const reason = new Error('controlled abort');
  controller.abort(reason);
  const api = new MaatApi(new PlatformRegistry([adapter], 'android'), process.cwd());
  await assert.rejects(
    api.setup.check({ platform: 'android', signal: controller.signal }),
    (error) => error === reason,
  );
  assert.deepEqual(controlled.calls, {
    discovery: 1,
    preparation: 0,
    applications: 0,
    endpoint: 0,
  });
});

test('remote, emulator, simulator, and macOS inspections stay on legacy providers', async () => {
  for (const [platform, environment] of [
    [
      'android',
      {
        platform: 'android',
        serverUrl: 'http://remote.example.test:4723/',
        device: { kind: 'device', name: 'Remote' },
        capabilities: {},
      },
    ],
    [
      'android',
      {
        platform: 'android',
        device: { kind: 'emulator', name: 'Emulator' },
        capabilities: {},
      },
    ],
    [
      'ios',
      {
        platform: 'ios',
        device: { kind: 'simulator', name: 'Simulator' },
        capabilities: {},
      },
    ],
    ['macos', { platform: 'macos', capabilities: {} }],
  ] as const) {
    const g3 = platform === 'macos' ? undefined : controlledProvider(platform).provider;
    let legacyDevices = 0;
    let legacyApplications = 0;
    const adapter = createAppiumPlatformAdapterWithInspectionProvidersForTests(
      definition(platform),
      {
        devices: async () => {
          legacyDevices += 1;
          return [
            {
              id: 'LEGACY',
              name: 'Legacy',
              kind: platform === 'macos' ? 'host' : environment.device!.kind,
            },
          ];
        },
        applications: async () => {
          legacyApplications += 1;
          return [{ name: 'Legacy App', id: 'org.example.legacy' }];
        },
        ...(g3 ? { mobileReadonly: g3 } : {}),
      },
    );
    await adapter.configureSession(environment as NativeEnvironment);
    await adapter.inspectSetup({ kind: 'devices' });
    await adapter.inspectSetup({ kind: 'applications', query: 'legacy' });
    assert.deepEqual(
      { legacyDevices, legacyApplications },
      { legacyDevices: 1, legacyApplications: 1 },
    );
    assert.equal(adapter.runtime.isRunning, false);
  }
});

test('internal composition symbols do not enter Core root exports', async () => {
  const core = await import('../packages/core/src/index.ts');
  assert.equal('mobileReadonlyFacadeSymbol' in core, false);
  assert.equal('setupReadonlyCheckSymbol' in core, false);
  assert.equal('setupReadonlyContextSymbol' in core, false);
});

test('production Android app inspection uses exact host routing and returns safe failures', async () => {
  const selected = identity('android');
  const target: LifecycleTarget = {
    key: 'target' as LifecycleTargetKey,
    identity: selected,
    endpoint: 'http://127.0.0.1:4723/' as EndpointKey,
    selectedBy: 'single-candidate',
    disclosure: {
      platform: 'android',
      kind: 'device',
      label: 'Fixture Android',
      selectedBy: 'single-candidate',
    },
  };
  let received = '';
  const provider = createProductionAndroidReadonlyProvider(
    new Uint8Array(32),
    async () => [],
    async (serial, signal) => {
      signal?.throwIfAborted();
      received = serial;
      return ['org.example.one'];
    },
  );
  assert.deepEqual(
    (await provider.applications.inspect(target, 'example')).map(({ id }) => id),
    ['org.example.one'],
  );
  assert.equal(received, selected.routingId);

  for (const [failure, expected] of [
    [
      new AndroidExactTransportUnavailableError(),
      'SELECTED_DEVICE_UNAVAILABLE: the selected phone is unavailable; no other device was used.',
    ],
    [
      new Error(`ECONNREFUSED /private/adb ${selected.routingId}`),
      'APPLICATION_INSPECTION_FAILED: installed applications could not be read.',
    ],
    [
      new Error(`shell exit 1 ${selected.routingId} ${target.endpoint}`),
      'APPLICATION_INSPECTION_FAILED: installed applications could not be read.',
    ],
  ] as const) {
    const failing = createProductionAndroidReadonlyProvider(
      new Uint8Array(32),
      async () => [],
      async () => {
        throw failure;
      },
    );
    await assert.rejects(failing.applications.inspect(target, ''), (error: unknown) => {
      assert.equal((error as Error).message, expected);
      const reachable = JSON.stringify(error, Object.getOwnPropertyNames(error as object));
      assert.doesNotMatch(reachable, /PRIVATE_ANDROID|private\/adb|127\.0\.0\.1|ECONNREFUSED/);
      assert.equal((error as Error).cause, undefined);
      return true;
    });
  }
});

test('Android host protocol distinguishes exact transport FAIL from shell failure', async () => {
  const connector = (responses: Buffer[]) => () => {
    let request = 0;
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        const response = responses[request++];
        if (response) queueMicrotask(() => socket.push(response));
        callback();
      },
    }) as Socket;
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  };
  const daemonText = 'device PRIVATE_ANDROID not found';
  await assert.rejects(
    queryAndroidPackagesReadOnly(
      'PRIVATE_ANDROID',
      undefined,
      connector([
        Buffer.from(
          `FAIL${Buffer.byteLength(daemonText).toString(16).padStart(4, '0')}${daemonText}`,
        ),
      ]),
    ),
    AndroidExactTransportUnavailableError,
  );

  const unavailableDaemon = () => {
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    }) as Socket;
    queueMicrotask(() => socket.emit('error', new Error('ECONNREFUSED PRIVATE_ANDROID')));
    return socket;
  };
  await assert.rejects(
    queryAndroidPackagesReadOnly('PRIVATE_ANDROID', undefined, unavailableDaemon),
    (error: unknown) => {
      assert.match((error as Error).message, /ADB daemon unavailable/);
      assert.doesNotMatch((error as Error).message, /PRIVATE_ANDROID|ECONNREFUSED/);
      return true;
    },
  );

  const exitFrame = Buffer.alloc(6);
  exitFrame[0] = 3;
  exitFrame.writeUInt32LE(1, 1);
  exitFrame[5] = 1;
  await assert.rejects(
    queryAndroidPackagesReadOnly(
      'PRIVATE_ANDROID',
      undefined,
      connector([Buffer.from('OKAY'), Buffer.concat([Buffer.from('OKAY'), exitFrame])]),
    ),
    /ADB shell command failed/,
  );
});

test('iOS preparation blockers affect only their existing public capabilities', async () => {
  const cases = [
    ['pairing-unknown', 'ready'],
    ['trust-required', 'ready'],
    ['developer-mode-required', 'ready'],
    ['artifact-incompatible', 'unknown'],
    ['artifact-compatibility-unknown', 'unknown'],
    ['signing-required', 'unknown'],
    ['signing-compatibility-unknown', 'unknown'],
    ['driver-incompatible', 'unknown'],
    ['driver-compatibility-unknown', 'unknown'],
  ] as const;
  for (const [blocker, expectedDriver] of cases) {
    const controlled = controlledProvider('ios');
    const provider: MobileReadonlyProvider = {
      ...controlled.provider,
      preparation: {
        async inspect() {
          return {
            key: 'unknown' as PreparationFactsKey,
            platform: 'ios',
            capturedAt: '2026-10-14T00:00:00.000Z',
            policyVersion: 'unknown-fixture',
            compatibility: 'unknown',
            blockerCategories: [blocker],
          };
        },
      },
    };
    const adapter = createAppiumPlatformAdapterWithInspectionProvidersForTests(definition('ios'), {
      devices: async () => [],
      applications: async () => [],
      mobileReadonly: provider,
    });
    await adapter.configureSession({
      serverUrl: 'http://127.0.0.1:4723/',
      device: { kind: 'device' },
    });
    await adapter.selectReadinessTarget();
    const snapshot = await new MaatApi(
      new PlatformRegistry([adapter], 'ios'),
      process.cwd(),
      setupOptions('ios', {
        devices: 0,
        applications: 0,
        preparation: 0,
        endpoint: 0,
        command: 0,
      }),
    ).setup.check({ platform: 'ios' });
    assert.equal(snapshot.canContinue, false, blocker);
    assert.equal(
      snapshot.capabilities.find(({ id }) => id === 'xcuitestDriver')?.status,
      expectedDriver,
      blocker,
    );
    assert.deepEqual(
      snapshot.capabilities.map(({ id }) => id),
      ['xcode', 'appiumCli', 'xcuitestDriver', 'iosDevice', 'iosDeveloperMode', 'appiumServer'],
    );
    await adapter.close();
  }
});

test('production iOS application failures expose no UDID, endpoint, or temporary path', async () => {
  const selected = identity('ios');
  const target: LifecycleTarget = {
    key: 'ios-target' as LifecycleTargetKey,
    identity: selected,
    endpoint: 'http://127.0.0.1:4723/' as EndpointKey,
    selectedBy: 'single-candidate',
    disclosure: {
      platform: 'ios',
      kind: 'device',
      label: 'Fixture iPhone',
      selectedBy: 'single-candidate',
    },
  };
  const provider = createProductionIosReadonlyProvider(
    async () => [
      {
        id: selected.routingId,
        name: 'Fixture iPhone',
        kind: 'device',
        connected: true,
        paired: true,
        developerMode: 'enabled',
      },
    ],
    async () => {
      throw new Error(`/private/tmp/apps.json --device ${selected.routingId} ${target.endpoint}`);
    },
  );
  await assert.rejects(provider.applications.inspect(target, ''), (error: unknown) => {
    assert.equal(
      (error as Error).message,
      'APPLICATION_INSPECTION_FAILED: installed applications could not be read.',
    );
    const reachable = JSON.stringify(error, Object.getOwnPropertyNames(error as object));
    assert.doesNotMatch(reachable, /PRIVATE_IOS|private\/tmp|127\.0\.0\.1/);
    assert.equal((error as Error).cause, undefined);
    return true;
  });
});
