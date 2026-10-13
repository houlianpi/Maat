import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalDeviceKey,
  identityFromLocalFact,
  isLocalPhysicalMobileTarget,
  sameDeviceIdentity,
  type DeviceIdentity,
} from '../packages/core/src/mobile/contracts/device.ts';
import { parseAndroidDevices } from '../packages/core/src/setup/devices.ts';
import { parseIosDeviceList } from '../packages/core/src/setup/ios-devices.ts';

const android: DeviceIdentity = {
  platform: 'android',
  providerInstanceId: 'local-adb',
  routingId: 'synthetic-android-serial-A',
  kind: 'device',
  transportScope: 'local-adb',
  displayName: 'Synthetic Phone',
};

function coreDeviceList(connected = true) {
  return JSON.stringify({
    result: {
      devices: [
        {
          identifier: 'synthetic-core-device-identifier-NOT-udid',
          properties: {
            hardware: {
              platform: 'iOS',
              reality: 'physical',
              udid: 'synthetic-ios-physical-udid-A',
            },
            state: { name: 'Synthetic iPhone', developerModeStatus: 'enabled' },
            connection: {
              state: connected ? 'connected' : 'disconnected',
              pairingState: connected ? 'paired' : 'unpaired',
            },
          },
        },
      ],
    },
  });
}

test('local facts normalize parser identities without substituting display data', () => {
  const [device] = parseAndroidDevices(
    'List of devices attached\nsynthetic-android-serial-A device model:Synthetic_Phone\n',
  );
  assert.deepEqual(identityFromLocalFact({ source: 'local-adb', platform: 'android', device }), {
    ...android,
    displayName: 'Synthetic_Phone',
  });

  for (const connected of [true, false]) {
    const [iphone] = parseIosDeviceList(coreDeviceList(connected));
    const identity = identityFromLocalFact({
      source: 'local-core-device',
      platform: 'ios',
      device: iphone,
    });
    assert.equal(identity.routingId, 'synthetic-ios-physical-udid-A');
    assert.notEqual(identity.routingId, 'synthetic-core-device-identifier-NOT-udid');
  }
});

test('Android parser uses a safe generic label when ADB omits the model', () => {
  const rawSerial = 'PRIVATE_RAW_ADB_SERIAL';
  const rawEmulatorRoute = 'emulator-9876';
  const devices = parseAndroidDevices(
    `List of devices attached\n${rawSerial} device product:unknown\n${rawEmulatorRoute} device\n`,
  );
  assert.deepEqual(
    devices.map(({ name, kind }) => ({ name, kind })),
    [
      { name: 'Android device', kind: 'device' },
      { name: 'Android emulator', kind: 'emulator' },
    ],
  );
  assert.equal(
    devices.some(({ name }) => [rawSerial, rawEmulatorRoute].includes(name)),
    false,
  );
});

test('identity equality and canonical routing compare exactly the stable four-field tuple', () => {
  const renamed = { ...android, displayName: 'Renamed' };
  assert.ok(sameDeviceIdentity(android, renamed));
  assert.equal(canonicalDeviceKey(android), canonicalDeviceKey(renamed));

  for (const different of [
    { ...android, platform: 'ios' as const },
    { ...android, providerInstanceId: 'local-core-device' as const },
    { ...android, routingId: 'synthetic-android-serial-B' },
    { ...android, kind: 'emulator' as const },
  ] satisfies DeviceIdentity[]) {
    assert.equal(sameDeviceIdentity(android, different), false);
    assert.notEqual(canonicalDeviceKey(android), canonicalDeviceKey(different));
  }
  assert.deepEqual(JSON.parse(canonicalDeviceKey(android)), [
    1,
    'android',
    'local-adb',
    android.routingId,
    'device',
  ]);
});

test('migrated route predicate requires an exact local-provider physical target pin', () => {
  assert.equal(isLocalPhysicalMobileTarget(android), true);
  assert.equal(isLocalPhysicalMobileTarget({ ...android, kind: 'emulator' }), false);
  assert.equal(isLocalPhysicalMobileTarget(undefined), false);
  assert.equal(
    isLocalPhysicalMobileTarget({
      platform: 'ios',
      providerInstanceId: 'local-core-device',
      routingId: 'synthetic-ios-physical-udid-A',
      kind: 'device',
      transportScope: 'core-device',
    }),
    true,
  );
});

test('normalization rejects malformed and cross-provider facts without echoing raw input', () => {
  const invalid = [
    null,
    {},
    {
      source: 'local-adb',
      platform: 'ios',
      device: { id: 'private-serial', name: 'Phone', kind: 'device' },
    },
    {
      source: 'local-core-device',
      platform: 'ios',
      device: { id: 'private-udid', name: 'Phone', kind: 'simulator' },
    },
    {
      get source() {
        throw new Error('private-marker');
      },
      platform: 'android',
      device: { id: 'private-serial', name: 'Phone', kind: 'device' },
    },
  ];
  for (const fact of invalid) {
    assert.throws(
      () => identityFromLocalFact(fact),
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'Invalid local device fact.' &&
        !/private/.test(error.message),
    );
  }
});
