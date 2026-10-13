import { isLocalPhysicalMobileTarget, type MobilePlatform } from './device.ts';
import type { LifecycleTarget, LifecycleTargetKey } from './lifecycle.ts';

export type G3ReadOnlyCapability =
  | 'discovery'
  | 'preparation-facts'
  | 'application-inspection'
  | 'endpoint-status';

export type CapabilityRoute =
  | Readonly<{ kind: 'lifecycle-target'; target: LifecycleTarget }>
  | Readonly<{ kind: 'remote'; platform: MobilePlatform }>
  | Readonly<{ kind: 'host'; platform: 'web' | 'macos' }>;

export type G3ReadOnlyBackendConfiguration = Readonly<
  Record<MobilePlatform, Readonly<Partial<Record<G3ReadOnlyCapability, boolean>>>>
>;

export type ResolvedCapabilityBackend =
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
  if (route.kind === 'host') {
    return Object.freeze({
      capability,
      backend: 'not-applicable',
      routeKind: route.kind,
      platform: route.platform,
    });
  }
  if (route.kind === 'remote') {
    return Object.freeze({
      capability,
      backend: 'legacy',
      routeKind: route.kind,
      platform: route.platform,
    });
  }

  const { identity } = route.target;
  const useG3 =
    isLocalPhysicalMobileTarget(identity) && configuration[identity.platform][capability] === true;
  return Object.freeze({
    capability,
    backend: useG3 ? 'g3' : 'legacy',
    routeKind: route.kind,
    platform: identity.platform,
    target: route.target.key,
  });
}

function routeMatchesResolution(
  route: CapabilityRoute,
  resolution: ResolvedCapabilityBackend,
): boolean {
  if (route.kind !== resolution.routeKind) return false;
  if (route.kind === 'lifecycle-target') {
    if (resolution.routeKind !== 'lifecycle-target') return false;
    return (
      route.target.key === resolution.target &&
      route.target.identity.platform === resolution.platform
    );
  }
  if (resolution.routeKind === 'lifecycle-target') return false;
  return route.platform === resolution.platform;
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
export function dispatchCapabilityBackend<Result>(
  route: CapabilityRoute,
  capability: G3ReadOnlyCapability,
  configuration: G3ReadOnlyBackendConfiguration,
  handlers: CapabilityBackendHandlers<Result>,
  signal?: AbortSignal,
  resolver: typeof resolveCapabilityBackend = resolveCapabilityBackend,
): Promise<Result> {
  const resolution = resolver(route, capability, configuration);
  return dispatchResolvedCapabilityBackend(route, resolution, handlers, signal);
}
