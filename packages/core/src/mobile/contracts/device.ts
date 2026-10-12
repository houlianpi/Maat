import { isRecord } from '../../core/exploration/protocol.ts';

export type MobilePlatform = 'android' | 'ios';

/** Internal routing data. Never include this object or its canonical key in public results/logs. */
export type DeviceIdentity = {
  platform: MobilePlatform;
  providerInstanceId: 'local-adb' | 'local-core-device';
  routingId: string;
  kind: 'device' | 'emulator' | 'simulator';
  transportScope: 'local-adb' | 'core-device';
  displayName?: string;
};

export type TargetSelectionInput = {
  discoveryId: string;
  candidateNumber: number;
};

export type PublicDeviceCandidate = {
  candidateNumber: number;
  displayName: string;
  platform: MobilePlatform;
  kind: DeviceIdentity['kind'];
  /** Process-local, non-routing label for distinguishing equal display names. */
  discriminator: string;
};

export type TargetSelectionResult =
  | { status: 'device-not-found'; platform: MobilePlatform }
  | {
      status: 'selection-required';
      platform: MobilePlatform;
      discoveryId: string;
      candidates: readonly PublicDeviceCandidate[];
    }
  | { status: 'selection-stale' | 'selection-invalid'; platform: MobilePlatform }
  | {
      status: 'target-selected';
      platform: MobilePlatform;
      selectedBy: 'single-candidate' | 'explicit-user-selection';
      candidate: PublicDeviceCandidate;
    }
  | {
      status: 'selected';
      platform: MobilePlatform;
      selectedBy: 'single-candidate' | 'explicit-user-selection';
      candidate: PublicDeviceCandidate;
    };

/** A user-requested close did not prove that the owned phone Session was released. */
export class PhoneCloseUncertainError extends Error {
  readonly code = 'phone-close-uncertain';

  constructor() {
    super(
      'PHONE_CLOSE_UNCERTAIN: the previous phone Session release did not complete reliably; this target is blocked and no new phone operation was started.',
    );
    this.name = 'PhoneCloseUncertainError';
  }
}

function nonemptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && (required.includes(key) || optional.includes(key)),
    )
  );
}

function validatedIdentity(value: unknown): DeviceIdentity | undefined {
  try {
    if (
      !isRecord(value) ||
      !exactFields(
        value,
        ['platform', 'providerInstanceId', 'routingId', 'kind', 'transportScope'],
        ['displayName'],
      )
    )
      return;
    const { platform, providerInstanceId, routingId, kind, transportScope } = value;
    const displayName = Object.hasOwn(value, 'displayName') ? value.displayName : undefined;
    if (
      (platform !== 'android' && platform !== 'ios') ||
      !nonemptyText(routingId) ||
      (kind !== 'device' && kind !== 'emulator' && kind !== 'simulator') ||
      (displayName !== undefined && !nonemptyText(displayName))
    )
      return;
    if (
      platform === 'android'
        ? providerInstanceId !== 'local-adb' ||
          transportScope !== 'local-adb' ||
          kind === 'simulator'
        : providerInstanceId !== 'local-core-device' ||
          transportScope !== 'core-device' ||
          kind !== 'device'
    )
      return;
    return {
      platform,
      providerInstanceId:
        platform === 'android' ? ('local-adb' as const) : ('local-core-device' as const),
      routingId,
      kind,
      transportScope: platform === 'android' ? ('local-adb' as const) : ('core-device' as const),
      ...(typeof displayName === 'string' ? { displayName } : {}),
    };
  } catch {
    return;
  }
}

/**
 * Normalize parsed local discovery facts, not raw ADB/CoreDevice payloads.
 * IosDevice.id is the physical UDID produced by parseIosDeviceList.
 */
export function identityFromLocalFact(fact: unknown): DeviceIdentity {
  try {
    if (!isRecord(fact) || !exactFields(fact, ['source', 'platform', 'device'])) throw new Error();
    const { source, platform, device } = fact;
    if (
      !isRecord(device) ||
      (source !== 'local-adb' && source !== 'local-core-device') ||
      (source === 'local-adb' ? platform !== 'android' : platform !== 'ios')
    )
      throw new Error();
    const { id, name, kind } = device;
    if (!nonemptyText(id) || !nonemptyText(name)) throw new Error();
    if (source === 'local-core-device') {
      const { connected, developerMode } = device;
      const paired = Object.hasOwn(device, 'paired') ? device.paired : undefined;
      if (
        kind !== 'device' ||
        typeof connected !== 'boolean' ||
        (paired !== undefined && typeof paired !== 'boolean') ||
        (developerMode !== 'enabled' && developerMode !== 'disabled' && developerMode !== 'unknown')
      )
        throw new Error();
    }
    const identity = validatedIdentity({
      platform,
      providerInstanceId: source,
      routingId: id,
      kind,
      transportScope: source === 'local-adb' ? 'local-adb' : 'core-device',
      displayName: name,
    });
    if (!identity) throw new Error();
    return identity;
  } catch {
    throw new Error('Invalid local device fact.');
  }
}

export function sameDeviceIdentity(left: DeviceIdentity, right: DeviceIdentity): boolean {
  return (
    left.platform === right.platform &&
    left.providerInstanceId === right.providerInstanceId &&
    left.routingId === right.routingId &&
    left.kind === right.kind
  );
}

/** Sensitive, reversible encoding for internal exact routing only. */
export function canonicalDeviceKey(identity: DeviceIdentity): string {
  return JSON.stringify([
    1,
    identity.platform,
    identity.providerInstanceId,
    identity.routingId,
    identity.kind,
  ]);
}
