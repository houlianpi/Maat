import { isRecord } from '../../core/exploration/protocol.ts';

type MobilePlatform = 'android' | 'ios';

/** Internal routing data, including canonical keys, must not enter public results or logs. */
export type DeviceIdentity = {
  platform: MobilePlatform;
  providerInstanceId: string;
  routingId: string;
  kind: 'device' | 'emulator' | 'simulator';
  transportScope: 'local-adb' | 'core-device';
  displayName?: string;
};

export type DeviceBinding = {
  version: 1;
  identity: DeviceIdentity;
  endpointId: string;
  displayNameAtBinding?: string;
};

export type DeviceBindingParseResult =
  | { status: 'valid'; binding: DeviceBinding }
  | { status: 'invalid-format' | 'unsupported-version'; message: string };

export type DeviceSelection =
  | { status: 'device-not-found' }
  | {
      status: 'preselected';
      candidate: DeviceIdentity;
      reason: 'initial-selection' | 'legacy-migration';
    }
  | { status: 'selection-required'; candidates: readonly DeviceIdentity[] }
  | { status: 'legacy-selection-required'; candidates: readonly DeviceIdentity[] }
  | { status: 'reuse' | 'configured-device-unavailable'; binding: DeviceBinding }
  | { status: 'invalid-binding'; reason: 'invalid-format' | 'unsupported-version' };

function nonemptyText(value: unknown): value is string {
  // Validation only: accepted strings are never trimmed or otherwise normalized.
  return typeof value === 'string' && value.trim().length > 0;
}

function fields(
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

function readIdentity(value: unknown): DeviceIdentity | undefined {
  try {
    if (
      !isRecord(value) ||
      !fields(
        value,
        ['platform', 'providerInstanceId', 'routingId', 'kind', 'transportScope'],
        ['displayName'],
      )
    )
      return;
    const hasDisplayName = Object.hasOwn(value, 'displayName');
    const { platform, providerInstanceId, routingId, kind, transportScope } = value;
    const displayName = hasDisplayName ? value.displayName : undefined;
    if (
      (platform !== 'android' && platform !== 'ios') ||
      !nonemptyText(providerInstanceId) ||
      !nonemptyText(routingId) ||
      (kind !== 'device' && kind !== 'emulator' && kind !== 'simulator') ||
      (transportScope !== 'local-adb' && transportScope !== 'core-device') ||
      (hasDisplayName && !nonemptyText(displayName))
    )
      return;
    if (
      platform === 'android'
        ? providerInstanceId !== 'local-adb' ||
          transportScope !== 'local-adb' ||
          kind === 'simulator'
        : providerInstanceId !== 'local-core-device' ||
          transportScope !== 'core-device' ||
          kind === 'emulator'
    )
      return;
    return {
      platform,
      providerInstanceId,
      routingId,
      kind,
      transportScope,
      ...(typeof displayName === 'string' ? { displayName } : {}),
    };
  } catch {
    // Accessors/proxies at an unknown boundary must not leak their errors or input.
    return;
  }
}

/**
 * Normalize parsed discovery facts, not raw CoreDevice JSON:
 * { source: 'local-adb', platform: 'android', device: Device } or
 * { source: 'local-core-device', platform: 'ios', device: IosDevice }.
 * IosDevice.id is the physical UDID supplied by parseIosDeviceList, not its identifier.
 * Connection/pairing/readiness facts do not become identity fields. No discovery I/O.
 */
export function identityFromLocalFact(fact: unknown): DeviceIdentity {
  try {
    if (!isRecord(fact) || !fields(fact, ['source', 'platform', 'device'])) throw new Error();
    const { source, platform, device } = fact;
    if (
      !isRecord(device) ||
      (source !== 'local-adb' && source !== 'local-core-device') ||
      (source === 'local-adb' ? platform !== 'android' : platform !== 'ios')
    )
      throw new Error();
    // Unknown facts can have accessors: validate and construct from the same field snapshot.
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
    const identity = readIdentity({
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

/** Sensitive, reversible encoding; neither a display ID nor a privacy hash. */
export function canonicalDeviceKey(identity: DeviceIdentity): string {
  return JSON.stringify([
    1,
    identity.platform,
    identity.providerInstanceId,
    identity.routingId,
    identity.kind,
  ]);
}

/** Parse an already-decoded private value. Invalid state is never treated as absent state. */
export function parseDeviceBinding(value: unknown): DeviceBindingParseResult {
  const invalid: DeviceBindingParseResult = {
    status: 'invalid-format',
    message: 'Invalid device binding format.',
  };
  try {
    if (!isRecord(value) || !Object.hasOwn(value, 'version')) return invalid;
    const version = value.version;
    if (typeof version !== 'number' || !Number.isInteger(version)) return invalid;
    if (version !== 1)
      return { status: 'unsupported-version', message: 'Unsupported device binding version.' };
    if (!fields(value, ['version', 'identity', 'endpointId'], ['displayNameAtBinding']))
      return invalid;
    const hasDisplayNameAtBinding = Object.hasOwn(value, 'displayNameAtBinding');
    const { identity: identityValue, endpointId } = value;
    const displayNameAtBinding = hasDisplayNameAtBinding ? value.displayNameAtBinding : undefined;
    if (
      !nonemptyText(endpointId) ||
      (hasDisplayNameAtBinding && !nonemptyText(displayNameAtBinding))
    )
      return invalid;
    const identity = readIdentity(identityValue);
    if (!identity) return invalid;
    return {
      status: 'valid',
      binding: {
        version: 1,
        identity,
        endpointId,
        ...(typeof displayNameAtBinding === 'string' ? { displayNameAtBinding } : {}),
      },
    };
  } catch {
    return invalid;
  }
}

/**
 * Candidates are the current eligible inventory, not a readiness proof.
 * An explicitly supplied invalid binding/hints value cannot be silently discarded.
 * No selection result writes state, creates a Session, or permits rebind.
 */
export function planDeviceSelection(input: {
  candidates: readonly DeviceIdentity[];
  binding?: unknown;
  legacyHints?: unknown;
}): DeviceSelection {
  let binding: DeviceBinding | undefined;
  if (Object.hasOwn(input, 'binding')) {
    const parsed = parseDeviceBinding(input.binding);
    if (parsed.status !== 'valid') return { status: 'invalid-binding', reason: parsed.status };
    binding = parsed.binding;
  }
  const candidates = input.candidates.map((candidate) => {
    const identity = readIdentity(candidate);
    if (!identity) throw new Error('Invalid device candidates.');
    return identity;
  });
  if (binding)
    return {
      status: candidates.some((candidate) => sameDeviceIdentity(candidate, binding.identity))
        ? 'reuse'
        : 'configured-device-unavailable',
      binding,
    };
  if (Object.hasOwn(input, 'legacyHints')) {
    let matches: DeviceIdentity[] = [];
    try {
      const hints = input.legacyHints;
      if (isRecord(hints) && fields(hints, ['kind', 'name'])) {
        const { kind, name } = hints;
        if (
          (kind === 'device' || kind === 'emulator' || kind === 'simulator') &&
          nonemptyText(name)
        )
          matches = candidates.filter(
            (candidate) => candidate.kind === kind && candidate.displayName === name,
          );
      }
    } catch {
      // Malformed legacy state needs explicit selection, never guessed recovery.
    }
    return matches.length === 1
      ? { status: 'preselected', candidate: matches[0]!, reason: 'legacy-migration' }
      : { status: 'legacy-selection-required', candidates };
  }
  if (!candidates.length) return { status: 'device-not-found' };
  return candidates.length === 1
    ? { status: 'preselected', candidate: candidates[0]!, reason: 'initial-selection' }
    : { status: 'selection-required', candidates };
}

/**
 * Construct an in-memory initial/migration value from an explicit confirmation fact.
 * This is not user-authorization verification, persistence, or coordinator rebind exclusion.
 * endpointId is opaque; resolving it and preventing remapping belong to endpoint policy.
 */
export function confirmInitialBinding(
  proposal: DeviceSelection,
  selectedIdentity: DeviceIdentity,
  endpointId: unknown,
  confirmed: unknown,
): DeviceBinding | undefined {
  if (confirmed !== true) return;
  const { status } = proposal;
  if (status !== 'preselected' && status !== 'selection-required')
    throw new Error('Device selection cannot be confirmed.');
  if (!nonemptyText(endpointId)) throw new Error('Invalid binding endpoint ID.');
  const selected = readIdentity(selectedIdentity);
  const candidates = status === 'preselected' ? [proposal.candidate] : proposal.candidates;
  const identity = candidates
    .map(readIdentity)
    .find((item) => item && selected && sameDeviceIdentity(item, selected));
  if (!identity) throw new Error('Selected device is not in the proposal.');
  return {
    version: 1,
    identity,
    endpointId,
    ...(identity.displayName !== undefined ? { displayNameAtBinding: identity.displayName } : {}),
  };
}
