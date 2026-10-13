import { createAndroidReadonlyProvider } from '../android/readonly-provider.ts';
import type { DeviceIdentity } from '../contracts/device.ts';
import type { EndpointKey } from '../contracts/lifecycle.ts';
import { createIosLocalPhysicalReadOnlyProvider } from '../ios/readonly-provider.ts';
import type { MobileReadonlyProvider } from './readonly.ts';
import { discoverApplications } from '../../setup/applications.ts';
import {
  AndroidExactTransportUnavailableError,
  discoverAndroidReadonlyDeviceFacts,
  queryAndroidPackagesReadOnly,
  type AndroidReadonlyDeviceFact,
} from '../../setup/devices.ts';
import { discoverIosDevices } from '../../setup/ios-devices.ts';
import { inspectAppiumEndpointStatus } from '../../setup-assistant/probes.ts';

function endpointStatus(endpoint: EndpointKey, signal?: AbortSignal) {
  return inspectAppiumEndpointStatus(String(endpoint), signal);
}

async function safeApplicationInspection<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof AndroidExactTransportUnavailableError)
      throw new Error(
        'SELECTED_DEVICE_UNAVAILABLE: the selected phone is unavailable; no other device was used.',
      );
    if (error instanceof Error && error.message.startsWith('SELECTED_DEVICE_UNAVAILABLE:'))
      throw new Error(
        'SELECTED_DEVICE_UNAVAILABLE: the selected phone is unavailable; no other device was used.',
      );
    throw new Error('APPLICATION_INSPECTION_FAILED: installed applications could not be read.');
  }
}

function environment(
  identity: DeviceIdentity,
  endpoint: EndpointKey,
): {
  platform: 'android' | 'ios';
  serverUrl: string;
  device: { kind: 'device'; name?: string };
  capabilities: Record<string, never>;
} {
  return {
    platform: identity.platform,
    serverUrl: String(endpoint),
    device: {
      kind: 'device',
      ...(identity.displayName ? { name: identity.displayName } : {}),
    },
    capabilities: {},
  };
}

export function createProductionAndroidReadonlyProvider(
  discriminatorSecret: Uint8Array,
  discoverInventory: (
    signal?: AbortSignal,
  ) => Promise<readonly AndroidReadonlyDeviceFact[]> = discoverAndroidReadonlyDeviceFacts,
  packages: (
    serial: string,
    signal?: AbortSignal,
  ) => Promise<readonly string[]> = queryAndroidPackagesReadOnly,
): MobileReadonlyProvider {
  const inventoryProvider = createAndroidReadonlyProvider({
    adbDevices: discoverInventory,
    applications: async () => [],
    endpointStatus: async () => ({ state: 'configured' }),
    discriminatorSecret,
  });
  const provider = createAndroidReadonlyProvider({
    adbDevices: discoverInventory,
    applications: (route, signal) =>
      safeApplicationInspection(async () => {
        const ids = await packages(route.identity.routingId, signal);
        signal?.throwIfAborted();
        return ids.map((id) => ({ name: id, id }));
      }, signal),
    endpointStatus,
    discriminatorSecret,
  });
  return Object.freeze({
    inventory: inventoryProvider.inventory,
    preparation: provider.preparation,
    applications: provider.applications,
    endpoint: provider.endpointStatus,
  });
}

export function createProductionIosReadonlyProvider(
  discoverInventory: typeof discoverIosDevices = discoverIosDevices,
  applicationDiscovery: typeof discoverApplications = discoverApplications,
): MobileReadonlyProvider {
  const provider = createIosLocalPhysicalReadOnlyProvider({
    discover: discoverInventory,
    async inspectPreparation(route, signal) {
      signal?.throwIfAborted();
      const matches = (await discoverInventory(signal)).filter(
        (device) => device.id === route.udid && device.kind === 'device',
      );
      signal?.throwIfAborted();
      const device = matches.length === 1 ? matches[0] : undefined;
      return {
        pairing:
          device?.paired === true ? 'paired' : device?.paired === false ? 'unpaired' : 'unknown',
        trust:
          device?.paired === true ? 'trusted' : device?.paired === false ? 'untrusted' : 'unknown',
        developerMode: device?.developerMode ?? 'unknown',
        // Existing setup facts do not prove the selected WDA artifact, signing, or driver.
        artifact: 'unknown',
        signing: 'unknown',
        driver: 'unknown',
      };
    },
    async inspectApplications(route, signal) {
      const identity: DeviceIdentity = {
        platform: 'ios',
        providerInstanceId: 'local-core-device',
        routingId: route.udid,
        kind: 'device',
        transportScope: 'core-device',
      };
      const applications = await safeApplicationInspection(
        () =>
          applicationDiscovery(
            environment(identity, route.endpoint),
            '',
            undefined,
            identity,
            signal,
          ),
        signal,
      );
      signal?.throwIfAborted();
      return applications.map(({ name, id }) => ({
        name,
        id,
        capabilities: { 'appium:bundleId': id },
      }));
    },
    inspectEndpoint: endpointStatus,
  });
  return Object.freeze({
    inventory: provider,
    preparation: provider.preparation,
    applications: provider.applications,
    endpoint: provider.endpoint,
  });
}
