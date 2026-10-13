import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import {
  createApplicationFact,
  type ApplicationFact,
  type ApplicationInspectionPort,
} from '../applications/port.ts';
import {
  canonicalDeviceKey,
  identityFromLocalFact,
  isLocalPhysicalMobileTarget,
  type MobilePlatform,
} from '../contracts/device.ts';
import type {
  DiscoveryKey,
  EndpointKey,
  InventoryCandidate,
  InventorySnapshot,
  LifecycleTarget,
} from '../contracts/lifecycle.ts';
import type { DeviceInventoryPort } from '../devices/ports.ts';
import {
  createEndpointStatusView,
  type EndpointStatusPort,
  type EndpointStatusView,
} from '../endpoint/port.ts';
import type {
  MobilePreparationPort,
  PreparationFactsKey,
  PreparationFactsView,
} from '../preparation/port.ts';
import { discoverIosDevices, type IosDevice } from '../../setup/ios-devices.ts';

export type IosLocalPhysicalRoute = Readonly<{
  udid: string;
  endpoint: EndpointKey;
}>;

export type IosPreparationProbeFacts = Readonly<{
  pairing: 'paired' | 'unpaired' | 'unknown';
  trust: 'trusted' | 'untrusted' | 'unknown';
  developerMode: 'enabled' | 'disabled' | 'unknown';
  artifact: 'compatible' | 'incompatible' | 'unknown';
  signing: 'compatible' | 'incompatible' | 'unknown';
  driver: 'compatible' | 'incompatible' | 'unknown';
}>;

export type IosReadOnlyProviderDependencies = Readonly<{
  discover(signal?: AbortSignal): Promise<readonly IosDevice[]>;
  inspectPreparation(route: IosLocalPhysicalRoute, signal?: AbortSignal): Promise<unknown>;
  inspectApplications(
    route: IosLocalPhysicalRoute,
    signal?: AbortSignal,
  ): Promise<readonly unknown[]>;
  inspectEndpoint(endpoint: EndpointKey, signal?: AbortSignal): Promise<unknown>;
  now?(): Date;
}>;

const policyVersion = 'g3-ios-readonly-v1';
const preparationFactKeys = [
  'pairing',
  'trust',
  'developerMode',
  'artifact',
  'signing',
  'driver',
] as const;
const invalidPreparationFactsMessage =
  'IOS_PREPARATION_FACTS_INVALID: read-only preparation probe returned invalid facts.';

function invalidPreparationFacts(): Error {
  return new Error(invalidPreparationFactsMessage);
}

/**
 * Copy untrusted probe output into a fresh immutable fact object without invoking accessors.
 * Descriptor values are read once; malformed objects fail with a stable, non-reflective error.
 */
export function createIosPreparationProbeFacts(value: unknown): IosPreparationProbeFacts {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw invalidPreparationFacts();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidPreparationFacts();

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== preparationFactKeys.length ||
      ownKeys.some(
        (key) =>
          typeof key !== 'string' || !(preparationFactKeys as readonly string[]).includes(key),
      )
    )
      throw invalidPreparationFacts();

    const read = (key: (typeof preparationFactKeys)[number]): unknown => {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        throw invalidPreparationFacts();
      return descriptor.value;
    };
    const pairing = read('pairing');
    const trust = read('trust');
    const developerMode = read('developerMode');
    const artifact = read('artifact');
    const signing = read('signing');
    const driver = read('driver');
    if (
      (pairing !== 'paired' && pairing !== 'unpaired' && pairing !== 'unknown') ||
      (trust !== 'trusted' && trust !== 'untrusted' && trust !== 'unknown') ||
      (developerMode !== 'enabled' &&
        developerMode !== 'disabled' &&
        developerMode !== 'unknown') ||
      (artifact !== 'compatible' && artifact !== 'incompatible' && artifact !== 'unknown') ||
      (signing !== 'compatible' && signing !== 'incompatible' && signing !== 'unknown') ||
      (driver !== 'compatible' && driver !== 'incompatible' && driver !== 'unknown')
    )
      throw invalidPreparationFacts();
    return Object.freeze({ pairing, trust, developerMode, artifact, signing, driver });
  } catch {
    throw invalidPreparationFacts();
  }
}

function localIosRoute(target: LifecycleTarget): IosLocalPhysicalRoute {
  if (
    !isLocalPhysicalMobileTarget(target.identity) ||
    target.identity.platform !== 'ios' ||
    target.identity.providerInstanceId !== 'local-core-device' ||
    target.identity.transportScope !== 'core-device'
  )
    throw new Error('IOS_G3_TARGET_UNSUPPORTED: expected a local physical CoreDevice target.');
  return Object.freeze({ udid: target.identity.routingId, endpoint: target.endpoint });
}

function preparationSummary(facts: IosPreparationProbeFacts): Readonly<{
  compatibility: PreparationFactsView['compatibility'];
  blockerCategories: readonly string[];
}> {
  const blockers: string[] = [];
  const add = (condition: boolean, category: string) => {
    if (condition) blockers.push(category);
  };

  add(facts.pairing === 'unpaired', 'pairing-required');
  add(facts.pairing === 'unknown', 'pairing-unknown');
  add(facts.trust === 'untrusted', 'trust-required');
  add(facts.trust === 'unknown', 'trust-unknown');
  add(facts.developerMode === 'disabled', 'developer-mode-required');
  add(facts.developerMode === 'unknown', 'developer-mode-unknown');
  add(facts.artifact === 'incompatible', 'artifact-incompatible');
  add(facts.artifact === 'unknown', 'artifact-compatibility-unknown');
  add(facts.signing === 'incompatible', 'signing-required');
  add(facts.signing === 'unknown', 'signing-compatibility-unknown');
  add(facts.driver === 'incompatible', 'driver-incompatible');
  add(facts.driver === 'unknown', 'driver-compatibility-unknown');

  const values: readonly string[] = Object.values(facts);
  const compatibility =
    values.includes('unpaired') ||
    values.includes('untrusted') ||
    values.includes('disabled') ||
    values.includes('incompatible')
      ? 'incompatible'
      : values.includes('unknown')
        ? 'unknown'
        : 'compatible';
  return Object.freeze({
    compatibility,
    blockerCategories: Object.freeze(blockers),
  });
}

/**
 * Internal G3 iOS read-only provider. It owns no Session, job, queue, persisted selection, or
 * preparation action. Every platform interaction is delegated exactly once to an injected
 * read-only probe.
 */
export class IosLocalPhysicalReadOnlyProvider implements DeviceInventoryPort {
  readonly #dependencies: IosReadOnlyProviderDependencies;
  readonly #disclosureSecret = randomBytes(32);
  readonly preparation: Pick<MobilePreparationPort, 'inspect'>;
  readonly applications: ApplicationInspectionPort;
  readonly endpoint: EndpointStatusPort;

  constructor(dependencies: IosReadOnlyProviderDependencies) {
    this.#dependencies = dependencies;
    this.preparation = Object.freeze({
      inspect: (target: LifecycleTarget, signal?: AbortSignal) =>
        this.#inspectPreparation(target, signal),
    });
    this.applications = Object.freeze({
      inspect: (target: LifecycleTarget, query: string, signal?: AbortSignal) =>
        this.#inspectApplications(target, query, signal),
    });
    this.endpoint = Object.freeze({
      inspect: (target: LifecycleTarget, signal?: AbortSignal) =>
        this.#inspectEndpoint(target, signal),
    });
  }

  async discover(platform: MobilePlatform, signal?: AbortSignal): Promise<InventorySnapshot> {
    if (platform !== 'ios')
      throw new Error('IOS_G3_PLATFORM_UNSUPPORTED: the iOS provider only discovers iOS devices.');
    signal?.throwIfAborted();
    const devices = await this.#dependencies.discover(signal);
    signal?.throwIfAborted();

    const candidates: InventoryCandidate[] = devices
      .filter((device) => device.kind === 'device' && device.connected)
      .map((device, index) => {
        const identity = identityFromLocalFact({
          source: 'local-core-device',
          platform: 'ios',
          device,
        });
        return Object.freeze({
          identity: Object.freeze(identity),
          disclosure: Object.freeze({
            candidateNumber: index + 1,
            displayName: identity.displayName ?? 'iOS device',
            platform: 'ios' as const,
            kind: 'device' as const,
            discriminator: `device-${createHmac('sha256', this.#disclosureSecret)
              .update(canonicalDeviceKey(identity))
              .digest('hex')
              .slice(0, 8)}`,
          }),
        });
      });

    return Object.freeze({
      discoveryKey: randomUUID() as DiscoveryKey,
      platform: 'ios' as const,
      candidates: Object.freeze(candidates),
    });
  }

  async #inspectPreparation(
    target: LifecycleTarget,
    signal?: AbortSignal,
  ): Promise<PreparationFactsView> {
    const route = localIosRoute(target);
    signal?.throwIfAborted();
    const probeResult = await this.#dependencies.inspectPreparation(route, signal);
    signal?.throwIfAborted();
    const facts = createIosPreparationProbeFacts(probeResult);
    const summary = preparationSummary(facts);
    return Object.freeze({
      key: randomUUID() as PreparationFactsKey,
      platform: 'ios' as const,
      capturedAt: (this.#dependencies.now?.() ?? new Date()).toISOString(),
      policyVersion,
      compatibility: summary.compatibility,
      blockerCategories: summary.blockerCategories,
    });
  }

  async #inspectApplications(
    target: LifecycleTarget,
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly ApplicationFact[]> {
    const route = localIosRoute(target);
    signal?.throwIfAborted();
    const applications = await this.#dependencies.inspectApplications(route, signal);
    signal?.throwIfAborted();
    const needle = query.toLowerCase();
    return Object.freeze(
      applications
        .map((application) => createApplicationFact(target, application))
        .filter((application) =>
          `${application.name} ${application.id}`.toLowerCase().includes(needle),
        ),
    );
  }

  async #inspectEndpoint(
    target: LifecycleTarget,
    signal?: AbortSignal,
  ): Promise<EndpointStatusView> {
    const route = localIosRoute(target);
    signal?.throwIfAborted();
    const status = await this.#dependencies.inspectEndpoint(route.endpoint, signal);
    signal?.throwIfAborted();
    return createEndpointStatusView(status);
  }
}

export function createIosLocalPhysicalReadOnlyProvider(
  dependencies: Omit<IosReadOnlyProviderDependencies, 'discover'> &
    Partial<Pick<IosReadOnlyProviderDependencies, 'discover'>>,
): IosLocalPhysicalReadOnlyProvider {
  return new IosLocalPhysicalReadOnlyProvider({
    ...dependencies,
    discover: dependencies.discover ?? discoverIosDevices,
  });
}
