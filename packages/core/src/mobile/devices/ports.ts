import type { MobilePlatform, PublicDeviceCandidate } from '../contracts/device.ts';
import type {
  CandidateReference,
  EndpointKey,
  InventorySnapshot,
  LifecycleTarget,
} from '../contracts/lifecycle.ts';

/**
 * G2 contract only: there is no production consumer in G2. Read-only discovery and selection are
 * intended for G3 facade integration. Legacy code is retired only after consumers migrate and the
 * G5/G5M/G6/G7 deletion gates and explicit deletion authorization permit it.
 */
export interface DeviceInventoryPort {
  discover(platform: MobilePlatform, signal?: AbortSignal): Promise<InventorySnapshot>;
}

export type TargetSelectionDecision =
  | Readonly<{ status: 'device-not-found'; platform: MobilePlatform }>
  | Readonly<{
      status: 'selection-required';
      platform: MobilePlatform;
      discoveryKey: InventorySnapshot['discoveryKey'];
      candidates: readonly PublicDeviceCandidate[];
    }>
  | Readonly<{ status: 'selection-stale' | 'selection-invalid'; platform: MobilePlatform }>
  | Readonly<{ status: 'selected'; target: LifecycleTarget }>;

export interface DeviceSelectionPort {
  select(
    platform: MobilePlatform,
    endpoint: EndpointKey,
    candidate?: CandidateReference,
    signal?: AbortSignal,
  ): Promise<TargetSelectionDecision>;

  release(target: LifecycleTarget['key'], signal?: AbortSignal): Promise<void>;
}
