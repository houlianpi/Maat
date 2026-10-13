import type { DeviceIdentity, MobilePlatform, PublicDeviceCandidate } from './device.ts';

declare const discoveryKeyBrand: unique symbol;
declare const targetKeyBrand: unique symbol;
declare const endpointKeyBrand: unique symbol;

/** Process-local keys. Their values are routing-sensitive and must not be disclosed or logged. */
export type DiscoveryKey = string & { readonly [discoveryKeyBrand]: true };
export type LifecycleTargetKey = string & { readonly [targetKeyBrand]: true };
export type EndpointKey = string & { readonly [endpointKeyBrand]: true };

export type CandidateReference = Readonly<{
  discoveryKey: DiscoveryKey;
  candidateNumber: number;
}>;

/** Safe target data for host-facing status or selection observations. */
export type TargetDisclosure = Readonly<{
  platform: MobilePlatform;
  kind: DeviceIdentity['kind'];
  label: string;
  selectedBy: 'single-candidate' | 'explicit-user-selection';
}>;

/**
 * Internal lifecycle pin. Exact identity and endpoint are intentionally available only behind
 * Core's mobile facade; consumers must use `disclosure` for observations.
 */
export type LifecycleTarget = Readonly<{
  key: LifecycleTargetKey;
  identity: DeviceIdentity;
  endpoint: EndpointKey;
  selectedBy: TargetDisclosure['selectedBy'];
  disclosure: TargetDisclosure;
}>;

export type InventoryCandidate = Readonly<{
  identity: DeviceIdentity;
  disclosure: PublicDeviceCandidate;
}>;

export type InventorySnapshot = Readonly<{
  discoveryKey: DiscoveryKey;
  platform: MobilePlatform;
  candidates: readonly InventoryCandidate[];
}>;
