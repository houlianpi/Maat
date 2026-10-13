import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAndroidReadonlyProvider,
  type AndroidAdbDeviceFact,
  type AndroidReadonlyProviderDependencies,
} from '../packages/core/src/mobile/android/readonly-provider.ts';
import type { DeviceIdentity } from '../packages/core/src/mobile/contracts/device.ts';
import type {
  EndpointKey,
  LifecycleTarget,
  LifecycleTargetKey,
} from '../packages/core/src/mobile/contracts/lifecycle.ts';

const opaque = <T>(value: string) => value as T;
const rawSerial = 'PRIVATE_ANDROID_SERIAL_A';
const endpoint = opaque<EndpointKey>('PRIVATE_ENDPOINT_KEY');
const identity: DeviceIdentity = {
  platform: 'android',
  providerInstanceId: 'local-adb',
  routingId: rawSerial,
  kind: 'device',
  transportScope: 'local-adb',
  displayName: 'Fixture Phone',
};
const target: LifecycleTarget = {
  key: opaque<LifecycleTargetKey>('PRIVATE_TARGET_KEY'),
  identity,
  endpoint,
  selectedBy: 'single-candidate',
  disclosure: {
    platform: 'android',
    kind: 'device',
    label: 'Fixture Phone',
    selectedBy: 'single-candidate',
  },
};

function fixture(overrides: Partial<AndroidReadonlyProviderDependencies> = {}) {
  const dependencies: AndroidReadonlyProviderDependencies = {
    adbDevices: async () => [],
    applications: async () => [],
    endpointStatus: async () => ({ state: 'configured' }),
    now: () => new Date('2026-10-13T00:00:00.000Z'),
    randomId: () => 'fixture-random-key',
    discriminatorSecret: new Uint8Array(32).fill(7),
    ...overrides,
  };
  return { provider: createAndroidReadonlyProvider(dependencies) };
}

test('discovery exposes zero, one, or multiple sanitized local physical candidates only', async () => {
  const variants: readonly (readonly AndroidAdbDeviceFact[])[] = [
    [],
    [{ routingId: rawSerial, kind: 'device', status: 'online', model: 'Pixel_One' }],
    [
      { routingId: rawSerial, kind: 'device', status: 'online', model: 'Pixel_One' },
      {
        routingId: 'PRIVATE_ANDROID_SERIAL_B',
        kind: 'device',
        status: 'online',
        model: 'Pixel_One',
      },
      { routingId: 'emulator-5554', kind: 'emulator', status: 'online' },
      { routingId: 'PRIVATE_OFFLINE', kind: 'device', status: 'offline' },
    ],
  ];

  for (const [index, facts] of variants.entries()) {
    let calls = 0;
    const { provider } = fixture({
      adbDevices: async () => {
        calls += 1;
        return facts;
      },
    });
    const snapshot = await provider.inventory.discover('android');
    assert.equal(snapshot.candidates.length, index);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(snapshot).includes('emulator-5554'), false);
    assert.equal(JSON.stringify(snapshot).includes('PRIVATE_OFFLINE'), false);
    for (const candidate of snapshot.candidates) {
      assert.equal(candidate.identity.providerInstanceId, 'local-adb');
      assert.equal(candidate.identity.kind, 'device');
      assert.match(candidate.disclosure.discriminator, /^device-[0-9a-f]{8}$/);
      assert.equal(
        candidate.disclosure.discriminator.includes(candidate.identity.routingId),
        false,
      );
    }
  }
});

test('discovery uses a generic public label when model is absent without disclosing serial', async () => {
  const { provider } = fixture({
    adbDevices: async () => [{ routingId: rawSerial, kind: 'device', status: 'online' }],
  });
  const snapshot = await provider.inventory.discover('android');
  assert.equal(snapshot.candidates[0]?.disclosure.displayName, 'Android device');
  assert.equal(snapshot.candidates[0]?.identity.displayName, 'Android device');
  assert.equal(JSON.stringify(snapshot.candidates[0]?.disclosure).includes(rawSerial), false);
});

test('preparation performs one inspection only and reports online and blocker facts explicitly', async () => {
  for (const [status, compatibility, blockers] of [
    ['online', 'compatible', []],
    ['unauthorized', 'unknown', ['android-device-unauthorized']],
    ['offline', 'unknown', ['android-device-offline']],
    ['unknown', 'unknown', ['android-device-state-unknown']],
  ] as const) {
    let probes = 0;
    const { provider } = fixture({
      adbDevices: async () => {
        probes += 1;
        return [{ routingId: rawSerial, kind: 'device', status }];
      },
    });
    const result = await provider.preparation.inspect(target);
    assert.equal(probes, 1);
    assert.equal(result.compatibility, compatibility);
    assert.deepEqual(result.blockerCategories, blockers);
    assert.equal(result.capturedAt, '2026-10-13T00:00:00.000Z');
    assert.deepEqual(Object.keys(provider.preparation), ['inspect']);
  }

  const { provider } = fixture();
  assert.deepEqual((await provider.preparation.inspect(target)).blockerCategories, [
    'android-device-state-unknown',
  ]);
});

test('application inspection receives exact routing identity, filters case-insensitively, and sanitizes output', async () => {
  let received: Readonly<{ identity: DeviceIdentity; endpoint: EndpointKey }> | undefined;
  const { provider } = fixture({
    applications: async (exactRoute) => {
      received = exactRoute;
      return [
        { name: 'Example App', id: 'org.example.alpha' },
        { name: 'Other', id: 'org.example.BETA' },
      ];
    },
  });
  const applications = await provider.applications.inspect(target, 'ExAmPlE.a');
  assert.equal(received?.identity, identity);
  assert.equal(received?.endpoint, endpoint);
  assert.equal(Object.isFrozen(received), true);
  assert.deepEqual(
    applications.map(({ name, id, capabilities }) => ({ name, id, capabilities })),
    [
      {
        name: 'Example App',
        id: 'org.example.alpha',
        capabilities: { 'appium:appPackage': 'org.example.alpha' },
      },
    ],
  );
  assert.equal(JSON.stringify(applications).includes(rawSerial), false);
  assert.equal(Object.isFrozen(applications[0]), true);
});

test('application adapter seam fails closed on endpoint mismatch without invoking its probe', async () => {
  const configuredEndpoint = opaque<EndpointKey>('EXPECTED_PINNED_ENDPOINT');
  let adapterCalls = 0;
  let probeCalls = 0;
  const { provider } = fixture({
    applications: async (route) => {
      adapterCalls += 1;
      if (route.endpoint !== configuredEndpoint) throw new Error('APPLICATION_ENDPOINT_MISMATCH');
      probeCalls += 1;
      return [];
    },
  });

  await assert.rejects(provider.applications.inspect(target, ''), /APPLICATION_ENDPOINT_MISMATCH/);
  assert.equal(adapterCalls, 1);
  assert.equal(probeCalls, 0);
});

test('application inspection rejects path, activity, and malformed dependency metadata', async () => {
  for (const application of [
    { name: 'Bad', id: 'org.example.bad', path: '/private/app.apk' },
    { name: 'Bad', id: 'org.example.bad', activity: '.PrivateActivity' },
    { name: 'Bad', id: '' },
  ]) {
    const { provider } = fixture({ applications: async () => [application] });
    await assert.rejects(
      provider.applications.inspect(target, ''),
      /Invalid Android application metadata/,
    );
  }
});

test('endpoint inspection probes only the pinned endpoint and returns a sanitized status view', async () => {
  let received: EndpointKey | undefined;
  const { provider } = fixture({
    endpointStatus: async (exactEndpoint) => {
      received = exactEndpoint;
      return { state: 'reachable', compatibility: 'compatible' };
    },
  });
  const status = await provider.endpointStatus.inspect(target);
  assert.equal(received, endpoint);
  assert.deepEqual(
    {
      state: status.state,
      ...('compatibility' in status ? { compatibility: status.compatibility } : {}),
    },
    { state: 'reachable', compatibility: 'compatible' },
  );
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes(String(endpoint)), false);
  assert.equal(serialized.includes('ready'), false);
  assert.equal(serialized.includes(rawSerial), false);
});

test('Abort and probe rejection propagate unchanged without retry, fallback, or side effects', async () => {
  const abortReason = new Error('fixture abort');
  const controller = new AbortController();
  controller.abort(abortReason);
  let calls = 0;
  const preAborted = fixture({
    adbDevices: async () => {
      calls += 1;
      return [];
    },
    applications: async () => {
      calls += 1;
      return [];
    },
    endpointStatus: async () => {
      calls += 1;
      return { state: 'configured' };
    },
  }).provider;
  await assert.rejects(
    preAborted.inventory.discover('android', controller.signal),
    (error) => error === abortReason,
  );
  await assert.rejects(
    preAborted.preparation.inspect(target, controller.signal),
    (error) => error === abortReason,
  );
  await assert.rejects(
    preAborted.applications.inspect(target, '', controller.signal),
    (error) => error === abortReason,
  );
  await assert.rejects(
    preAborted.endpointStatus.inspect(target, controller.signal),
    (error) => error === abortReason,
  );
  assert.equal(calls, 0);

  for (const operation of ['discovery', 'preparation', 'applications', 'endpoint'] as const) {
    const rejection = new Error(`fixture ${operation} rejection`);
    let probes = 0;
    const { provider } = fixture({
      adbDevices: async () => {
        probes += 1;
        throw rejection;
      },
      applications: async () => {
        probes += 1;
        throw rejection;
      },
      endpointStatus: async () => {
        probes += 1;
        throw rejection;
      },
    });
    const promise =
      operation === 'discovery'
        ? provider.inventory.discover('android')
        : operation === 'preparation'
          ? provider.preparation.inspect(target)
          : operation === 'applications'
            ? provider.applications.inspect(target, '')
            : provider.endpointStatus.inspect(target);
    await assert.rejects(promise, (error) => error === rejection);
    assert.equal(probes, 1);
  }
});

test('non-local, emulator, remote-like, and iOS targets never reach a probe', async () => {
  let probes = 0;
  const { provider } = fixture({
    adbDevices: async () => {
      probes += 1;
      return [];
    },
    applications: async () => {
      probes += 1;
      return [];
    },
    endpointStatus: async () => {
      probes += 1;
      return {};
    },
  });
  const invalidTargets: LifecycleTarget[] = [
    { ...target, identity: { ...identity, kind: 'emulator' } },
    {
      ...target,
      identity: {
        ...identity,
        providerInstanceId: 'local-core-device',
        transportScope: 'core-device',
      },
    },
    {
      ...target,
      identity: {
        ...identity,
        platform: 'ios',
        providerInstanceId: 'local-core-device',
        transportScope: 'core-device',
      },
    },
  ];
  for (const invalid of invalidTargets) {
    await assert.rejects(provider.preparation.inspect(invalid), /local physical Android/);
    await assert.rejects(provider.applications.inspect(invalid, ''), /local physical Android/);
    await assert.rejects(provider.endpointStatus.inspect(invalid), /local physical Android/);
  }
  await assert.rejects(provider.inventory.discover('ios'), /supports only Android/);
  assert.equal(probes, 0);
});
