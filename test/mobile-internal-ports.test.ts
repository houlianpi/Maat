import assert from 'node:assert/strict';
import test from 'node:test';

import type { MobilePlatform } from '../packages/core/src/mobile/contracts/device.ts';
import type {
  DiscoveryKey,
  EndpointKey,
  LifecycleTarget,
  LifecycleTargetKey,
} from '../packages/core/src/mobile/contracts/lifecycle.ts';
import type {
  MobileResourceOwnership,
  ResourceKey,
} from '../packages/core/src/mobile/contracts/ownership.ts';
import {
  createApplicationFact,
  type ApplicationFact,
  type ApplicationInspectionPort,
} from '../packages/core/src/mobile/applications/port.ts';
import {
  dispatchCapabilityBackend,
  dispatchResolvedCapabilityBackend,
  resolveCapabilityBackend,
  type CapabilityBackendHandlers,
  type CapabilityRoute,
  type G3ReadOnlyBackendConfiguration,
  type G3ReadOnlyCapability,
  type ResolvedCapabilityBackend,
} from '../packages/core/src/mobile/contracts/backend-selection.ts';
import type {
  ConnectionJobKey,
  ConnectionJobView,
  MobileConnectionPort,
} from '../packages/core/src/mobile/connection/port.ts';
import type {
  DeviceInventoryPort,
  DeviceSelectionPort,
} from '../packages/core/src/mobile/devices/ports.ts';
import {
  createEndpointStatusView,
  type EndpointStatusPort,
  type EndpointStatusView,
} from '../packages/core/src/mobile/endpoint/port.ts';
import type {
  MobilePreparationPort,
  PreparationFactsKey,
  PreparationGrantKey,
  PreparationPlanKey,
} from '../packages/core/src/mobile/preparation/port.ts';
import type {
  MobileReadinessPort,
  ObservationKey,
  ReadinessReadyResult,
  ReadinessResult,
} from '../packages/core/src/mobile/readiness/port.ts';
import { createReadinessReadyResult } from '../packages/core/src/mobile/readiness/port.ts';
import type {
  MobileSessionPort,
  SessionKey,
  SessionView,
} from '../packages/core/src/mobile/session/port.ts';

const opaque = <T>(value: string) => value as T;
const targetKey = opaque<LifecycleTargetKey>('internal-target');
const endpoint = opaque<EndpointKey>('internal-endpoint');
const sessionKey = opaque<SessionKey>('internal-session-key-not-a-handle');
const jobKey = opaque<ConnectionJobKey>('safe-random-job');
const factsKey = opaque<PreparationFactsKey>('internal-facts');
const planKey = opaque<PreparationPlanKey>('internal-plan');
const grantKey = opaque<PreparationGrantKey>('internal-grant');
const observationKey = opaque<ObservationKey>('safe-observation');
const rawRoute = 'PRIVATE_RAW_ROUTING_ID';

const ownership: MobileResourceOwnership = {
  appiumService: { state: 'externally-managed', manager: 'user' },
  appiumSession: {
    state: 'maat-owned',
    resource: opaque<ResourceKey>('private-resource-correlation'),
    proof: 'owner-token',
  },
  automationBackend: { state: 'externally-managed', manager: 'appium' },
};

const target: LifecycleTarget = {
  key: targetKey,
  endpoint,
  identity: {
    platform: 'android',
    providerInstanceId: 'local-adb',
    routingId: rawRoute,
    kind: 'device',
    transportScope: 'local-adb',
    displayName: 'Fixture Phone',
  },
  selectedBy: 'single-candidate',
  disclosure: {
    platform: 'android',
    kind: 'device',
    label: 'Fixture Phone',
    selectedBy: 'single-candidate',
  },
};

const iosTarget: LifecycleTarget = {
  ...target,
  identity: {
    platform: 'ios',
    providerInstanceId: 'local-core-device',
    routingId: 'PRIVATE_IOS_ID',
    kind: 'device',
    transportScope: 'core-device',
  },
  disclosure: { ...target.disclosure, platform: 'ios' },
};

class FakeInventory implements DeviceInventoryPort {
  async discover(platform: MobilePlatform) {
    return {
      discoveryKey: opaque<DiscoveryKey>('discovery'),
      platform,
      candidates: [
        {
          identity: target.identity,
          disclosure: {
            candidateNumber: 1,
            displayName: target.disclosure.label,
            platform,
            kind: 'device' as const,
            discriminator: 'Device 1',
          },
        },
      ],
    };
  }
}

class FakeSelection implements DeviceSelectionPort {
  releases = 0;

  async select(platform: MobilePlatform, selectedEndpoint: EndpointKey) {
    assert.equal(platform, 'android');
    assert.equal(selectedEndpoint, endpoint);
    return { status: 'selected' as const, target };
  }

  async release(selected: LifecycleTargetKey) {
    assert.equal(selected, targetKey);
    this.releases += 1;
  }
}

class FakeConnection implements MobileConnectionPort {
  readonly view: ConnectionJobView = {
    job: jobKey,
    operation: 'prepare',
    state: 'succeeded',
    createdAt: '2026-01-01T00:00:00.000Z',
    deadlineAt: '2026-01-01T00:00:10.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
  };

  async start(selected: LifecycleTarget) {
    assert.equal(selected.key, targetKey);
    return this.view;
  }

  async query(job: ConnectionJobKey) {
    assert.equal(job, jobKey);
    return this.view;
  }

  async cancel(job: ConnectionJobKey) {
    assert.equal(job, jobKey);
    return { ...this.view, state: 'cancelled' as const };
  }
}

class FakePreparation implements MobilePreparationPort {
  inspections = 0;
  plans = 0;
  executions = 0;

  async inspect(selected: LifecycleTarget) {
    assert.equal(selected.key, targetKey);
    this.inspections += 1;
    return {
      key: factsKey,
      platform: 'android' as const,
      capturedAt: '2026-01-01T00:00:00.000Z',
      policyVersion: 'fixture-v1',
      compatibility: 'compatible' as const,
      blockerCategories: [],
    };
  }

  async plan(selected: LifecycleTarget, facts: PreparationFactsKey) {
    assert.equal(selected.key, targetKey);
    assert.equal(facts, factsKey);
    this.plans += 1;
    return {
      key: planKey,
      state: 'satisfied' as const,
      operations: [],
      compatibility: 'compatible' as const,
      blockerCategories: [],
    };
  }

  async execute(
    selected: LifecycleTarget,
    plan: PreparationPlanKey,
    grant: PreparationGrantKey | undefined,
  ) {
    assert.equal(selected.key, targetKey);
    assert.equal(plan, planKey);
    assert.equal(grant, grantKey);
    this.executions += 1;
    return {
      state: 'satisfied' as const,
      compatibility: 'compatible' as const,
      blockerCategories: [],
    };
  }
}

class FakeApplicationInspection implements ApplicationInspectionPort {
  readonly application: ApplicationFact;

  constructor(application: unknown) {
    this.application = createApplicationFact(target, application);
  }

  async inspect(selected: LifecycleTarget, query: string, signal?: AbortSignal) {
    assert.equal(selected.key, targetKey);
    assert.equal(query, 'fixture');
    assert.equal(signal?.aborted, false);
    return [this.application];
  }
}

class FakeEndpointStatus implements EndpointStatusPort {
  readonly view: EndpointStatusView;

  constructor(view: unknown) {
    this.view = createEndpointStatusView(view);
  }

  async inspect(selected: LifecycleTarget, signal?: AbortSignal) {
    assert.equal(selected.key, targetKey);
    assert.equal(signal?.aborted, false);
    return this.view;
  }
}

class FakeSession implements MobileSessionPort {
  closes = 0;
  readonly view: SessionView = {
    key: sessionKey,
    target: targetKey,
    platform: 'android',
    generation: 1,
    backend: 'appium',
    state: 'ready',
    ownership,
  };

  async acquire(selected: LifecycleTarget) {
    assert.equal(selected.key, targetKey);
    return this.view;
  }

  async inspect(session: SessionKey) {
    assert.equal(session, sessionKey);
    return this.view;
  }

  async close(session: SessionKey) {
    assert.equal(session, sessionKey);
    this.closes += 1;
  }
}

class FakeReadiness implements MobileReadinessPort {
  probe(
    selected: LifecycleTarget,
    session: SessionKey,
    options: Readonly<{ includeScreenshot: true }>,
    signal?: AbortSignal,
  ): Promise<ReadinessResult<true>>;
  probe(
    selected: LifecycleTarget,
    session: SessionKey,
    options: Readonly<{ includeScreenshot: false }>,
    signal?: AbortSignal,
  ): Promise<ReadinessResult<false>>;
  async probe(
    selected: LifecycleTarget,
    session: SessionKey,
    options: Readonly<{ includeScreenshot: boolean }>,
    _signal?: AbortSignal,
  ): Promise<ReadinessResult> {
    assert.equal(selected.key, targetKey);
    assert.equal(session, sessionKey);
    const source = {
      key: observationKey,
      kind: 'source' as const,
      capturedAt: '2026-01-01T00:00:01.000Z',
      generation: 1,
    };
    const viewport = {
      key: observationKey,
      kind: 'viewport' as const,
      capturedAt: '2026-01-01T00:00:01.000Z',
      generation: 1,
    };
    if (options.includeScreenshot) {
      return createReadinessReadyResult(
        { includeScreenshot: true },
        {
          generation: 1,
          phoneUnlocked: true,
          source,
          viewport,
          screenshot: {
            key: observationKey,
            kind: 'screenshot',
            capturedAt: '2026-01-01T00:00:01.000Z',
            generation: 1,
          },
        },
      );
    }
    return createReadinessReadyResult(
      { includeScreenshot: false },
      {
        generation: 1,
        phoneUnlocked: true,
        source,
        viewport,
      },
    );
  }
}

type FakeSet = Readonly<{
  inventory: DeviceInventoryPort;
  selection: DeviceSelectionPort;
  connection: MobileConnectionPort;
  preparation: MobilePreparationPort;
  applications: ApplicationInspectionPort;
  endpointStatus: EndpointStatusPort;
  session: MobileSessionPort;
  readiness: MobileReadinessPort;
}>;

async function exerciseContracts(ports: FakeSet) {
  const inventory = await ports.inventory.discover('android');
  assert.equal(inventory.candidates.length, 1);
  const selection = await ports.selection.select('android', endpoint);
  assert.equal(selection.status, 'selected');
  if (selection.status !== 'selected') throw new Error('Fake selection contract failed.');
  const probeSignal = new AbortController().signal;
  const applications = await ports.applications.inspect(selection.target, 'fixture', probeSignal);
  const endpointStatus = await ports.endpointStatus.inspect(selection.target, probeSignal);
  const facts = await ports.preparation.inspect(selection.target);
  const plan = await ports.preparation.plan(selection.target, facts.key);
  const result = await ports.preparation.execute(selection.target, plan.key, grantKey);
  assert.equal(result.state, 'satisfied');
  const job = await ports.connection.start(selection.target, 'prepare', 10_000);
  assert.equal((await ports.connection.query(job.job)).state, 'succeeded');
  const session = await ports.session.acquire(selection.target);
  const readiness = await ports.readiness.probe(selection.target, session.key, {
    includeScreenshot: false,
  });
  await ports.session.close(session.key);
  await ports.selection.release(selection.target.key);
  return {
    inventory,
    selection: selection.target.disclosure,
    applications,
    endpointStatus,
    job,
    session,
    readiness,
  };
}

test('fake internal mobile ports are structurally replaceable without production integration', async () => {
  const firstSelection = new FakeSelection();
  const firstSession = new FakeSession();
  const first: FakeSet = {
    inventory: new FakeInventory(),
    selection: firstSelection,
    connection: new FakeConnection(),
    preparation: new FakePreparation(),
    applications: new FakeApplicationInspection({
      name: 'Fixture',
      id: 'org.example.fixture',
      capabilities: { 'appium:appPackage': 'org.example.fixture' },
    }),
    endpointStatus: new FakeEndpointStatus({
      state: 'reachable',
      compatibility: 'compatible',
    }),
    session: firstSession,
    readiness: new FakeReadiness(),
  };
  const replacement: FakeSet = {
    ...first,
    selection: new FakeSelection(),
    applications: new FakeApplicationInspection({
      name: 'Fixture',
      id: 'org.example.fixture',
      capabilities: { 'appium:appPackage': 'org.example.fixture' },
    }),
    endpointStatus: new FakeEndpointStatus({
      state: 'reachable',
      compatibility: 'compatible',
    }),
    session: new FakeSession(),
  };

  assert.deepEqual(await exerciseContracts(first), await exerciseContracts(replacement));
  assert.equal(firstSelection.releases, 1);
  assert.equal(firstSession.closes, 1);
});

test('fake disclosure and observation contracts omit routing, endpoint, handles, and paths', async () => {
  const result = await exerciseContracts({
    inventory: new FakeInventory(),
    selection: new FakeSelection(),
    connection: new FakeConnection(),
    preparation: new FakePreparation(),
    applications: new FakeApplicationInspection({
      name: 'Fixture',
      id: 'org.example.fixture',
      capabilities: { 'appium:appPackage': 'org.example.fixture' },
    }),
    endpointStatus: new FakeEndpointStatus({
      state: 'unknown',
      errorCategory: 'probe-timeout',
    }),
    session: new FakeSession(),
    readiness: new FakeReadiness(),
  });
  const disclosure = JSON.stringify({
    selection: result.selection,
    applications: result.applications,
    endpointStatus: result.endpointStatus,
    job: result.job,
    readiness: result.readiness,
  });
  assert.equal(disclosure.includes(rawRoute), false);
  assert.equal(disclosure.includes(endpoint), false);
  assert.doesNotMatch(
    disclosure,
    /routingId|udid|endpoint(Id|Url|Key)|session(Id|Handle)|\/Users\/|[A-Za-z]:\\/i,
  );
});

test('application fact builder validates platform capabilities and rejects sensitive extra fields', () => {
  const android = createApplicationFact(target, {
    name: 'Fixture',
    id: 'org.example.fixture',
    capabilities: { 'appium:appPackage': 'org.example.fixture' },
  });
  const ios = createApplicationFact(iosTarget, {
    name: 'Fixture',
    id: 'org.example.fixture',
    capabilities: { 'appium:bundleId': 'org.example.fixture' },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(android)), {
    name: 'Fixture',
    id: 'org.example.fixture',
    capabilities: { 'appium:appPackage': 'org.example.fixture' },
  });
  assert.equal(Object.isFrozen(android), true);
  assert.equal(Object.isFrozen(android.capabilities), true);
  assert.equal(Object.isFrozen(ios), true);
  assert.equal(Object.isFrozen(ios.capabilities), true);

  for (const sensitiveKey of ['serial', 'udid', 'endpoint', 'sessionId', 'path']) {
    assert.throws(
      () =>
        createApplicationFact(target, {
          name: 'Fixture',
          id: 'org.example.fixture',
          capabilities: { 'appium:appPackage': 'org.example.fixture' },
          [sensitiveKey]: `PRIVATE_${sensitiveKey}`,
        }),
      /Invalid android application fact/,
    );
  }
  for (const sensitiveCapability of [
    'appium:udid',
    'appium:serverUrl',
    'appium:sessionId',
    'appium:app',
    'appium:appActivity',
  ]) {
    assert.throws(
      () =>
        createApplicationFact(target, {
          name: 'Fixture',
          id: 'org.example.fixture',
          capabilities: {
            'appium:appPackage': 'org.example.fixture',
            [sensitiveCapability]: '/Users/private/application',
          },
        }),
      /Invalid android application fact/,
    );
  }

  assert.throws(
    () =>
      createApplicationFact(target, {
        name: 'Fixture',
        id: 'org.example.fixture',
        capabilities: { 'appium:bundleId': 'org.example.fixture' },
      }),
    /Invalid android application fact/,
  );
  assert.throws(
    () =>
      createApplicationFact(iosTarget, {
        name: 'Fixture',
        id: 'org.example.fixture',
        capabilities: { 'appium:appPackage': 'org.example.fixture' },
      }),
    /Invalid ios application fact/,
  );
});

test('endpoint status factory prevents contradictory facts and omits raw endpoints', () => {
  const statuses = [
    createEndpointStatusView({ state: 'not-configured' }),
    createEndpointStatusView({ state: 'configured' }),
    createEndpointStatusView({ state: 'reachable', compatibility: 'compatible' }),
    createEndpointStatusView({ state: 'unreachable', errorCategory: 'connection-refused' }),
    createEndpointStatusView({ state: 'unknown' }),
    createEndpointStatusView({ state: 'error', errorCategory: 'probe-failed' }),
  ];
  for (const status of statuses) {
    assert.equal(Object.isFrozen(status), true);
    assert.equal(JSON.stringify(status).includes(endpoint), false);
    assert.equal(JSON.stringify(status).includes('endpointId'), false);
  }

  for (const invalid of [
    { state: 'not-configured', compatibility: 'compatible' },
    { state: 'configured', reachability: 'reachable' },
    { state: 'reachable', compatibility: 'compatible', errorCategory: 'contradiction' },
    { state: 'unreachable', compatibility: 'compatible' },
    { state: 'unknown', errorCategory: '' },
    { state: 'error' },
    { state: 'error', errorCategory: 'probe-failed', endpoint: 'PRIVATE_ENDPOINT' },
  ]) {
    assert.throws(() => createEndpointStatusView(invalid), /Invalid endpoint status/);
  }
});

test('G3 application and endpoint probes accept lifecycle targets and pass AbortSignal', async () => {
  const controller = new AbortController();
  const applications: ApplicationInspectionPort = new FakeApplicationInspection({
    name: 'Fixture',
    id: 'org.example.fixture',
    capabilities: { 'appium:appPackage': 'org.example.fixture' },
  });
  const endpointStatus: EndpointStatusPort = new FakeEndpointStatus({
    state: 'reachable',
    compatibility: 'compatible',
  });

  assert.equal((await applications.inspect(target, 'fixture', controller.signal)).length, 1);
  assert.equal((await endpointStatus.inspect(target, controller.signal)).state, 'reachable');
});

test('capability gate selects one immutable backend across the required route matrix', () => {
  const capabilities: readonly G3ReadOnlyCapability[] = [
    'discovery',
    'preparation-facts',
    'application-inspection',
    'endpoint-status',
  ];
  const configuration: G3ReadOnlyBackendConfiguration = {
    android: Object.fromEntries(capabilities.map((capability) => [capability, true])),
    ios: {
      discovery: true,
      'preparation-facts': false,
      'application-inspection': true,
      'endpoint-status': false,
    },
  };
  const androidEmulator: LifecycleTarget = {
    ...target,
    identity: { ...target.identity, kind: 'emulator' },
    disclosure: { ...target.disclosure, kind: 'emulator' },
  };
  const iosSimulator: LifecycleTarget = {
    ...iosTarget,
    identity: { ...iosTarget.identity, kind: 'simulator' },
    disclosure: { ...iosTarget.disclosure, kind: 'simulator' },
  };
  const routes: readonly Readonly<{
    route: CapabilityRoute;
    expected: ResolvedCapabilityBackend['backend'];
  }>[] = [
    { route: { kind: 'lifecycle-target', target }, expected: 'g3' },
    { route: { kind: 'lifecycle-target', target: androidEmulator }, expected: 'legacy' },
    { route: { kind: 'lifecycle-target', target: iosSimulator }, expected: 'legacy' },
    { route: { kind: 'remote', platform: 'android' }, expected: 'legacy' },
    { route: { kind: 'host', platform: 'web' }, expected: 'not-applicable' },
    { route: { kind: 'host', platform: 'macos' }, expected: 'not-applicable' },
  ];

  for (const capability of capabilities) {
    for (const entry of routes) {
      const resolved = resolveCapabilityBackend(entry.route, capability, configuration);
      assert.equal(resolved.backend, entry.expected);
      assert.equal(Object.isFrozen(resolved), true);
      assert.equal(resolved.routeKind, entry.route.kind);
      assert.equal(
        resolved.platform,
        entry.route.kind === 'lifecycle-target'
          ? entry.route.target.identity.platform
          : entry.route.platform,
      );
      if (resolved.routeKind === 'lifecycle-target') {
        assert.equal(
          resolved.target,
          entry.route.kind === 'lifecycle-target' && entry.route.target.key,
        );
      } else {
        assert.equal('target' in resolved, false);
      }
    }
  }
  assert.equal(
    resolveCapabilityBackend(
      { kind: 'lifecycle-target', target: iosTarget },
      'application-inspection',
      configuration,
    ).backend,
    'g3',
  );
  assert.equal(
    resolveCapabilityBackend(
      { kind: 'lifecycle-target', target: iosTarget },
      'endpoint-status',
      configuration,
    ).backend,
    'legacy',
  );
});

test('resolved backend has no post-start fallback behavior or alternate backend', () => {
  const resolution = resolveCapabilityBackend(
    { kind: 'lifecycle-target', target },
    'endpoint-status',
    {
      android: { 'endpoint-status': true },
      ios: {},
    },
  );

  assert.deepEqual(resolution, {
    capability: 'endpoint-status',
    backend: 'g3',
    routeKind: 'lifecycle-target',
    platform: 'android',
    target: targetKey,
  });
  assert.equal('fallback' in resolution, false);
  assert.equal('retry' in resolution, false);
  assert.equal('callback' in resolution, false);
  assert.equal('alternates' in resolution, false);
});

test('backend resolution is target-correlated before dispatch', async () => {
  const targetB: LifecycleTarget = {
    ...target,
    key: opaque<LifecycleTargetKey>('other-target'),
  };
  const resolution = resolveCapabilityBackend(
    { kind: 'lifecycle-target', target },
    'endpoint-status',
    { android: { 'endpoint-status': true }, ios: {} },
  );
  let invocations = 0;
  const handlers: CapabilityBackendHandlers<string> = {
    async g3() {
      invocations += 1;
      return 'g3';
    },
    async legacy() {
      invocations += 1;
      return 'legacy';
    },
    async notApplicable() {
      invocations += 1;
      return 'not-applicable';
    },
  };

  await assert.rejects(
    dispatchResolvedCapabilityBackend(
      { kind: 'lifecycle-target', target: targetB },
      resolution,
      handlers,
    ),
    /does not match the operation target/,
  );
  assert.equal(invocations, 0);
});

test('backend dispatch invokes only the selected route once across the gate matrix', async () => {
  const androidEmulator: LifecycleTarget = {
    ...target,
    identity: { ...target.identity, kind: 'emulator' },
    disclosure: { ...target.disclosure, kind: 'emulator' },
  };
  const iosSimulator: LifecycleTarget = {
    ...iosTarget,
    identity: { ...iosTarget.identity, kind: 'simulator' },
    disclosure: { ...iosTarget.disclosure, kind: 'simulator' },
  };
  const routes: readonly Readonly<{
    route: CapabilityRoute;
    expected: keyof CapabilityBackendHandlers<string>;
  }>[] = [
    { route: { kind: 'lifecycle-target', target }, expected: 'g3' },
    { route: { kind: 'lifecycle-target', target: androidEmulator }, expected: 'legacy' },
    { route: { kind: 'lifecycle-target', target: iosSimulator }, expected: 'legacy' },
    { route: { kind: 'remote', platform: 'ios' }, expected: 'legacy' },
    { route: { kind: 'host', platform: 'web' }, expected: 'notApplicable' },
    { route: { kind: 'host', platform: 'macos' }, expected: 'notApplicable' },
  ];

  for (const entry of routes) {
    const calls = { g3: 0, legacy: 0, notApplicable: 0 };
    const handlers: CapabilityBackendHandlers<string> = {
      async g3() {
        calls.g3 += 1;
        return 'g3';
      },
      async legacy() {
        calls.legacy += 1;
        return 'legacy';
      },
      async notApplicable() {
        calls.notApplicable += 1;
        return 'notApplicable';
      },
    };
    const result = await dispatchCapabilityBackend(
      entry.route,
      'endpoint-status',
      {
        android: { 'endpoint-status': true },
        ios: { 'endpoint-status': true },
      },
      handlers,
    );

    assert.equal(result, entry.expected);
    assert.deepEqual(calls, {
      g3: entry.expected === 'g3' ? 1 : 0,
      legacy: entry.expected === 'legacy' ? 1 : 0,
      notApplicable: entry.expected === 'notApplicable' ? 1 : 0,
    });
  }
});

test('backend rejection and pre-aborted signals propagate without fallback or retry', async () => {
  const failure = new Error('g3 probe failed');
  let resolverCalls = 0;
  let g3Calls = 0;
  let legacyCalls = 0;
  const countingResolver: typeof resolveCapabilityBackend = (...parameters) => {
    resolverCalls += 1;
    return resolveCapabilityBackend(...parameters);
  };
  const rejectingHandlers: CapabilityBackendHandlers<never> = {
    async g3() {
      g3Calls += 1;
      throw failure;
    },
    async legacy() {
      legacyCalls += 1;
      throw new Error('legacy must not run');
    },
    async notApplicable() {
      throw new Error('not-applicable must not run');
    },
  };
  const dispatch = (handlers: CapabilityBackendHandlers<never>, signal?: AbortSignal) =>
    dispatchCapabilityBackend(
      { kind: 'lifecycle-target', target },
      'endpoint-status',
      { android: { 'endpoint-status': true }, ios: {} },
      handlers,
      signal,
      countingResolver,
    );

  await assert.rejects(dispatch(rejectingHandlers), (error) => error === failure);
  assert.deepEqual(
    { resolverCalls, g3Calls, legacyCalls },
    { resolverCalls: 1, g3Calls: 1, legacyCalls: 0 },
  );

  const controller = new AbortController();
  const abortReason = new Error('fixture abort');
  controller.abort(abortReason);
  resolverCalls = 0;
  g3Calls = 0;
  legacyCalls = 0;
  const abortingHandlers: CapabilityBackendHandlers<never> = {
    async g3(signal) {
      g3Calls += 1;
      assert.equal(signal, controller.signal);
      throw signal?.reason;
    },
    async legacy() {
      legacyCalls += 1;
      throw new Error('legacy must not run');
    },
    async notApplicable() {
      throw new Error('not-applicable must not run');
    },
  };

  await assert.rejects(
    dispatch(abortingHandlers, controller.signal),
    (error) => error === abortReason,
  );
  assert.deepEqual(
    { resolverCalls, g3Calls, legacyCalls },
    { resolverCalls: 1, g3Calls: 1, legacyCalls: 0 },
  );
});

test('preparation inspection is separable from G3P planning and execution', async () => {
  const preparation = new FakePreparation();
  const facts = await preparation.inspect(target);

  assert.equal(facts.key, factsKey);
  assert.deepEqual(
    {
      inspections: preparation.inspections,
      plans: preparation.plans,
      executions: preparation.executions,
    },
    { inspections: 1, plans: 0, executions: 0 },
  );
});

test('ready results validate one generation through the actual port contract', async () => {
  const port: MobileReadinessPort = new FakeReadiness();
  const ready = await port.probe(target, sessionKey, { includeScreenshot: true });
  assert.equal(ready.state, 'ready');
  if (ready.state !== 'ready') throw new Error('Fake readiness contract failed.');
  assert.equal(ready.generation, 1);
  assert.equal(ready.proof.source.generation, ready.generation);
  assert.equal(ready.proof.viewport.generation, ready.generation);
  assert.equal(ready.proof.screenshot.generation, ready.generation);
});

test('ready result factory rejects mixed observation generations', () => {
  assert.throws(
    () =>
      createReadinessReadyResult(
        { includeScreenshot: true },
        {
          generation: 1,
          phoneUnlocked: true,
          source: {
            key: observationKey,
            kind: 'source',
            capturedAt: '2026-01-01T00:00:01.000Z',
            generation: 2,
          },
          viewport: {
            key: observationKey,
            kind: 'viewport',
            capturedAt: '2026-01-01T00:00:01.000Z',
            generation: 3,
          },
          screenshot: {
            key: observationKey,
            kind: 'screenshot',
            capturedAt: '2026-01-01T00:00:01.000Z',
            generation: 4,
          },
        },
      ),
    /must match the readiness generation/,
  );
  assert.throws(
    () =>
      createReadinessReadyResult(
        { includeScreenshot: true },
        {
          generation: 1,
          phoneUnlocked: true,
          source: {
            key: observationKey,
            kind: 'source',
            capturedAt: '2026-01-01T00:00:01.000Z',
            generation: 1,
          },
          viewport: {
            key: observationKey,
            kind: 'viewport',
            capturedAt: '2026-01-01T00:00:01.000Z',
            generation: 1,
          },
          screenshot: {
            key: observationKey,
            kind: 'screenshot',
            capturedAt: '2026-01-01T00:00:01.000Z',
            generation: 2,
          },
        },
      ),
    /must match the readiness generation/,
  );
});

test('ready result factory requires a requested screenshot', () => {
  const missingScreenshot = {
    generation: 1,
    phoneUnlocked: true,
    source: {
      key: observationKey,
      kind: 'source',
      capturedAt: '2026-01-01T00:00:01.000Z',
      generation: 1,
    },
    viewport: {
      key: observationKey,
      kind: 'viewport',
      capturedAt: '2026-01-01T00:00:01.000Z',
      generation: 1,
    },
  };
  assert.throws(
    () => createReadinessReadyResult({ includeScreenshot: true }, missingScreenshot as never),
    /required when requested/,
  );
});

// Assignments are compile-time assertions; runtime assertions above verify fake interchangeability.
const compileTimeContracts: FakeSet = {
  inventory: new FakeInventory(),
  selection: new FakeSelection(),
  connection: new FakeConnection(),
  preparation: new FakePreparation(),
  applications: new FakeApplicationInspection({
    name: 'Fixture',
    id: 'org.example.fixture',
    capabilities: { 'appium:appPackage': 'org.example.fixture' },
  }),
  endpointStatus: new FakeEndpointStatus({
    state: 'reachable',
    compatibility: 'compatible',
  }),
  session: new FakeSession(),
  readiness: new FakeReadiness(),
};
void compileTimeContracts;

function assertSensitiveRoutingInputsDoNotCompile(
  applications: ApplicationInspectionPort,
  endpointStatus: EndpointStatusPort,
) {
  // @ts-expect-error Application inspection requires a lifecycle target, not a raw serial/UDID.
  void applications.inspect('PRIVATE_RAW_ROUTING_ID', 'fixture');
  // @ts-expect-error Endpoint status requires a lifecycle target, not a raw endpoint.
  void endpointStatus.inspect('http://private-endpoint.invalid');
}
void assertSensitiveRoutingInputsDoNotCompile;

function assertInvalidReadyInputsDoNotCompile() {
  // @ts-expect-error A ready proof cannot omit its viewport observation.
  createReadinessReadyResult(
    { includeScreenshot: false },
    {
      generation: 1,
      phoneUnlocked: true,
      source: {
        key: observationKey,
        kind: 'source',
        capturedAt: '2026-01-01T00:00:01.000Z',
        generation: 1,
      },
    },
  );

  // @ts-expect-error includeScreenshot: true requires a screenshot observation.
  createReadinessReadyResult(
    { includeScreenshot: true },
    {
      generation: 1,
      phoneUnlocked: true,
      source: {
        key: observationKey,
        kind: 'source',
        capturedAt: '2026-01-01T00:00:01.000Z',
        generation: 1,
      },
      viewport: {
        key: observationKey,
        kind: 'viewport',
        capturedAt: '2026-01-01T00:00:01.000Z',
        generation: 1,
      },
    },
  );
}
void assertInvalidReadyInputsDoNotCompile;

const unvalidatedReady: ReadinessReadyResult<false> = {
  state: 'ready',
  generation: 1,
  // @ts-expect-error Ready proofs can only be created by the validating factory.
  proof: {
    phoneUnlocked: true,
    source: {
      key: observationKey,
      kind: 'source',
      capturedAt: '2026-01-01T00:00:01.000Z',
      generation: 1,
    },
    viewport: {
      key: observationKey,
      kind: 'viewport',
      capturedAt: '2026-01-01T00:00:01.000Z',
      generation: 1,
    },
  },
};
void unvalidatedReady;
