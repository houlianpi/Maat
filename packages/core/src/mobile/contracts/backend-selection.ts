import { isLocalPhysicalMobileTarget, type MobilePlatform } from './device.ts';
import type { LifecycleTarget, LifecycleTargetKey } from './lifecycle.ts';

export type G3ReadOnlyCapability =
  | 'discovery'
  | 'preparation-facts'
  | 'application-inspection'
  | 'endpoint-status';

export type CapabilityRoute =
  | Readonly<{ kind: 'local-discovery'; platform: 'android'; provider: 'local-adb' }>
  | Readonly<{ kind: 'local-discovery'; platform: 'ios'; provider: 'local-core-device' }>
  | Readonly<{ kind: 'lifecycle-target'; target: LifecycleTarget }>
  | Readonly<{ kind: 'remote'; platform: MobilePlatform }>
  | Readonly<{ kind: 'host'; platform: 'web' | 'macos' }>;

export type G3ReadOnlyBackendConfiguration = Readonly<
  Record<MobilePlatform, Readonly<Partial<Record<G3ReadOnlyCapability, boolean>>>>
>;

export type ResolvedCapabilityBackend =
  | Readonly<{
      capability: 'discovery';
      backend: 'g3' | 'legacy';
      routeKind: 'local-discovery';
      platform: MobilePlatform;
      provider: 'local-adb' | 'local-core-device';
    }>
  | Readonly<{
      capability: G3ReadOnlyCapability;
      backend: 'g3' | 'legacy';
      routeKind: 'lifecycle-target';
      platform: MobilePlatform;
      target: LifecycleTargetKey;
    }>
  | Readonly<{
      capability: G3ReadOnlyCapability;
      backend: 'legacy';
      routeKind: 'remote';
      platform: MobilePlatform;
    }>
  | Readonly<{
      capability: G3ReadOnlyCapability;
      backend: 'not-applicable';
      routeKind: 'host';
      platform: 'web' | 'macos';
    }>;

export type CapabilityBackendHandlers<Result> = Readonly<{
  g3(signal?: AbortSignal): Promise<Result>;
  legacy(signal?: AbortSignal): Promise<Result>;
  notApplicable(signal?: AbortSignal): Promise<Result>;
}>;

type LocalDiscoverySnapshot =
  | Readonly<{ kind: 'local-discovery'; platform: 'android'; provider: 'local-adb' }>
  | Readonly<{
      kind: 'local-discovery';
      platform: 'ios';
      provider: 'local-core-device';
    }>;

function isEnumerableDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return (
    descriptor !== undefined && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value')
  );
}

/**
 * Snapshot an untrusted pre-target route without invoking accessors or rereading validated fields.
 * Null means another route kind with a safe own kind data descriptor.
 */
function parseLocalDiscoveryRoute(value: unknown): LocalDiscoverySnapshot | null {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid capability route.');
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const kind = descriptors.kind;
  if (!isEnumerableDataDescriptor(kind)) throw new Error('Invalid capability route.');
  if (kind.value !== 'local-discovery') return null;

  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('Invalid local discovery route.');
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== 3 ||
    !['kind', 'platform', 'provider'].every((key) => ownKeys.includes(key))
  )
    throw new Error('Invalid local discovery route.');
  const platform = descriptors.platform;
  const provider = descriptors.provider;
  if (!isEnumerableDataDescriptor(platform) || !isEnumerableDataDescriptor(provider))
    throw new Error('Invalid local discovery route.');

  const platformValue = platform.value;
  const providerValue = provider.value;
  if (platformValue === 'android' && providerValue === 'local-adb') {
    return Object.freeze({
      kind: 'local-discovery',
      platform: 'android',
      provider: 'local-adb',
    });
  }
  if (platformValue === 'ios' && providerValue === 'local-core-device') {
    return Object.freeze({
      kind: 'local-discovery',
      platform: 'ios',
      provider: 'local-core-device',
    });
  }
  throw new Error('Invalid local discovery route.');
}

/**
 * Resolve exactly one backend before an operation starts.
 *
 * The immutable result intentionally contains no callback, alternate backend, queue or retry
 * policy. A selected backend's Abort or failure must be propagated by the caller, never resolved
 * again as an implicit fallback for the same operation.
 */
export function resolveCapabilityBackend(
  route: CapabilityRoute,
  capability: G3ReadOnlyCapability,
  configuration: G3ReadOnlyBackendConfiguration,
): ResolvedCapabilityBackend {
  const localDiscovery = parseLocalDiscoveryRoute(route);
  if (localDiscovery) {
    if (capability !== 'discovery')
      throw new Error('Local discovery routes only support the discovery capability.');
    return Object.freeze({
      capability,
      backend: configuration[localDiscovery.platform].discovery === true ? 'g3' : 'legacy',
      routeKind: localDiscovery.kind,
      platform: localDiscovery.platform,
      provider: localDiscovery.provider,
    });
  }

  const nonLocalRoute = route as Exclude<CapabilityRoute, { kind: 'local-discovery' }>;
  if (nonLocalRoute.kind === 'host') {
    return Object.freeze({
      capability,
      backend: 'not-applicable',
      routeKind: nonLocalRoute.kind,
      platform: nonLocalRoute.platform,
    });
  }
  if (nonLocalRoute.kind === 'remote') {
    return Object.freeze({
      capability,
      backend: 'legacy',
      routeKind: nonLocalRoute.kind,
      platform: nonLocalRoute.platform,
    });
  }

  const { identity } = nonLocalRoute.target;
  const useG3 =
    isLocalPhysicalMobileTarget(identity) && configuration[identity.platform][capability] === true;
  return Object.freeze({
    capability,
    backend: useG3 ? 'g3' : 'legacy',
    routeKind: nonLocalRoute.kind,
    platform: identity.platform,
    target: nonLocalRoute.target.key,
  });
}

function routeMatchesResolution(
  route: CapabilityRoute,
  resolution: ResolvedCapabilityBackend,
): boolean {
  const localDiscovery = parseLocalDiscoveryRoute(route);
  if (localDiscovery) {
    return (
      resolution.routeKind === 'local-discovery' &&
      localDiscovery.platform === resolution.platform &&
      localDiscovery.provider === resolution.provider
    );
  }

  const nonLocalRoute = route as Exclude<CapabilityRoute, { kind: 'local-discovery' }>;
  if (nonLocalRoute.kind !== resolution.routeKind) return false;
  if (nonLocalRoute.kind === 'lifecycle-target') {
    if (resolution.routeKind !== 'lifecycle-target') return false;
    return (
      nonLocalRoute.target.key === resolution.target &&
      nonLocalRoute.target.identity.platform === resolution.platform
    );
  }
  if (resolution.routeKind === 'lifecycle-target') return false;
  return nonLocalRoute.platform === resolution.platform;
}

/**
 * Dispatch a previously resolved backend once after verifying its route/target correlation.
 * Rejection and Abort reasons propagate unchanged; no alternate handler is invoked.
 */
export async function dispatchResolvedCapabilityBackend<Result>(
  route: CapabilityRoute,
  resolution: ResolvedCapabilityBackend,
  handlers: CapabilityBackendHandlers<Result>,
  signal?: AbortSignal,
): Promise<Result> {
  if (!routeMatchesResolution(route, resolution))
    throw new Error('Capability backend resolution does not match the operation target.');

  switch (resolution.backend) {
    case 'g3':
      return await handlers.g3(signal);
    case 'legacy':
      return await handlers.legacy(signal);
    case 'not-applicable':
      return await handlers.notApplicable(signal);
  }
}

/** Resolve at operation start and invoke only the selected backend for that operation. */
export async function dispatchCapabilityBackend<Result>(
  route: CapabilityRoute,
  capability: G3ReadOnlyCapability,
  configuration: G3ReadOnlyBackendConfiguration,
  handlers: CapabilityBackendHandlers<Result>,
  signal?: AbortSignal,
  resolver: typeof resolveCapabilityBackend = resolveCapabilityBackend,
): Promise<Result> {
  const resolution = resolver(route, capability, configuration);
  return await dispatchResolvedCapabilityBackend(route, resolution, handlers, signal);
}
