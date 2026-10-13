import assert from 'node:assert/strict';
import test from 'node:test';
import { connect, createServer } from 'node:net';

import { AppiumPlatformAdapter } from '../packages/core/src/platforms/appium/appium-adapter.ts';
import type { Device } from '../packages/core/src/setup/devices.ts';
import type { TargetSelectionResult } from '../packages/core/src/mobile/contracts/device.ts';
import { MaatApi } from '../packages/core/src/api/maat-api.ts';
import { PlatformRegistry } from '../packages/core/src/core/platforms/registry.ts';
import { aggregateSetup } from '../packages/core/src/setup-assistant/model.ts';

class SelectionAdapter extends AppiumPlatformAdapter {
  devices: Device[] = [];
  discoveries = 0;

  constructor() {
    super({
      id: 'android',
      label: 'Android',
      platformName: 'Android',
      automationName: 'UiAutomator2',
    });
  }

  protected override async discoverSelectionDevices(): Promise<Device[]> {
    this.discoveries += 1;
    return this.devices;
  }

  override selectReadinessTarget(
    selection?: Parameters<AppiumPlatformAdapter['selectReadinessTarget']>[0],
    signal?: AbortSignal,
  ): Promise<TargetSelectionResult> {
    return super.selectReadinessTarget(selection, signal) as Promise<TargetSelectionResult>;
  }
}

const phones: Device[] = [
  { id: 'PRIVATE_SERIAL_A', name: 'Alpha Phone', kind: 'device' },
  { id: 'PRIVATE_SERIAL_B', name: 'Beta Phone', kind: 'device' },
];

test('zero, one and multiple candidates produce safe lifecycle selection outcomes', async () => {
  const adapter = new SelectionAdapter();

  assert.deepEqual(await adapter.selectReadinessTarget(), {
    status: 'device-not-found',
    platform: 'android',
  });

  adapter.devices = [phones[0]!];
  const single = await adapter.selectReadinessTarget();
  assert.equal(single.status, 'target-selected');
  if (single.status === 'target-selected') {
    assert.equal(single.selectedBy, 'single-candidate');
    assert.equal(single.candidate.displayName, 'Alpha Phone');
  }
  assert.equal((await adapter.selectReadinessTarget()).status, 'selected');

  await adapter.close();
  adapter.devices = phones;
  const multiple = await adapter.selectReadinessTarget();
  assert.equal(multiple.status, 'selection-required');
  if (multiple.status === 'selection-required') {
    assert.equal(multiple.candidates.length, 2);
    assert.deepEqual(
      multiple.candidates.map(({ candidateNumber, displayName, platform, kind }) => ({
        candidateNumber,
        displayName,
        platform,
        kind,
      })),
      [
        { candidateNumber: 1, displayName: 'Alpha Phone', platform: 'android', kind: 'device' },
        { candidateNumber: 2, displayName: 'Beta Phone', platform: 'android', kind: 'device' },
      ],
    );
    assert.doesNotMatch(JSON.stringify(multiple), /PRIVATE_SERIAL/);
  }
});

test('explicit selection revalidates the exact current snapshot and never falls back', async () => {
  const adapter = new SelectionAdapter();
  adapter.devices = phones;
  const proposal = await adapter.selectReadinessTarget();
  assert.equal(proposal.status, 'selection-required');
  if (proposal.status !== 'selection-required') return;

  const selected = await adapter.selectReadinessTarget({
    discoveryId: proposal.discoveryId,
    candidateNumber: 2,
  });
  assert.equal(selected.status, 'target-selected');
  if (selected.status === 'target-selected')
    assert.equal(selected.candidate.displayName, 'Beta Phone');

  await adapter.close();
  adapter.devices = phones;
  const replacement = await adapter.selectReadinessTarget();
  assert.equal(replacement.status, 'selection-required');
  if (replacement.status !== 'selection-required') return;
  const invalid = await adapter.selectReadinessTarget({
    discoveryId: replacement.discoveryId,
    candidateNumber: 99,
  });
  assert.equal(invalid.status, 'selection-invalid');

  const foreign = await adapter.selectReadinessTarget({
    discoveryId: proposal.discoveryId,
    candidateNumber: 1,
  });
  assert.equal(foreign.status, 'selection-stale');

  adapter.devices = [phones[0]!];
  const stale = await adapter.selectReadinessTarget({
    discoveryId: replacement.discoveryId,
    candidateNumber: 2,
  });
  assert.equal(stale.status, 'selection-stale');
  assert.doesNotMatch(JSON.stringify(stale), /PRIVATE_SERIAL/);
});

test('display-name changes preserve exact identity while legacy hints never select a candidate', async () => {
  const adapter = new SelectionAdapter();
  await adapter.configureSession({
    device: { kind: 'device', name: 'Alpha Phone' },
  });
  adapter.devices = phones;
  const proposal = await adapter.selectReadinessTarget();
  assert.equal(proposal.status, 'selection-required');
  if (proposal.status !== 'selection-required') return;

  adapter.devices = [{ ...phones[0]!, name: 'Renamed Alpha' }, phones[1]!];
  const selected = await adapter.selectReadinessTarget({
    discoveryId: proposal.discoveryId,
    candidateNumber: 1,
  });
  assert.equal(selected.status, 'target-selected');
  if (selected.status === 'target-selected')
    assert.equal(selected.candidate.displayName, 'Renamed Alpha');
});

test('successful close clears target and candidate handles while a new adapter is unselected', async () => {
  const adapter = new SelectionAdapter();
  adapter.devices = phones;
  const proposal = await adapter.selectReadinessTarget();
  assert.equal(proposal.status, 'selection-required');
  if (proposal.status !== 'selection-required') return;
  assert.equal(
    (
      await adapter.selectReadinessTarget({
        discoveryId: proposal.discoveryId,
        candidateNumber: 1,
      })
    ).status,
    'target-selected',
  );

  await adapter.close();
  const stale = await adapter.selectReadinessTarget({
    discoveryId: proposal.discoveryId,
    candidateNumber: 1,
  });
  assert.equal(stale.status, 'selection-stale');

  const next = new SelectionAdapter();
  next.devices = phones;
  assert.equal((await next.selectReadinessTarget()).status, 'selection-required');
});

test('MaatApi discloses a newly selected target before doctor and readiness side effects', async () => {
  class FacadeAdapter extends SelectionAdapter {
    readinessCalls = 0;
    events: string[] = [];
    override async executeReadiness() {
      this.events.push('readiness');
      this.readinessCalls += 1;
      return [
        {
          type: 'text' as const,
          text: JSON.stringify({
            maatSetupReadiness: 1,
            phoneUnlocked: true,
            sessionUsable: true,
            sourceReadable: true,
            viewportReadable: true,
            source: '<hierarchy />',
            viewport: { width: 1, height: 1 },
          }),
        },
      ];
    }
  }
  let activeEvents: string[] = [];
  const readyDetector = async () => {
    activeEvents.push('doctor');
    return aggregateSetup({
      platform: 'android',
      capabilities: [
        {
          id: 'uiInteraction',
          status: 'ready',
          required: true,
          messageKey: 'capability.interaction.ready',
        },
      ],
    });
  };

  for (const [devices, expected] of [
    [[], 'device-not-found'],
    [phones, 'selection-required'],
    [[phones[0]!], 'target-selected'],
  ] as const) {
    const adapter = new FacadeAdapter();
    activeEvents = adapter.events;
    adapter.devices = [...devices];
    const api = new MaatApi(new PlatformRegistry([adapter], 'android'), process.cwd(), {
      androidDetector: readyDetector,
    });
    const result = await api.setup.ready();
    if ('jobId' in result) assert.fail('Selection discovery must not create a connection job.');
    assert.equal(result.ready, false);
    if (result.ready) assert.fail('Expected target selection result, not readiness success.');
    assert.equal(result.status, expected);
    assert.deepEqual(adapter.events, []);
    if (result.status === 'target-selected') {
      assert.equal(result.selectedBy, 'single-candidate');
      assert.equal(result.candidate.displayName, 'Alpha Phone');
      const continued = await api.setup.ready();
      assert.equal(continued.ready, true);
      assert.deepEqual(adapter.events, ['doctor', 'readiness']);
    }
    await api.close();
  }
});

test('production Android selection producer only probes an existing ADB socket', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const events: string[] = [];

  class ProductionProducerAdapter extends AppiumPlatformAdapter {
    protected override discoverAndroidSelectionDevices(signal?: AbortSignal) {
      events.push('adb-socket');
      return super.discoverAndroidSelectionDevices(signal, () => connect(port, '127.0.0.1'));
    }
    override async executeReadiness() {
      events.push('readiness');
      return [];
    }
  }
  const adapter = new ProductionProducerAdapter({
    id: 'android',
    label: 'Android',
    platformName: 'Android',
    automationName: 'UiAutomator2',
  });
  const api = new MaatApi(new PlatformRegistry([adapter], 'android'), process.cwd(), {
    androidDetector: async () => {
      events.push('doctor');
      return aggregateSetup({ platform: 'android', capabilities: [] });
    },
  });
  await assert.rejects(api.setup.ready(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /ADB daemon unavailable/);
    assert.doesNotMatch(error.message, /PRIVATE_SERIAL|\/Users\/|adb devices|platform-tools/);
    return true;
  });
  assert.deepEqual(events, ['adb-socket']);
});
