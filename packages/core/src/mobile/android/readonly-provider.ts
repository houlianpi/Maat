import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { createApplicationFact, type ApplicationInspectionPort } from '../applications/port.ts';
import type { DeviceIdentity, MobilePlatform } from '../contracts/device.ts';
import { isLocalPhysicalMobileTarget } from '../contracts/device.ts';
import type {
  DiscoveryKey,
  EndpointKey,
  InventorySnapshot,
  LifecycleTarget,
} from '../contracts/lifecycle.ts';
import type { DeviceInventoryPort } from '../devices/ports.ts';
import { createEndpointStatusView, type EndpointStatusPort } from '../endpoint/port.ts';
import type {
  MobilePreparationPort,
  PreparationFactsKey,
  PreparationFactsView,
} from '../preparation/port.ts';

export type AndroidAdbDeviceFact = Readonly<{
  routingId: string;
  kind: 'device' | 'emulator';
  status: 'online' | 'unauthorized' | 'offline' | 'unknown';
  model?: string;
}>;

export type AndroidLocalPhysicalRoute = Readonly<{
  identity: DeviceIdentity;
  endpoint: EndpointKey;
}>;

/**
 * All dependencies are read-only probes. Implementations must query an already-running ADB daemon
 * or the already-pinned endpoint; they must not start services, create Sessions, or prepare a
 * device. The exact identity and endpoint arguments are routing-sensitive and must not be logged.
 */
export type AndroidReadonlyProviderDependencies = Readonly<{
  adbDevices(signal?: AbortSignal): Promise<readonly AndroidAdbDeviceFact[]>;
  applications(route: AndroidLocalPhysicalRoute, signal?: AbortSignal): Promise<readonly unknown[]>;
  endpointStatus(endpoint: EndpointKey, signal?: AbortSignal): Promise<unknown>;
  now?: () => Date;
  randomId?: () => string;
  discriminatorSecret?: Uint8Array;
}>;

export type AndroidReadonlyProvider = Readonly<{
  inventory: DeviceInventoryPort;
  preparation: Pick<MobilePreparationPort, 'inspect'>;
  applications: ApplicationInspectionPort;
  endpointStatus: EndpointStatusPort;
}>;

const policyVersion = 'android-readonly-v1';

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateFact(value: AndroidAdbDeviceFact): AndroidAdbDeviceFact {
  if (
    !value ||
    typeof value !== 'object' ||
    !nonempty(value.routingId) ||
    (value.kind !== 'device' && value.kind !== 'emulator') ||
    !['online', 'unauthorized', 'offline', 'unknown'].includes(value.status) ||
    (value.model !== undefined && !nonempty(value.model))
  )
    throw new Error('Invalid Android ADB device fact.');
  return value;
}

function assertAndroidTarget(target: LifecycleTarget): void {
  if (!isLocalPhysicalMobileTarget(target.identity) || target.identity.platform !== 'android')
    throw new Error('Android read-only inspection requires a local physical Android target.');
}

function exactRoute(target: LifecycleTarget): AndroidLocalPhysicalRoute {
  assertAndroidTarget(target);
  return Object.freeze({ identity: target.identity, endpoint: target.endpoint });
}

function applicationMetadata(value: unknown): { name: string; id: string } {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).some(
      (key) => typeof key !== 'string' || (key !== 'name' && key !== 'id'),
    ) ||
    !Object.hasOwn(value, 'name') ||
    !Object.hasOwn(value, 'id')
  )
    throw new Error('Invalid Android application metadata.');
  const { name, id } = value as Record<string, unknown>;
  if (!nonempty(name) || !nonempty(id)) throw new Error('Invalid Android application metadata.');
  return { name, id };
}

export function createAndroidReadonlyProvider(
  dependencies: AndroidReadonlyProviderDependencies,
): AndroidReadonlyProvider {
  const randomId = dependencies.randomId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());
  const secret = Buffer.from(dependencies.discriminatorSecret ?? randomBytes(32));

  const readFacts = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const facts = await dependencies.adbDevices(signal);
    signal?.throwIfAborted();
    return facts.map(validateFact);
  };

  const inventory: DeviceInventoryPort = Object.freeze({
    async discover(platform: MobilePlatform, signal?: AbortSignal): Promise<InventorySnapshot> {
      if (platform !== 'android')
        throw new Error('Android read-only discovery supports only Android.');
      const facts = await readFacts(signal);
      const candidates = facts
        .filter((fact) => fact.kind === 'device' && fact.status === 'online')
        .map((fact, index) => {
          const identity: DeviceIdentity = Object.freeze({
            platform: 'android',
            providerInstanceId: 'local-adb',
            routingId: fact.routingId,
            kind: 'device',
            transportScope: 'local-adb',
            displayName: fact.model ?? 'Android device',
          });
          return Object.freeze({
            identity,
            disclosure: Object.freeze({
              candidateNumber: index + 1,
              displayName: identity.displayName!,
              platform: 'android' as const,
              kind: 'device' as const,
              discriminator: `device-${createHmac('sha256', secret)
                .update(fact.routingId)
                .digest('hex')
                .slice(0, 8)}`,
            }),
          });
        });
      return Object.freeze({
        discoveryKey: randomId() as DiscoveryKey,
        platform: 'android' as const,
        candidates: Object.freeze(candidates),
      });
    },
  });

  const preparation: Pick<MobilePreparationPort, 'inspect'> = Object.freeze({
    async inspect(target: LifecycleTarget, signal?: AbortSignal): Promise<PreparationFactsView> {
      assertAndroidTarget(target);
      const matches = (await readFacts(signal)).filter(
        (fact) => fact.kind === 'device' && fact.routingId === target.identity.routingId,
      );
      const status = matches.length === 1 ? matches[0]!.status : 'unknown';
      const blockerCategories =
        status === 'online'
          ? []
          : [
              status === 'unauthorized'
                ? 'android-device-unauthorized'
                : status === 'offline'
                  ? 'android-device-offline'
                  : 'android-device-state-unknown',
            ];
      return Object.freeze({
        key: randomId() as PreparationFactsKey,
        platform: 'android' as const,
        capturedAt: now().toISOString(),
        policyVersion,
        compatibility: status === 'online' ? ('compatible' as const) : ('unknown' as const),
        blockerCategories: Object.freeze(blockerCategories),
      });
    },
  });

  const applications: ApplicationInspectionPort = Object.freeze({
    async inspect(target: LifecycleTarget, query: string, signal?: AbortSignal) {
      const route = exactRoute(target);
      signal?.throwIfAborted();
      const values = await dependencies.applications(route, signal);
      signal?.throwIfAborted();
      const normalizedQuery = query.toLowerCase();
      return Object.freeze(
        values
          .map(applicationMetadata)
          .filter(({ name, id }) => `${name} ${id}`.toLowerCase().includes(normalizedQuery))
          .map(({ name, id }) =>
            createApplicationFact(target, {
              name,
              id,
              capabilities: { 'appium:appPackage': id },
            }),
          ),
      );
    },
  });

  const endpointStatus: EndpointStatusPort = Object.freeze({
    async inspect(target: LifecycleTarget, signal?: AbortSignal) {
      assertAndroidTarget(target);
      signal?.throwIfAborted();
      const value = await dependencies.endpointStatus(target.endpoint, signal);
      signal?.throwIfAborted();
      return createEndpointStatusView(value);
    },
  });

  return Object.freeze({ inventory, preparation, applications, endpointStatus });
}
