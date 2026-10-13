import type { ApplicationInspectionPort } from '../applications/port.ts';
import type {
  CapabilityRoute,
  G3ReadOnlyBackendConfiguration,
} from '../contracts/backend-selection.ts';
import type { MobilePlatform } from '../contracts/device.ts';
import type { LifecycleTarget } from '../contracts/lifecycle.ts';
import type { DeviceInventoryPort } from '../devices/ports.ts';
import type { EndpointStatusPort, EndpointStatusView } from '../endpoint/port.ts';
import type { MobilePreparationPort, PreparationFactsView } from '../preparation/port.ts';
import type { SetupSnapshot } from '../../setup-assistant/types.ts';

/** Internal-only composition symbols. They are deliberately absent from Core's root exports. */
export const mobileReadonlyFacadeSymbol = Symbol('maat.mobileReadonlyFacade');
export const setupReadonlyCheckSymbol = Symbol('maat.setupReadonlyCheck');
export const setupReadonlyContextSymbol = Symbol('maat.setupReadonlyContext');

export type MobileReadonlyProvider = Readonly<{
  inventory: DeviceInventoryPort;
  preparation: Pick<MobilePreparationPort, 'inspect'>;
  applications: ApplicationInspectionPort;
  endpoint: EndpointStatusPort;
}>;

export type TargetScopedReadonlyFacade = Readonly<{
  platform: MobilePlatform;
  target: LifecycleTarget;
  inspectPreparation(signal?: AbortSignal): Promise<PreparationFactsView>;
  inspectEndpoint(signal?: AbortSignal): Promise<EndpointStatusView>;
}>;

export type MobileReadonlyFacadeHost = {
  [mobileReadonlyFacadeSymbol](): TargetScopedReadonlyFacade | undefined;
};

export type SetupReadonlyContext = Readonly<{
  platform: MobilePlatform;
  target: LifecycleTarget;
  preparation: PreparationFactsView;
  endpoint: EndpointStatusView;
}>;

export type SetupReadonlyRequest = Readonly<{
  facade: TargetScopedReadonlyFacade;
}>;

export type InternalSetupCheckInput = {
  platform?: string;
  serverUrl?: string;
  device?: { kind?: string; name?: string };
  remoteDeviceConfigured?: boolean;
  signal?: AbortSignal;
  [setupReadonlyContextSymbol]?: SetupReadonlyContext | SetupReadonlyRequest;
};

export type SetupReadonlyCheckHost = {
  [setupReadonlyCheckSymbol](
    input: InternalSetupCheckInput,
    facade: TargetScopedReadonlyFacade,
  ): Promise<SetupSnapshot>;
};

export const g3ReadonlyConfiguration: G3ReadOnlyBackendConfiguration = Object.freeze({
  android: Object.freeze({
    discovery: true,
    'preparation-facts': true,
    'application-inspection': true,
    'endpoint-status': true,
  }),
  ios: Object.freeze({
    discovery: true,
    'preparation-facts': true,
    'application-inspection': true,
    'endpoint-status': true,
  }),
});

export function localDiscoveryRoute(platform: MobilePlatform): CapabilityRoute {
  return platform === 'android'
    ? Object.freeze({
        kind: 'local-discovery' as const,
        platform,
        provider: 'local-adb' as const,
      })
    : Object.freeze({
        kind: 'local-discovery' as const,
        platform,
        provider: 'local-core-device' as const,
      });
}
