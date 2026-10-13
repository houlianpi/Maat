import assert from 'node:assert/strict';
import test from 'node:test';
import { connect, createServer } from 'node:net';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AppiumPlatformAdapter } from '../packages/core/src/platforms/appium/appium-adapter.ts';
import type { Device } from '../packages/core/src/setup/devices.ts';
import type { IosDevice } from '../packages/core/src/setup/ios-devices.ts';
import type { TargetSelectionResult } from '../packages/core/src/mobile/contracts/device.ts';
import { identityFromLocalFact } from '../packages/core/src/mobile/contracts/device.ts';
import {
  acquireDeviceLock,
  setDeviceLockStateDirectoryForTests,
} from '../packages/core/src/mobile/devices/device-lock.ts';
import { MobileBusyError } from '../packages/core/src/mobile/devices/coordinator.ts';
import { MaatApi } from '../packages/core/src/api/maat-api.ts';
import { PlatformRegistry } from '../packages/core/src/core/platforms/registry.ts';
import { aggregateSetup } from '../packages/core/src/setup-assistant/model.ts';

let deviceLockRoot = '';
test.beforeEach(() => {
  deviceLockRoot = mkdtempSync(path.join(tmpdir(), 'maat-adapter-lock-'));
  setDeviceLockStateDirectoryForTests(deviceLockRoot);
});
test.afterEach(() => {
  setDeviceLockStateDirectoryForTests(undefined);
  rmSync(deviceLockRoot, { recursive: true, force: true });
});

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

class IosSelectionAdapter extends AppiumPlatformAdapter {
  devices: IosDevice[] = [];

  constructor() {
    super({
      id: 'ios',
      label: 'iOS',
      platformName: 'iOS',
      automationName: 'XCUITest',
    });
  }

  protected override async discoverSelectionDevices(): Promise<IosDevice[]> {
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
const iphones: IosDevice[] = [
  {
    id: 'PRIVATE_UDID_A',
    name: 'Alpha iPhone',
    kind: 'device',
    connected: true,
    paired: true,
    developerMode: 'enabled',
  },
  {
    id: 'PRIVATE_UDID_B',
    name: 'Beta iPhone',
    kind: 'device',
    connected: true,
    paired: true,
    developerMode: 'enabled',
  },
];

function phoneIdentity(device = phones[0]!) {
  return identityFromLocalFact({ source: 'local-adb', platform: 'android', device });
}

test('device lock conflict precedes lifecycle pin, Session, preparation, and action', async () => {
  const owner = acquireDeviceLock(phoneIdentity());
  const adapter = new SelectionAdapter();
  adapter.devices = [phones[0]!];
  try {
    await assert.rejects(adapter.selectReadinessTarget(), MobileBusyError);
    assert.equal(adapter.isMigratedLocalPhysicalRoute(), false);
    assert.equal(adapter.runtime.isRunning, false);
    assert.equal(adapter.runtime.currentSessionGeneration, undefined);
    assert.doesNotMatch(
      JSON.stringify(adapter, Object.getOwnPropertyNames(adapter)),
      /machine-secret|[a-f0-9]{64}|\.lock|deviceLock|file descriptor/i,
    );
  } finally {
    owner.release();
  }
});

test('stale selection acquires no lock and successful close releases the selected device', async () => {
  const staleAdapter = new SelectionAdapter();
  staleAdapter.devices = phones;
  const proposal = await staleAdapter.selectReadinessTarget();
  assert.equal(proposal.status, 'selection-required');
  if (proposal.status !== 'selection-required') return;
  staleAdapter.devices = [phones[0]!];
  assert.equal(
    (
      await staleAdapter.selectReadinessTarget({
        discoveryId: proposal.discoveryId,
        candidateNumber: 1,
      })
    ).status,
    'selection-stale',
  );
  acquireDeviceLock(phoneIdentity()).release();

  const adapter = new SelectionAdapter();
  adapter.devices = [phones[0]!];
  assert.equal((await adapter.selectReadinessTarget()).status, 'target-selected');
  assert.throws(() => acquireDeviceLock(phoneIdentity()), MobileBusyError);
  await adapter.close();
  acquireDeviceLock(phoneIdentity()).release();
});

test('Abort observed after acquisition releases before lifecycle pin', async () => {
  const controller = new AbortController();
  class AbortingSelectionAdapter extends SelectionAdapter {
    protected override async discoverSelectionDevices(): Promise<Device[]> {
      controller.abort(new Error('test abort'));
      return [phones[0]!];
    }
  }
  const adapter = new AbortingSelectionAdapter();
  await assert.rejects(adapter.selectReadinessTarget(undefined, controller.signal), /test abort/);
  assert.equal(adapter.isMigratedLocalPhysicalRoute(), false);
  acquireDeviceLock(phoneIdentity()).release();
});

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

test('exact legacy name and kind narrow only the proposal and still require explicit selection', async () => {
  const adapter = new SelectionAdapter();
  await adapter.configureSession({
    device: { kind: 'device', name: 'Alpha Phone' },
  });
  adapter.devices = phones;
  const proposal = await adapter.selectReadinessTarget();
  assert.equal(proposal.status, 'selection-required');
  if (proposal.status !== 'selection-required') return;
  assert.deepEqual(
    proposal.candidates.map(({ candidateNumber, displayName }) => ({
      candidateNumber,
      displayName,
    })),
    [{ candidateNumber: 1, displayName: 'Alpha Phone' }],
  );
  assert.equal(adapter.runtime.isRunning, false);
  assert.equal(
    (
      await adapter.selectReadinessTarget({
        discoveryId: proposal.discoveryId,
        candidateNumber: 2,
      })
    ).status,
    'selection-invalid',
  );

  adapter.devices = [{ ...phones[0]!, name: 'Renamed Alpha' }, phones[1]!];
  const selected = await adapter.selectReadinessTarget({
    discoveryId: proposal.discoveryId,
    candidateNumber: 1,
  });
  assert.equal(selected.status, 'target-selected');
  if (selected.status === 'target-selected') {
    assert.equal(selected.selectedBy, 'explicit-user-selection');
    assert.equal(selected.candidate.displayName, 'Renamed Alpha');
  }
});

test('top-level and supported nested Appium deviceName hints narrow an exact proposal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-capability-hints-'));
  const previous = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  try {
    for (const capabilities of [
      { 'appium:deviceName': 'Beta Phone' },
      { 'appium:options': { deviceName: 'Beta Phone' } },
      { 'appium:options': { 'appium:deviceName': 'Beta Phone' } },
    ]) {
      const adapter = new SelectionAdapter();
      await adapter.configureSession({ capabilities });
      adapter.devices = phones;
      const proposal = await adapter.selectReadinessTarget();
      assert.equal(proposal.status, 'selection-required');
      if (proposal.status !== 'selection-required') continue;
      assert.deepEqual(
        proposal.candidates.map(({ candidateNumber, displayName }) => ({
          candidateNumber,
          displayName,
        })),
        [{ candidateNumber: 2, displayName: 'Beta Phone' }],
      );
      assert.equal(
        (
          await adapter.selectReadinessTarget({
            discoveryId: proposal.discoveryId,
            candidateNumber: 2,
          })
        ).status,
        'target-selected',
      );
      await adapter.close();
    }
  } finally {
    if (previous === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale device selector conflicts with exact top-level or nested deviceName hints', async () => {
  for (const capabilities of [
    { 'appium:deviceName': 'Beta Phone' },
    { 'appium:options': { deviceName: 'Beta Phone' } },
    { 'appium:options': { 'appium:deviceName': 'Beta Phone' } },
  ]) {
    const adapter = new SelectionAdapter();
    await adapter.configureSession({
      device: { kind: 'device', name: 'Old Phone' },
      capabilities,
    });
    adapter.devices = phones;
    const proposal = await adapter.selectReadinessTarget();
    assert.equal(proposal.status, 'selection-required');
    if (proposal.status === 'selection-required')
      assert.deepEqual(
        proposal.candidates.map((candidate) => candidate.displayName),
        ['Alpha Phone', 'Beta Phone'],
      );
  }
});

test('non-string and blank capability deviceName values never coerce or narrow', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-invalid-capability-hints-'));
  const previous = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const values: unknown[] = ['', '   ', 42, { value: 'Alpha Phone' }];
  try {
    for (const value of values) {
      for (const capabilities of [
        { 'appium:deviceName': value },
        { 'appium:options': { deviceName: value } },
        { 'appium:options': { 'appium:deviceName': value } },
      ]) {
        const adapter = new SelectionAdapter();
        await adapter.configureSession({ capabilities });
        adapter.devices = phones;
        const proposal = await adapter.selectReadinessTarget();
        assert.equal(proposal.status, 'selection-required');
        if (proposal.status === 'selection-required')
          assert.deepEqual(
            proposal.candidates.map((candidate) => candidate.displayName),
            ['Alpha Phone', 'Beta Phone'],
          );
      }
    }
  } finally {
    if (previous === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('iOS uses the same strict exact hint narrowing contract', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ios-selection-hints-'));
  const previous = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  try {
    const adapter = new IosSelectionAdapter();
    await adapter.configureSession({
      serverUrl: 'http://127.0.0.1:4723/',
      device: { kind: 'device', name: 'Beta iPhone' },
    });
    adapter.devices = iphones;
    const proposal = await adapter.selectReadinessTarget();
    assert.equal(proposal.status, 'selection-required');
    if (proposal.status !== 'selection-required') return;
    assert.deepEqual(
      proposal.candidates.map(({ candidateNumber, displayName, platform }) => ({
        candidateNumber,
        displayName,
        platform,
      })),
      [{ candidateNumber: 2, displayName: 'Beta iPhone', platform: 'ios' }],
    );
    assert.doesNotMatch(
      JSON.stringify(proposal),
      /PRIVATE_UDID|routingId|udid|canonical|credential|endpoint|serverUrl/i,
    );
  } finally {
    if (previous === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('ambiguous, inexact, stale, conflicting, and kind-only legacy hints never narrow', async () => {
  const cases: Array<{
    name: string;
    setup: Parameters<SelectionAdapter['configureSession']>[0];
    devices?: Device[];
  }> = [
    { name: 'case mismatch', setup: { device: { name: 'alpha phone' } } },
    { name: 'space mismatch', setup: { device: { name: 'Alpha Phone ' } } },
    { name: 'accent mismatch', setup: { device: { name: 'Alphá Phone' } } },
    { name: 'stale name', setup: { device: { name: 'Old Phone' } } },
    { name: 'kind mismatch', setup: { device: { kind: 'host', name: 'Alpha Phone' } } },
    { name: 'kind-only multiple match', setup: { device: { kind: 'device' } } },
    {
      name: 'conflicting hints',
      setup: {
        device: { name: 'Alpha Phone' },
        capabilities: { 'appium:deviceName': 'Beta Phone' },
      },
    },
    {
      name: 'conflicting nested hints',
      setup: {
        capabilities: {
          'appium:deviceName': 'Alpha Phone',
          'appium:options': { deviceName: 'Beta Phone' },
        },
      },
    },
    {
      name: 'same-name ambiguity',
      setup: { device: { name: 'Alpha Phone' } },
      devices: [phones[0]!, { ...phones[1]!, name: 'Alpha Phone' }],
    },
    {
      name: 'unrecognized provider capability',
      setup: { capabilities: { 'vendor:options': { deviceName: 'Alpha Phone' } } },
    },
  ];

  for (const entry of cases) {
    const adapter = new SelectionAdapter();
    await adapter.configureSession(entry.setup);
    adapter.devices = entry.devices ?? phones;
    const proposal = await adapter.selectReadinessTarget();
    assert.equal(proposal.status, 'selection-required', entry.name);
    if (proposal.status === 'selection-required')
      assert.equal(proposal.candidates.length, 2, entry.name);
  }
});

test('legacy hints do not change the existing zero or single-candidate outcomes', async () => {
  const adapter = new SelectionAdapter();
  await adapter.configureSession({ device: { kind: 'device', name: 'Stale Phone' } });
  assert.equal((await adapter.selectReadinessTarget()).status, 'device-not-found');
  adapter.devices = [phones[0]!];
  const selected = await adapter.selectReadinessTarget();
  assert.equal(selected.status, 'target-selected');
  if (selected.status === 'target-selected') assert.equal(selected.selectedBy, 'single-candidate');
});

test('hint-filtered proposals retain the full discovery generation', async () => {
  const adapter = new SelectionAdapter();
  await adapter.configureSession({ device: { name: 'Alpha Phone' } });
  adapter.devices = phones;
  const proposal = await adapter.selectReadinessTarget();
  assert.equal(proposal.status, 'selection-required');
  if (proposal.status !== 'selection-required') return;

  adapter.devices = [phones[0]!, { ...phones[1]!, id: 'PRIVATE_SERIAL_REPLACEMENT' }];
  const stale = await adapter.selectReadinessTarget({
    discoveryId: proposal.discoveryId,
    candidateNumber: 1,
  });
  assert.equal(stale.status, 'selection-stale');
  assert.doesNotMatch(JSON.stringify(stale), /PRIVATE_SERIAL/);
});

test('hint-filtered proposals become stale when a hidden identity is added', async () => {
  const adapter = new SelectionAdapter();
  await adapter.configureSession({ device: { name: 'Alpha Phone' } });
  adapter.devices = phones;
  const proposal = await adapter.selectReadinessTarget();
  assert.equal(proposal.status, 'selection-required');
  if (proposal.status !== 'selection-required') return;

  adapter.devices = [...phones, { id: 'PRIVATE_SERIAL_C', name: 'Gamma Phone', kind: 'device' }];
  assert.equal(
    (
      await adapter.selectReadinessTarget({
        discoveryId: proposal.discoveryId,
        candidateNumber: 1,
      })
    ).status,
    'selection-stale',
  );
});

test('candidate reordering preserves identity selection and reports the current display name', async () => {
  const adapter = new SelectionAdapter();
  await adapter.configureSession({ capabilities: { 'appium:deviceName': 'Beta Phone' } });
  adapter.devices = phones;
  const proposal = await adapter.selectReadinessTarget();
  assert.equal(proposal.status, 'selection-required');
  if (proposal.status !== 'selection-required') return;

  adapter.devices = [{ ...phones[1]!, name: 'Renamed Beta' }, phones[0]!];
  const selected = await adapter.selectReadinessTarget({
    discoveryId: proposal.discoveryId,
    candidateNumber: 2,
  });
  assert.equal(selected.status, 'target-selected');
  if (selected.status === 'target-selected')
    assert.equal(selected.candidate.displayName, 'Renamed Beta');
});

test('duplicate stable discovery identities cannot be explicitly selected', async () => {
  const adapter = new SelectionAdapter();
  adapter.devices = [phones[0]!, { ...phones[0]!, name: 'Duplicate Alpha' }, phones[1]!];
  const proposal = await adapter.selectReadinessTarget();
  assert.equal(proposal.status, 'selection-required');
  if (proposal.status !== 'selection-required') return;

  const selected = await adapter.selectReadinessTarget({
    discoveryId: proposal.discoveryId,
    candidateNumber: 3,
  });
  assert.equal(selected.status, 'selection-stale');
});

test('selection discovery does not persist hints or expose stable routing identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-selection-hints-'));
  const previous = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  try {
    const adapter = new SelectionAdapter();
    await adapter.configureSession({ capabilities: { 'appium:deviceName': 'Beta Phone' } });
    adapter.devices = phones;
    const proposal = await adapter.selectReadinessTarget();
    assert.equal(proposal.status, 'selection-required');
    assert.deepEqual(await readdir(root), []);
    assert.doesNotMatch(
      JSON.stringify(proposal),
      /PRIVATE_SERIAL|routingId|udid|canonical|credential|endpoint|serverUrl|https?:/i,
    );
  } finally {
    if (previous === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
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

test('persisted compatibility hints only narrow fresh proposals after close or restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-restart-hints-'));
  const previous = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  await writeFile(
    path.join(root, 'android.json'),
    JSON.stringify({
      platform: 'android',
      device: { kind: 'device', name: 'Beta Phone' },
      capabilities: {},
    }),
  );
  try {
    const adapter = new SelectionAdapter();
    adapter.devices = phones;
    const first = await adapter.selectReadinessTarget();
    assert.equal(first.status, 'selection-required');
    if (first.status !== 'selection-required') return;
    assert.deepEqual(
      first.candidates.map((candidate) => candidate.displayName),
      ['Beta Phone'],
    );
    assert.equal(
      (
        await adapter.selectReadinessTarget({
          discoveryId: first.discoveryId,
          candidateNumber: 2,
        })
      ).status,
      'target-selected',
    );

    await adapter.close();
    const afterClose = await adapter.selectReadinessTarget();
    assert.equal(afterClose.status, 'selection-required');
    if (afterClose.status === 'selection-required')
      assert.deepEqual(
        afterClose.candidates.map((candidate) => candidate.displayName),
        ['Beta Phone'],
      );

    const restarted = new SelectionAdapter();
    restarted.devices = phones;
    const afterRestart = await restarted.selectReadinessTarget();
    assert.equal(afterRestart.status, 'selection-required');
    if (afterRestart.status === 'selection-required')
      assert.deepEqual(
        afterRestart.candidates.map((candidate) => candidate.displayName),
        ['Beta Phone'],
      );
  } finally {
    if (previous === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent successful API releases share one close operation and start fresh discovery', async () => {
  const adapter = new SelectionAdapter();
  adapter.devices = phones;
  let cleanups = 0;
  const originalClose = adapter.close.bind(adapter);
  adapter.close = async () => {
    cleanups++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await originalClose();
  };
  const proposal = await adapter.selectReadinessTarget();
  assert.equal(proposal.status, 'selection-required');
  if (proposal.status !== 'selection-required') return;
  await adapter.selectReadinessTarget({
    discoveryId: proposal.discoveryId,
    candidateNumber: 1,
  });
  const api = new MaatApi(new PlatformRegistry([adapter], 'android'), process.cwd());
  const firstRelease = api.mobile.releaseCurrentSession();
  const secondRelease = api.mobile.releaseCurrentSession();
  assert.equal(firstRelease, secondRelease);
  assert.deepEqual(await Promise.all([firstRelease, secondRelease]), [
    { released: true, platform: 'android' },
    { released: true, platform: 'android' },
  ]);
  assert.equal(cleanups, 1);
  assert.equal(
    (
      await adapter.selectReadinessTarget({
        discoveryId: proposal.discoveryId,
        candidateNumber: 1,
      })
    ).status,
    'selection-stale',
  );
  assert.equal((await adapter.selectReadinessTarget()).status, 'selection-required');
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
      technicalDetails: { serverScope: 'local' },
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

test('an explicitly selected capability-only proposal can continue through API readiness', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-api-capability-hint-'));
  const previous = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  class CapabilityHintAdapter extends SelectionAdapter {
    events: string[] = [];
    override async executeReadiness() {
      this.events.push('readiness');
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
  try {
    const adapter = new CapabilityHintAdapter();
    await adapter.configureSession({ capabilities: { 'appium:deviceName': 'Beta Phone' } });
    adapter.devices = phones;
    const api = new MaatApi(new PlatformRegistry([adapter], 'android'), process.cwd(), {
      androidDetector: async () => {
        adapter.events.push('doctor');
        return aggregateSetup({
          platform: 'android',
          technicalDetails: { serverScope: 'local' },
          capabilities: [
            {
              id: 'uiInteraction',
              status: 'ready',
              required: true,
              messageKey: 'capability.interaction.ready',
            },
          ],
        });
      },
    });

    const proposal = await api.setup.ready();
    assert.equal(proposal.ready, false);
    assert.equal(proposal.status, 'selection-required');
    if (proposal.status !== 'selection-required') return;
    assert.deepEqual(
      proposal.candidates.map((candidate) => candidate.displayName),
      ['Beta Phone'],
    );
    assert.deepEqual(adapter.events, []);
    assert.equal(adapter.isMigratedLocalPhysicalRoute(), false);

    const selected = await api.setup.ready({
      targetSelection: {
        discoveryId: proposal.discoveryId,
        candidateNumber: proposal.candidates[0]!.candidateNumber,
      },
    });
    assert.equal(selected.ready, false);
    assert.equal(selected.status, 'target-selected');
    assert.deepEqual(adapter.events, []);
    assert.equal(adapter.isMigratedLocalPhysicalRoute(), true);

    const ready = await api.setup.ready();
    assert.equal(ready.ready, true);
    assert.deepEqual(adapter.events, ['doctor', 'readiness']);
    await api.close();
  } finally {
    if (previous === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('capability hints never classify remote, emulator, or simulator routes as migrated', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-legacy-route-hints-'));
  const previous = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  try {
    const remote = new SelectionAdapter();
    await remote.configureSession({
      serverUrl: 'https://remote.example/',
      capabilities: { 'appium:deviceName': 'Alpha Phone' },
    });
    remote.devices = phones;
    assert.equal(await remote.selectReadinessTarget(), undefined);
    assert.equal(remote.isMigratedLocalPhysicalRoute(), false);

    const emulator = new SelectionAdapter();
    await emulator.configureSession({
      device: { kind: 'emulator', name: 'Android Emulator' },
      capabilities: { 'appium:deviceName': 'Alpha Phone' },
    });
    emulator.devices = phones;
    assert.equal(await emulator.selectReadinessTarget(), undefined);
    assert.equal(emulator.isMigratedLocalPhysicalRoute(), false);

    const simulator = new IosSelectionAdapter();
    await simulator.configureSession({
      device: { kind: 'simulator', name: 'iOS Simulator' },
      capabilities: { 'appium:deviceName': 'Alpha iPhone' },
    });
    simulator.devices = iphones;
    assert.equal(await simulator.selectReadinessTarget(), undefined);
    assert.equal(simulator.isMigratedLocalPhysicalRoute(), false);
  } finally {
    if (previous === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previous;
    await rm(root, { recursive: true, force: true });
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
