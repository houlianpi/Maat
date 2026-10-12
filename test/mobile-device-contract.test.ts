import assert from 'node:assert/strict';
import test from 'node:test';
import * as contracts from '../packages/core/src/mobile/contracts/device.ts';
import {
  canonicalDeviceKey,
  confirmInitialBinding,
  identityFromLocalFact,
  parseDeviceBinding,
  planDeviceSelection,
  sameDeviceIdentity,
  type DeviceBinding,
  type DeviceIdentity,
} from '../packages/core/src/mobile/contracts/device.ts';
import * as publicCore from '../packages/core/src/index.ts';
import { parseAndroidDevices } from '../packages/core/src/setup/devices.ts';
import { parseIosDeviceList } from '../packages/core/src/setup/ios-devices.ts';

const endpointId = 'synthetic-endpoint-A';
const android: DeviceIdentity = {
  platform: 'android',
  providerInstanceId: 'local-adb',
  routingId: 'synthetic-android-serial-A',
  kind: 'device',
  transportScope: 'local-adb',
  displayName: 'Synthetic Phone',
};
const ios: DeviceIdentity = {
  platform: 'ios',
  providerInstanceId: 'local-core-device',
  routingId: 'synthetic-ios-physical-udid-A',
  kind: 'device',
  transportScope: 'core-device',
  displayName: 'Synthetic iPhone',
};
const other: DeviceIdentity = { ...android, routingId: 'synthetic-android-serial-B' };
const binding: DeviceBinding = {
  version: 1,
  identity: android,
  endpointId,
  displayNameAtBinding: android.displayName,
};

function coreDeviceList(modern: boolean, connected = true) {
  const hardware = {
    platform: 'iOS',
    reality: 'physical',
    udid: ios.routingId,
  };
  const state = { name: ios.displayName, developerModeStatus: 'enabled' };
  const connection = {
    state: connected ? 'connected' : 'disconnected',
    tunnelState: connected ? 'connected' : 'disconnected',
    pairingState: 'paired',
  };
  return JSON.stringify({
    result: {
      devices: [
        {
          identifier: 'synthetic-core-device-identifier-NOT-udid',
          ...(modern
            ? { properties: { hardware, state, connection } }
            : {
                hardwareProperties: hardware,
                deviceProperties: state,
                connectionProperties: connection,
              }),
        },
      ],
    },
  });
}

function assertSafeError(work: () => unknown, message: RegExp) {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, message);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message, /synthetic-|private-marker/);
    return true;
  });
}

test('local Android facts use the actual parser serial and fixed provider namespace', () => {
  const devices = parseAndroidDevices(
    'List of devices attached\nsynthetic-android-serial-A device model:Synthetic_Phone\nemulator-synthetic-A device model:Synthetic_Emulator\nsynthetic-offline offline\n',
  );
  assert.equal(devices.length, 2);
  const identities = devices.map((device) =>
    identityFromLocalFact({ source: 'local-adb', platform: 'android', device }),
  );
  assert.deepEqual(identities[0], { ...android, displayName: 'Synthetic_Phone' });
  assert.deepEqual(identities[1], {
    ...android,
    routingId: 'emulator-synthetic-A',
    kind: 'emulator',
    displayName: 'Synthetic_Emulator',
  });
  const proposal = planDeviceSelection({ candidates: identities });
  assert.equal(proposal.status, 'selection-required');
  assert.equal(
    confirmInitialBinding(proposal, identities[1]!, endpointId, true)?.identity.kind,
    'emulator',
  );
});

test('both actual CoreDevice parser formats use physical UDID, not identifier or connection state', () => {
  for (const modern of [false, true]) {
    const [device] = parseIosDeviceList(coreDeviceList(modern));
    const [disconnected] = parseIosDeviceList(coreDeviceList(modern, false));
    assert.ok(device && disconnected);
    const identity = identityFromLocalFact({
      source: 'local-core-device',
      platform: 'ios',
      device,
    });
    assert.deepEqual(identity, ios);
    assert.equal(identity.routingId, ios.routingId);
    assert.notEqual(identity.routingId, 'synthetic-core-device-identifier-NOT-udid');
    assert.ok(
      sameDeviceIdentity(
        identity,
        identityFromLocalFact({
          source: 'local-core-device',
          platform: 'ios',
          device: { ...disconnected, paired: false, developerMode: 'disabled' },
        }),
      ),
    );
    const proposal = planDeviceSelection({ candidates: [identity] });
    assert.equal(
      confirmInitialBinding(proposal, identity, endpointId, true)?.identity.routingId,
      ios.routingId,
    );
  }
});

test('local normalization rejects source, platform, kind and raw metadata conflicts safely', () => {
  const device = { id: android.routingId, name: android.displayName, kind: 'device' };
  const [phone] = parseIosDeviceList(coreDeviceList(true));
  const invalid = [
    null,
    [],
    {},
    { source: 'remote-adb', platform: 'android', device },
    { source: 'local-adb', platform: 'ios', device },
    { source: 'local-core-device', platform: 'android', device: phone },
    { source: 'local-adb', platform: 'android', device: { ...device, kind: 'simulator' } },
    { source: 'local-adb', platform: 'android', device: { ...device, kind: 'host' } },
    { source: 'local-core-device', platform: 'ios', device: { ...phone, kind: 'simulator' } },
    { source: 'local-core-device', platform: 'ios', device: { ...phone, kind: 'emulator' } },
    {
      source: 'local-core-device',
      platform: 'ios',
      device: { ...phone, developerMode: { toString: () => 'enabled' } },
    },
    { source: 'local-core-device', platform: 'ios', device },
    { source: 'local-adb', platform: 'android', transportScope: 'core-device', device },
    { source: 'local-core-device', platform: 'ios', device: JSON.parse(coreDeviceList(true)) },
    { source: 'local-adb', platform: 'android', device: { ...device, id: ' ' } },
    { source: 'local-adb', platform: 'android', device: { ...device, name: '' } },
    {
      get source() {
        throw new Error('private-marker');
      },
      platform: 'android',
      device,
    },
  ];
  for (const fact of invalid)
    assertSafeError(() => identityFromLocalFact(fact), /^Invalid local device fact\.$/);
});

test('identity equality compares exactly four fields, ignoring display and connection facts', () => {
  const renamed = { ...android, displayName: 'Renamed', connected: false };
  assert.ok(sameDeviceIdentity(android, renamed));
  assert.ok(sameDeviceIdentity(android, { ...android, transportScope: 'core-device' }));
  assert.equal(canonicalDeviceKey(android), canonicalDeviceKey(renamed));
  for (const different of [
    { ...android, platform: 'ios' as const },
    { ...android, providerInstanceId: 'synthetic-other-provider' },
    other,
    { ...android, kind: 'emulator' as const },
  ]) {
    assert.equal(sameDeviceIdentity(android, different), false);
    assert.notEqual(canonicalDeviceKey(android), canonicalDeviceKey(different));
  }
});

test('canonical key is a v1 fixed-order JSON tuple, with no separator collision or normalization', () => {
  assert.deepEqual(JSON.parse(canonicalDeviceKey(android)), [
    1,
    'android',
    'local-adb',
    android.routingId,
    'device',
  ]);
  const variants = [
    android,
    { ...android, routingId: android.routingId.toUpperCase() },
    { ...android, routingId: 'synthetic-é' },
    { ...android, routingId: 'synthetic-e\u0301' },
    { ...android, providerInstanceId: 'synthetic-a|b', routingId: 'synthetic-c' },
    { ...android, providerInstanceId: 'synthetic-a', routingId: 'b|synthetic-c' },
    { ...android, routingId: 'synthetic-["quoted"]\\route\n' },
    ios,
  ];
  const keys = variants.map(canonicalDeviceKey);
  assert.equal(new Set(keys).size, variants.length);
  for (const identity of variants)
    assert.equal(JSON.parse(canonicalDeviceKey(identity))[3], identity.routingId);
  assert.equal(sameDeviceIdentity(variants[2]!, variants[3]!), false);
  assert.equal(sameDeviceIdentity(android, variants[1]!), false);
});

test('binding parser accepts v1, preserves exact strings and returns detached identity data', () => {
  const parsed = parseDeviceBinding(binding);
  assert.equal(parsed.status, 'valid');
  if (parsed.status !== 'valid') assert.fail('Expected a valid binding');
  assert.deepEqual(parsed.binding, binding);
  assert.notEqual(parsed.binding, binding);
  assert.notEqual(parsed.binding.identity, android);
  assert.equal(parseDeviceBinding({ version: 1, identity: ios, endpointId }).status, 'valid');
  assert.equal(
    parseDeviceBinding({ ...binding, identity: { ...ios, kind: 'simulator' } }).status,
    'valid',
  );
  const exact = parseDeviceBinding({ ...binding, endpointId: ' Synthetic Endpoint ' });
  assert.equal(exact.status, 'valid');
  if (exact.status === 'valid') assert.equal(exact.binding.endpointId, ' Synthetic Endpoint ');
});

test('binding parser snapshots a changing endpoint getter and its successful output parses again', () => {
  let reads = 0;
  const value = {
    ...binding,
    get endpointId() {
      return ++reads === 1 ? endpointId : '';
    },
  };
  const parsed = parseDeviceBinding(value);
  assert.equal(parsed.status, 'valid');
  if (parsed.status !== 'valid') assert.fail('Expected a valid binding snapshot');
  assert.equal(parsed.binding.endpointId, endpointId);
  assert.equal(reads, 1);
  assert.deepEqual(parseDeviceBinding(parsed.binding), parsed);
});

test('binding parser snapshots a changing optional display name getter', () => {
  let reads = 0;
  const value = {
    ...binding,
    get displayNameAtBinding() {
      return ++reads === 1 ? 'Synthetic Captured Name' : '';
    },
  };
  const parsed = parseDeviceBinding(value);
  assert.equal(parsed.status, 'valid');
  if (parsed.status !== 'valid') assert.fail('Expected a valid binding snapshot');
  assert.equal(parsed.binding.displayNameAtBinding, 'Synthetic Captured Name');
  assert.equal(reads, 1);
  assert.deepEqual(parseDeviceBinding(parsed.binding), parsed);
});

test('binding parser uses only the first version value, including unsupported versions', () => {
  for (const firstVersion of [1, 2]) {
    let reads = 0;
    const value = {
      ...binding,
      get version() {
        return ++reads === 1 ? firstVersion : firstVersion === 1 ? 2 : 1;
      },
    };
    const parsed = parseDeviceBinding(value);
    if (firstVersion === 1) {
      assert.deepEqual(parsed, { status: 'valid', binding });
      if (parsed.status !== 'valid') assert.fail('Expected a valid binding snapshot');
      assert.deepEqual(parseDeviceBinding(parsed.binding), parsed);
    } else
      assert.deepEqual(parsed, {
        status: 'unsupported-version',
        message: 'Unsupported device binding version.',
      });
    assert.equal(reads, 1);
  }
});

test('absent own optional fields do not read or retain inherited accessors', () => {
  const identity = { ...android };
  delete identity.displayName;
  let inheritedReads = 0;
  Object.setPrototypeOf(identity, {
    get displayName() {
      inheritedReads++;
      throw new Error('private-marker');
    },
  });
  const value = { version: 1, identity, endpointId };
  Object.setPrototypeOf(value, {
    get displayNameAtBinding() {
      inheritedReads++;
      throw new Error('private-marker');
    },
  });
  const parsed = parseDeviceBinding(value);
  assert.equal(parsed.status, 'valid');
  if (parsed.status !== 'valid') assert.fail('Expected a valid nameless binding');
  assert.equal(Object.hasOwn(parsed.binding.identity, 'displayName'), false);
  assert.equal(Object.hasOwn(parsed.binding, 'displayNameAtBinding'), false);
  assert.equal(inheritedReads, 0);
  assert.deepEqual(parseDeviceBinding(parsed.binding), parsed);
});

test('CoreDevice normalization snapshots physical kind before constructing identity', () => {
  const [phone] = parseIosDeviceList(coreDeviceList(true));
  assert.ok(phone);
  let reads = 0;
  const device = {
    ...phone,
    get kind() {
      return ++reads === 1 ? 'device' : 'simulator';
    },
  };
  const identity = identityFromLocalFact({
    source: 'local-core-device',
    platform: 'ios',
    device,
  });
  assert.deepEqual(identity, ios);
  assert.equal(reads, 1);
  const parsed = parseDeviceBinding({ version: 1, identity, endpointId });
  assert.equal(parsed.status, 'valid');
  if (parsed.status === 'valid') assert.deepEqual(parseDeviceBinding(parsed.binding), parsed);
});

test('local normalization snapshots routing/display/connection facts once', () => {
  const [phone] = parseIosDeviceList(coreDeviceList(true));
  assert.ok(phone);
  const reads = { id: 0, name: 0, connected: 0, paired: 0, developerMode: 0 };
  const device = {
    ...phone,
    get id() {
      return ++reads.id === 1 ? ios.routingId : '';
    },
    get name() {
      return ++reads.name === 1 ? ios.displayName : '';
    },
    get connected() {
      return ++reads.connected === 1 ? true : 'private-marker';
    },
    get paired() {
      return ++reads.paired === 1 ? true : 'private-marker';
    },
    get developerMode() {
      return ++reads.developerMode === 1 ? 'disabled' : 'private-marker';
    },
  };
  assert.deepEqual(
    identityFromLocalFact({ source: 'local-core-device', platform: 'ios', device }),
    ios,
  );
  assert.deepEqual(reads, { id: 1, name: 1, connected: 1, paired: 1, developerMode: 1 });
});

test('legacy selection snapshots kind/name before matching candidates', () => {
  const emulator: DeviceIdentity = { ...other, kind: 'emulator' };
  for (const changingField of ['kind', 'name']) {
    const reads = { kind: 0, name: 0 };
    const legacyHints = {
      get kind() {
        return ++reads.kind === 1 || changingField !== 'kind' ? 'device' : 'emulator';
      },
      get name() {
        return ++reads.name === 1 || changingField !== 'name'
          ? android.displayName
          : ios.displayName;
      },
    };
    const proposal = planDeviceSelection({ candidates: [android, ios, emulator], legacyHints });
    assert.deepEqual(proposal, {
      status: 'preselected',
      candidate: android,
      reason: 'legacy-migration',
    });
    assert.deepEqual(reads, { kind: 1, name: 1 });
    assert.deepEqual(confirmInitialBinding(proposal, android, endpointId, true), binding);
  }
});

test('confirmation snapshots proposal identity before membership check and output', () => {
  let reads = 0;
  let statusReads = 0;
  const candidate = {
    ...android,
    get routingId() {
      return ++reads === 1 ? android.routingId : other.routingId;
    },
  };
  const confirmed = confirmInitialBinding(
    {
      get status() {
        statusReads++;
        return 'preselected' as const;
      },
      candidate,
      reason: 'initial-selection',
    },
    android,
    endpointId,
    true,
  );
  assert.deepEqual(confirmed, binding);
  assert.equal(reads, 1);
  assert.equal(statusReads, 1);
  assert.deepEqual(parseDeviceBinding(confirmed), { status: 'valid', binding });
});

test('invalid first getter values are rejected without rereading later valid values', () => {
  let endpointReads = 0;
  let displayReads = 0;
  let kindReads = 0;
  const invalidEndpoint = parseDeviceBinding({
    ...binding,
    get endpointId() {
      return ++endpointReads === 1 ? '' : endpointId;
    },
  });
  const invalidDisplay = parseDeviceBinding({
    ...binding,
    get displayNameAtBinding() {
      return ++displayReads === 1 ? undefined : 'Synthetic Later Name';
    },
  });
  for (const parsed of [invalidEndpoint, invalidDisplay]) {
    assert.deepEqual(parsed, {
      status: 'invalid-format',
      message: 'Invalid device binding format.',
    });
    assert.equal(Object.hasOwn(parsed, 'cause'), false);
    assert.doesNotMatch(JSON.stringify(parsed), /synthetic-|private-marker/);
  }
  const [phone] = parseIosDeviceList(coreDeviceList(true));
  assert.ok(phone);
  assertSafeError(
    () =>
      identityFromLocalFact({
        source: 'local-core-device',
        platform: 'ios',
        device: {
          ...phone,
          get kind() {
            return ++kindReads === 1 ? 'simulator' : 'device';
          },
        },
      }),
    /^Invalid local device fact\.$/,
  );
  assert.deepEqual([endpointReads, displayReads, kindReads], [1, 1, 1]);
});

test('binding parser distinguishes format/version failures and rejects private or extra fields', () => {
  const invalid = [
    undefined,
    null,
    [],
    {},
    'private-marker',
    { ...binding, version: '1' },
    { ...binding, version: 1.5 },
    { ...binding, version: NaN },
    { ...binding, version: Infinity },
    { ...binding, endpointId: '' },
    { ...binding, endpointId: ' ' },
    { ...binding, endpointId: 1 },
    { ...binding, displayNameAtBinding: null },
    { ...binding, displayNameAtBinding: undefined },
    { ...binding, sessionId: 'private-marker' },
    { ...binding, SessionId: 'private-marker' },
    { ...binding, credentials: { token: 'private-marker' } },
    { ...binding, logs: ['private-marker'] },
    { ...binding, [Symbol('private-marker')]: 'private-marker' },
    { ...binding, identity: { ...android, sessionId: 'private-marker' } },
    { ...binding, identity: { ...android, connected: true } },
    { ...binding, identity: { ...android, displayName: '' } },
    { ...binding, identity: { ...android, routingId: ' ' } },
    { ...binding, identity: { ...android, providerInstanceId: 'remote-adb' } },
    { ...binding, identity: { ...android, providerInstanceId: 'local-core-device' } },
    { ...binding, identity: { ...android, transportScope: 'core-device' } },
    { ...binding, identity: { ...android, kind: 'simulator' } },
    { ...binding, identity: { ...ios, kind: 'emulator' } },
    { ...binding, identity: { ...ios, transportScope: 'local-adb' } },
    { ...binding, identity: { ...ios, platform: 'macos' } },
    {
      ...binding,
      get identity() {
        throw new Error('private-marker');
      },
    },
  ];
  for (const value of invalid) {
    const parsed = parseDeviceBinding(value);
    assert.deepEqual(parsed, {
      status: 'invalid-format',
      message: 'Invalid device binding format.',
    });
    assert.equal(Object.hasOwn(parsed, 'cause'), false);
    assert.doesNotMatch(JSON.stringify(parsed), /private-marker|synthetic-/);
    assert.deepEqual(planDeviceSelection({ candidates: [], binding: value }), {
      status: 'invalid-binding',
      reason: 'invalid-format',
    });
  }
  for (const version of [0, 2, -1]) {
    const value = { ...binding, version };
    assert.deepEqual(parseDeviceBinding(value), {
      status: 'unsupported-version',
      message: 'Unsupported device binding version.',
    });
    assert.deepEqual(planDeviceSelection({ candidates: [android], binding: value }), {
      status: 'invalid-binding',
      reason: 'unsupported-version',
    });
  }
});

test('first selection returns not-found, preselection or explicit multi-selection without binding', () => {
  assert.deepEqual(planDeviceSelection({ candidates: [] }), { status: 'device-not-found' });
  const one = planDeviceSelection({ candidates: [android] });
  assert.deepEqual(one, { status: 'preselected', candidate: android, reason: 'initial-selection' });
  const multiple = planDeviceSelection({ candidates: [android, ios] });
  assert.deepEqual(multiple, { status: 'selection-required', candidates: [android, ios] });
  for (const proposal of [one, multiple]) {
    for (const confirmation of [undefined, false, 'true', 1])
      assert.equal(confirmInitialBinding(proposal, android, endpointId, confirmation), undefined);
  }
  assert.deepEqual(confirmInitialBinding(multiple, ios, endpointId, true), {
    version: 1,
    identity: ios,
    endpointId,
    displayNameAtBinding: ios.displayName,
  });
  assert.equal(Object.hasOwn(one, 'binding'), false);
  assert.equal(Object.hasOwn(multiple, 'binding'), false);
});

test('bound selection reuses only the exact identity and preserves binding/endpoint after renaming', () => {
  const before = JSON.stringify(binding);
  assert.deepEqual(
    planDeviceSelection({ candidates: [other, { ...android, displayName: 'Renamed' }], binding }),
    { status: 'reuse', binding },
  );
  for (const candidates of [[], [other], [ios], [other, ios]]) {
    const proposal = planDeviceSelection({ candidates, binding });
    assert.deepEqual(proposal, { status: 'configured-device-unavailable', binding });
    assertSafeError(
      () => confirmInitialBinding(proposal, other, endpointId, true),
      /cannot be confirmed/,
    );
  }
  const reused = planDeviceSelection({ candidates: [android], binding });
  assertSafeError(
    () => confirmInitialBinding(reused, android, 'synthetic-endpoint-B', true),
    /cannot be confirmed/,
  );
  assert.equal(JSON.stringify(binding), before);
});

test('legacy migration requires complete kind/name, a unique strict match and confirmation', () => {
  const legacyHints = { kind: 'device', name: android.displayName };
  const proposal = planDeviceSelection({ candidates: [android, ios], legacyHints });
  assert.deepEqual(proposal, {
    status: 'preselected',
    candidate: android,
    reason: 'legacy-migration',
  });
  assert.equal(confirmInitialBinding(proposal, android, endpointId, false), undefined);
  assert.deepEqual(confirmInitialBinding(proposal, android, endpointId, true), binding);
  const sameNameEmulator: DeviceIdentity = { ...other, kind: 'emulator' };
  assert.equal(
    planDeviceSelection({ candidates: [android, sameNameEmulator], legacyHints }).status,
    'preselected',
  );
  for (const candidates of [[], [ios], [android, other], [android, android]]) {
    const unresolved = planDeviceSelection({ candidates, legacyHints });
    assert.equal(unresolved.status, 'legacy-selection-required');
    assertSafeError(
      () => confirmInitialBinding(unresolved, android, endpointId, true),
      /cannot be confirmed/,
    );
  }
});

test('legacy names use strict code-unit equality without trimming, case folding or NFC', () => {
  for (const name of ['synthetic phone', ' Synthetic Phone ', 'Synthetic Phone '])
    assert.equal(
      planDeviceSelection({ candidates: [android], legacyHints: { kind: 'device', name } }).status,
      'legacy-selection-required',
    );
  const accented: DeviceIdentity = { ...android, displayName: 'Synthetic-é' };
  assert.equal(
    planDeviceSelection({
      candidates: [accented],
      legacyHints: { kind: 'device', name: 'Synthetic-e\u0301' },
    }).status,
    'legacy-selection-required',
  );
  assert.equal(
    planDeviceSelection({
      candidates: [accented],
      legacyHints: { kind: 'device', name: 'Synthetic-é' },
    }).status,
    'preselected',
  );
});

test('incomplete or malformed legacy hints never become absent hints or a migration', () => {
  for (const legacyHints of [
    undefined,
    null,
    [],
    {},
    { kind: 'device' },
    { name: android.displayName },
    { kind: 'device', name: '' },
    { kind: 'device', name: ' ' },
    { kind: 'host', name: android.displayName },
    { kind: 1, name: android.displayName },
    { kind: 'device', name: android.displayName, sessionId: 'private-marker' },
  ]) {
    const proposal = planDeviceSelection({ candidates: [android], legacyHints });
    assert.equal(proposal.status, 'legacy-selection-required');
    assertSafeError(
      () => confirmInitialBinding(proposal, android, endpointId, true),
      /cannot be confirmed/,
    );
  }
  assert.equal(
    planDeviceSelection({ candidates: [android], binding, legacyHints: {} }).status,
    'reuse',
  );
});

test('confirmation rejects missing selection, foreign identity and invalid endpoints without echoing input', () => {
  const proposal = planDeviceSelection({ candidates: [android] });
  assertSafeError(
    () => confirmInitialBinding(proposal, other, endpointId, true),
    /not in the proposal/,
  );
  assertSafeError(
    () => confirmInitialBinding(proposal, ios, endpointId, true),
    /not in the proposal/,
  );
  assertSafeError(
    () => confirmInitialBinding({ status: 'device-not-found' }, android, endpointId, true),
    /cannot be confirmed/,
  );
  for (const invalidEndpoint of [undefined, null, {}, '', ' ', 1])
    assertSafeError(
      () => confirmInitialBinding(proposal, android, invalidEndpoint, true),
      /Invalid binding endpoint ID/,
    );
  const renamed = { ...android, displayName: 'Unrelated display name' };
  assert.deepEqual(confirmInitialBinding(proposal, renamed, endpointId, true), binding);
  assertSafeError(
    () => planDeviceSelection({ candidates: [{ ...android, transportScope: 'core-device' }] }),
    /Invalid device candidates/,
  );
});

test('pure proposals and constructed bindings do not mutate or retain caller-owned identity objects', () => {
  const identity = Object.freeze({ ...android });
  const candidates = Object.freeze([identity]);
  const proposal = planDeviceSelection({ candidates });
  assert.equal(proposal.status, 'preselected');
  if (proposal.status !== 'preselected') assert.fail('Expected preselection');
  proposal.candidate.displayName = 'Proposal Name';
  assert.equal(identity.displayName, android.displayName);
  const confirmed = confirmInitialBinding(proposal, identity, endpointId, true);
  assert.ok(confirmed);
  confirmed.identity.displayName = 'Binding Name';
  assert.equal(proposal.candidate.displayName, 'Proposal Name');
});

test('new contract functions are source-internal and absent from the actual Core root exports', () => {
  for (const name of Object.keys(contracts))
    assert.equal(Object.hasOwn(publicCore, name), false, name);
});
