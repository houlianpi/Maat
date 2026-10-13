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
import type {
  ConnectionJobKey,
  ConnectionJobView,
  MobileConnectionPort,
} from '../packages/core/src/mobile/connection/port.ts';
import type {
  DeviceInventoryPort,
  DeviceSelectionPort,
} from '../packages/core/src/mobile/devices/ports.ts';
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
  async inspect(selected: LifecycleTarget) {
    assert.equal(selected.key, targetKey);
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
    return {
      state: 'satisfied' as const,
      compatibility: 'compatible' as const,
      blockerCategories: [],
    };
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
  session: MobileSessionPort;
  readiness: MobileReadinessPort;
}>;

async function exerciseContracts(ports: FakeSet) {
  const inventory = await ports.inventory.discover('android');
  assert.equal(inventory.candidates.length, 1);
  const selection = await ports.selection.select('android', endpoint);
  assert.equal(selection.status, 'selected');
  if (selection.status !== 'selected') throw new Error('Fake selection contract failed.');
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
  return { inventory, selection: selection.target.disclosure, job, session, readiness };
}

test('fake internal mobile ports are structurally replaceable without production integration', async () => {
  const firstSelection = new FakeSelection();
  const firstSession = new FakeSession();
  const first: FakeSet = {
    inventory: new FakeInventory(),
    selection: firstSelection,
    connection: new FakeConnection(),
    preparation: new FakePreparation(),
    session: firstSession,
    readiness: new FakeReadiness(),
  };
  const replacement: FakeSet = {
    ...first,
    selection: new FakeSelection(),
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
    session: new FakeSession(),
    readiness: new FakeReadiness(),
  });
  const disclosure = JSON.stringify({
    selection: result.selection,
    job: result.job,
    readiness: result.readiness,
  });
  assert.equal(disclosure.includes(rawRoute), false);
  assert.equal(disclosure.includes(endpoint), false);
  assert.doesNotMatch(
    disclosure,
    /routingId|udid|endpointId|internalSessionHandle|\/Users\/|[A-Za-z]:\\/,
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
  session: new FakeSession(),
  readiness: new FakeReadiness(),
};
void compileTimeContracts;

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
