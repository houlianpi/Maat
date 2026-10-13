import assert from 'node:assert/strict';
import test from 'node:test';

import type { IosDevice } from '../packages/core/src/setup/ios-devices.ts';
import type {
  EndpointKey,
  LifecycleTarget,
  LifecycleTargetKey,
} from '../packages/core/src/mobile/contracts/lifecycle.ts';
import {
  createIosLocalPhysicalReadOnlyProvider,
  type IosLocalPhysicalRoute,
  type IosPreparationProbeFacts,
  type IosReadOnlyProviderDependencies,
} from '../packages/core/src/mobile/ios/readonly-provider.ts';

const opaque = <T>(value: string) => value as T;
const privateUdid = 'PRIVATE-IOS-UDID-0001';
const privateEndpoint = opaque<EndpointKey>('PRIVATE-ENDPOINT-KEY');

const target: LifecycleTarget = {
  key: opaque<LifecycleTargetKey>('private-target-key'),
  endpoint: privateEndpoint,
  identity: {
    platform: 'ios',
    providerInstanceId: 'local-core-device',
    routingId: privateUdid,
    kind: 'device',
    transportScope: 'core-device',
    displayName: 'Fixture iPhone',
  },
  selectedBy: 'single-candidate',
  disclosure: {
    platform: 'ios',
    kind: 'device',
    label: 'Fixture iPhone',
    selectedBy: 'single-candidate',
  },
};

const phones: readonly IosDevice[] = [
  {
    id: privateUdid,
    name: 'Fixture iPhone',
    kind: 'device',
    connected: true,
    paired: true,
    developerMode: 'enabled',
  },
  {
    id: 'PRIVATE-IOS-UDID-0002',
    name: 'Second iPhone',
    kind: 'device',
    connected: true,
    paired: undefined,
    developerMode: 'unknown',
  },
];

const compatiblePreparation: IosPreparationProbeFacts = {
  pairing: 'paired',
  trust: 'trusted',
  developerMode: 'enabled',
  artifact: 'compatible',
  signing: 'compatible',
  driver: 'compatible',
};

function fixture(overrides: Partial<IosReadOnlyProviderDependencies> = {}): {
  provider: ReturnType<typeof createIosLocalPhysicalReadOnlyProvider>;
  calls: {
    discovery: number;
    preparation: number;
    applications: number;
    endpoint: number;
  };
  routes: IosLocalPhysicalRoute[];
  endpoints: EndpointKey[];
} {
  const calls = { discovery: 0, preparation: 0, applications: 0, endpoint: 0 };
  const routes: IosLocalPhysicalRoute[] = [];
  const endpoints: EndpointKey[] = [];
  const dependencies: IosReadOnlyProviderDependencies = {
    async discover(signal) {
      calls.discovery += 1;
      if (overrides.discover) return overrides.discover(signal);
      return phones;
    },
    async inspectPreparation(route, signal) {
      calls.preparation += 1;
      routes.push(route);
      if (overrides.inspectPreparation) return overrides.inspectPreparation(route, signal);
      return compatiblePreparation;
    },
    async inspectApplications(route, signal) {
      calls.applications += 1;
      routes.push(route);
      if (overrides.inspectApplications) return overrides.inspectApplications(route, signal);
      return [
        {
          name: 'WeChat',
          id: 'com.tencent.xin',
          capabilities: { 'appium:bundleId': 'com.tencent.xin' },
        },
        {
          name: 'Calculator',
          id: 'com.apple.calculator',
          capabilities: { 'appium:bundleId': 'com.apple.calculator' },
        },
      ];
    },
    async inspectEndpoint(endpoint, signal) {
      calls.endpoint += 1;
      endpoints.push(endpoint);
      if (overrides.inspectEndpoint) return overrides.inspectEndpoint(endpoint, signal);
      return { state: 'reachable', compatibility: 'compatible' };
    },
    now: overrides.now ?? (() => new Date('2026-10-13T12:00:00.000Z')),
  };
  return {
    provider: createIosLocalPhysicalReadOnlyProvider(dependencies),
    calls,
    routes,
    endpoints,
  };
}

test('mock CoreDevice discovery returns zero, one, or multiple sanitized physical candidates', async () => {
  for (const count of [0, 1, 2]) {
    const fake = fixture({ discover: async () => phones.slice(0, count) });
    const snapshot = await fake.provider.discover('ios');

    assert.equal(snapshot.platform, 'ios');
    assert.equal(snapshot.candidates.length, count);
    assert.equal(typeof snapshot.discoveryKey, 'string');
    assert.equal(fake.calls.preparation, 0);
    assert.equal(fake.calls.applications, 0);
    assert.equal(fake.calls.endpoint, 0);
    for (const [index, candidate] of snapshot.candidates.entries()) {
      assert.equal(candidate.identity.routingId, phones[index]?.id);
      assert.deepEqual(
        {
          candidateNumber: candidate.disclosure.candidateNumber,
          displayName: candidate.disclosure.displayName,
          platform: candidate.disclosure.platform,
          kind: candidate.disclosure.kind,
        },
        {
          candidateNumber: index + 1,
          displayName: phones[index]?.name,
          platform: 'ios',
          kind: 'device',
        },
      );
      assert.match(candidate.disclosure.discriminator, /^device-[a-f0-9]{8}$/);
      assert.doesNotMatch(
        JSON.stringify(candidate.disclosure),
        /PRIVATE-IOS-UDID|PRIVATE-ENDPOINT|private-target/,
      );
    }
    assert.equal(
      new Set(snapshot.candidates.map(({ disclosure }) => disclosure.discriminator)).size,
      count,
    );
  }
});

test('discovery excludes disconnected devices and rejects non-iOS use without probing', async () => {
  const fake = fixture({
    discover: async () => [
      { ...phones[0]!, connected: false },
      { ...phones[1]!, connected: true },
    ],
  });
  const snapshot = await fake.provider.discover('ios');
  assert.equal(snapshot.candidates.length, 1);
  assert.equal(snapshot.candidates[0]?.identity.routingId, phones[1]?.id);

  await assert.rejects(fake.provider.discover('android'), /IOS_G3_PLATFORM_UNSUPPORTED/);
  assert.equal(fake.calls.discovery, 1);
});

test('preparation is inspect-only, exact-target, and makes unknown facts explicit blockers', async () => {
  const fake = fixture({
    inspectPreparation: async (route) => {
      assert.deepEqual(route, { udid: privateUdid, endpoint: privateEndpoint });
      return {
        pairing: 'unknown',
        trust: 'unknown',
        developerMode: 'unknown',
        artifact: 'unknown',
        signing: 'unknown',
        driver: 'unknown',
      };
    },
  });
  const facts = await fake.provider.preparation.inspect(target);

  assert.deepEqual(fake.routes, [{ udid: privateUdid, endpoint: privateEndpoint }]);
  assert.equal(facts.platform, 'ios');
  assert.equal(facts.capturedAt, '2026-10-13T12:00:00.000Z');
  assert.equal(facts.policyVersion, 'g3-ios-readonly-v1');
  assert.equal(facts.compatibility, 'unknown');
  assert.deepEqual(facts.blockerCategories, [
    'pairing-unknown',
    'trust-unknown',
    'developer-mode-unknown',
    'artifact-compatibility-unknown',
    'signing-compatibility-unknown',
    'driver-compatibility-unknown',
  ]);
  assert.equal('plan' in fake.provider.preparation, false);
  assert.equal('execute' in fake.provider.preparation, false);
  assert.deepEqual(fake.calls, {
    discovery: 0,
    preparation: 1,
    applications: 0,
    endpoint: 0,
  });
});

test('preparation reports explicit incompatibility without executing any action', async () => {
  const fake = fixture({
    inspectPreparation: async () => ({
      ...compatiblePreparation,
      pairing: 'unpaired',
      trust: 'untrusted',
      developerMode: 'disabled',
      artifact: 'incompatible',
      signing: 'incompatible',
      driver: 'incompatible',
    }),
  });
  const facts = await fake.provider.preparation.inspect(target);
  assert.equal(facts.compatibility, 'incompatible');
  assert.deepEqual(facts.blockerCategories, [
    'pairing-required',
    'trust-required',
    'developer-mode-required',
    'artifact-incompatible',
    'signing-required',
    'driver-incompatible',
  ]);
  assert.equal(fake.calls.preparation, 1);
});

test('preparation accepts a complete compatible plain-data fact object', async () => {
  const fake = fixture();
  const facts = await fake.provider.preparation.inspect(target);

  assert.equal(facts.compatibility, 'compatible');
  assert.deepEqual(facts.blockerCategories, []);
  assert.equal(fake.calls.preparation, 1);
});

test('preparation rejects malformed untrusted probe facts with a stable non-reflective error', async () => {
  const privateProbeValue = 'PRIVATE_PREPARATION_PROBE_VALUE';
  const symbol = Symbol('private-preparation-symbol');
  const malformed: readonly unknown[] = [
    {},
    {
      pairing: 'paired',
      trust: 'trusted',
      developerMode: 'enabled',
      artifact: 'compatible',
      signing: 'compatible',
    },
    { ...compatiblePreparation, driver: privateProbeValue },
    { ...compatiblePreparation, extra: privateProbeValue },
    Object.assign({ ...compatiblePreparation }, { [symbol]: privateProbeValue }),
  ];

  for (const probeResult of malformed) {
    const fake = fixture({ inspectPreparation: async () => probeResult });
    await assert.rejects(fake.provider.preparation.inspect(target), (error) => {
      assert.equal(
        (error as Error).message,
        'IOS_PREPARATION_FACTS_INVALID: read-only preparation probe returned invalid facts.',
      );
      assert.doesNotMatch((error as Error).message, /PRIVATE_PREPARATION|private-preparation/);
      return true;
    });
    assert.equal(fake.calls.preparation, 1);
  }
});

test('preparation validation rejects accessors without invoking normal or throwing getters', async () => {
  let normalGetterReads = 0;
  const getterFacts = { ...compatiblePreparation } as Record<PropertyKey, unknown>;
  Object.defineProperty(getterFacts, 'pairing', {
    enumerable: true,
    get() {
      normalGetterReads += 1;
      return 'paired';
    },
  });

  let throwingGetterReads = 0;
  const throwingGetterFacts = { ...compatiblePreparation } as Record<PropertyKey, unknown>;
  Object.defineProperty(throwingGetterFacts, 'trust', {
    enumerable: true,
    get() {
      throwingGetterReads += 1;
      throw new Error('PRIVATE_THROWING_GETTER_VALUE');
    },
  });

  for (const probeResult of [getterFacts, throwingGetterFacts]) {
    const fake = fixture({ inspectPreparation: async () => probeResult });
    await assert.rejects(
      fake.provider.preparation.inspect(target),
      (error) =>
        (error as Error).message ===
        'IOS_PREPARATION_FACTS_INVALID: read-only preparation probe returned invalid facts.',
    );
    assert.equal(fake.calls.preparation, 1);
  }
  assert.equal(normalGetterReads, 0);
  assert.equal(throwingGetterReads, 0);
});

test('application inspection binds the exact route, filters case-insensitively, and sanitizes facts', async () => {
  const fake = fixture();
  const applications = await fake.provider.applications.inspect(target, 'TENCENT.X');

  assert.deepEqual(fake.routes, [{ udid: privateUdid, endpoint: privateEndpoint }]);
  assert.deepEqual(
    applications.map(({ name, id, capabilities }) => ({ name, id, capabilities })),
    [
      {
        name: 'WeChat',
        id: 'com.tencent.xin',
        capabilities: { 'appium:bundleId': 'com.tencent.xin' },
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(applications),
    /PRIVATE-IOS-UDID|PRIVATE-ENDPOINT|private-target|Session|\/Users\//,
  );
  assert.equal(Object.isFrozen(applications), true);
  assert.equal(Object.isFrozen(applications[0]), true);
  assert.deepEqual(fake.calls, {
    discovery: 0,
    preparation: 0,
    applications: 1,
    endpoint: 0,
  });
});

test('application boundary rejects probe metadata that could leak paths or Sessions', async () => {
  const fake = fixture({
    inspectApplications: async () => [
      {
        name: 'WeChat',
        id: 'com.tencent.xin',
        capabilities: { 'appium:bundleId': 'com.tencent.xin' },
        path: '/Users/private/WeChat.app',
      },
    ],
  });
  await assert.rejects(
    fake.provider.applications.inspect(target, ''),
    /Invalid ios application fact/,
  );
});

test('endpoint inspection receives only the pinned endpoint and returns a sanitized status view', async () => {
  const fake = fixture();
  const status = await fake.provider.endpoint.inspect(target);

  assert.deepEqual(fake.endpoints, [privateEndpoint]);
  assert.deepEqual(
    {
      state: status.state,
      ...('compatibility' in status ? { compatibility: status.compatibility } : {}),
    },
    { state: 'reachable', compatibility: 'compatible' },
  );
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE-ENDPOINT|PRIVATE-IOS-UDID|Session/);
  assert.equal(Object.isFrozen(status), true);
  assert.deepEqual(fake.calls, {
    discovery: 0,
    preparation: 0,
    applications: 0,
    endpoint: 1,
  });
});

test('simulator, remote-shaped, and wrong-platform targets never enter a read-only probe', async () => {
  const fake = fixture();
  const unsupported: LifecycleTarget[] = [
    {
      ...target,
      identity: { ...target.identity, kind: 'simulator' },
      disclosure: { ...target.disclosure, kind: 'simulator' },
    },
    {
      ...target,
      identity: { ...target.identity, providerInstanceId: 'local-adb' as 'local-core-device' },
    },
    {
      ...target,
      identity: {
        platform: 'android',
        providerInstanceId: 'local-adb',
        routingId: 'PRIVATE-ANDROID-ID',
        kind: 'device',
        transportScope: 'local-adb',
      },
    },
  ];

  for (const invalid of unsupported) {
    await assert.rejects(fake.provider.preparation.inspect(invalid), /IOS_G3_TARGET_UNSUPPORTED/);
    await assert.rejects(
      fake.provider.applications.inspect(invalid, ''),
      /IOS_G3_TARGET_UNSUPPORTED/,
    );
    await assert.rejects(fake.provider.endpoint.inspect(invalid), /IOS_G3_TARGET_UNSUPPORTED/);
  }
  assert.deepEqual(fake.calls, {
    discovery: 0,
    preparation: 0,
    applications: 0,
    endpoint: 0,
  });
});

test('probe rejection and Abort propagate unchanged with no retry or side effect fallback', async () => {
  const failure = new Error('read-only probe failed');
  const rejectCases = [
    {
      make: () => fixture({ discover: async () => Promise.reject(failure) }),
      run: (fake: ReturnType<typeof fixture>) => fake.provider.discover('ios'),
      count: 'discovery' as const,
    },
    {
      make: () => fixture({ inspectPreparation: async () => Promise.reject(failure) }),
      run: (fake: ReturnType<typeof fixture>) => fake.provider.preparation.inspect(target),
      count: 'preparation' as const,
    },
    {
      make: () => fixture({ inspectApplications: async () => Promise.reject(failure) }),
      run: (fake: ReturnType<typeof fixture>) => fake.provider.applications.inspect(target, ''),
      count: 'applications' as const,
    },
    {
      make: () => fixture({ inspectEndpoint: async () => Promise.reject(failure) }),
      run: (fake: ReturnType<typeof fixture>) => fake.provider.endpoint.inspect(target),
      count: 'endpoint' as const,
    },
  ];
  for (const item of rejectCases) {
    const fake = item.make();
    await assert.rejects(item.run(fake), (error) => error === failure);
    assert.equal(fake.calls[item.count], 1);
  }

  const controller = new AbortController();
  const abortReason = new Error('fixture abort');
  controller.abort(abortReason);
  const fake = fixture();
  await assert.rejects(
    fake.provider.discover('ios', controller.signal),
    (error) => error === abortReason,
  );
  await assert.rejects(
    fake.provider.preparation.inspect(target, controller.signal),
    (error) => error === abortReason,
  );
  await assert.rejects(
    fake.provider.applications.inspect(target, '', controller.signal),
    (error) => error === abortReason,
  );
  await assert.rejects(
    fake.provider.endpoint.inspect(target, controller.signal),
    (error) => error === abortReason,
  );
  assert.deepEqual(fake.calls, {
    discovery: 0,
    preparation: 0,
    applications: 0,
    endpoint: 0,
  });
});

test('all provider tests use injected mocks and perform no real device operation', () => {
  const fake = fixture();
  assert.equal('session' in fake.provider, false);
  assert.equal('job' in fake.provider, false);
  assert.equal('queue' in fake.provider, false);
  assert.equal('install' in fake.provider, false);
  assert.equal('execute' in fake.provider, false);
});
