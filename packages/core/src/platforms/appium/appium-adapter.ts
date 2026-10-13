import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  capabilities,
  readNativeEnvironment,
  splitCapabilities,
  type NativeAppTarget,
  type NativeEnvironment,
  type NativePlatform,
  type ResolvedNativeSession,
} from './schema.ts';
import { NativeManager, type NativeLeaseContext } from './runtime/manager.ts';
import { nativeReadinessCode, NativeSessionCreationUncertainError } from './runtime/session.ts';
import { WorkerTerminatedError } from '../../core/exploration/runtime.ts';
import { isRecord, type JavaScriptObservation } from '../../core/exploration/protocol.ts';
import {
  validateReadinessObservations,
  type PlatformAdapter,
} from '../../core/platforms/contracts.ts';
import {
  resolveAppiumSession,
  resolveAndroidReadinessSession,
  resolveIosReadinessSession,
  isLocalAppiumEndpoint,
} from './session-resolver.ts';
import { discoverDevices } from '../../setup/devices.ts';
import type { Device } from '../../setup/devices.ts';
import { discoverAndroidReadinessDevices } from '../../setup/devices.ts';
import { discoverIosDevices, type IosDevice } from '../../setup/ios-devices.ts';
import { discoverApplications } from '../../setup/applications.ts';
import type { SessionSetup, SetupInspection } from '../../core/platforms/contracts.ts';
import {
  canonicalDeviceKey,
  identityFromLocalFact,
  isLocalPhysicalMobileTarget,
  sameDeviceIdentity,
  type DeviceIdentity,
  type PublicDeviceCandidate,
  type TargetSelectionInput,
  type TargetSelectionResult,
  PhoneCloseUncertainError,
} from '../../mobile/contracts/device.ts';
import { assertMobileCreationAllowed } from '../../mobile/devices/coordinator.ts';
import {
  acquireDeviceLock,
  assertDeviceLockReleaseCertain,
  DeviceLockHandleCleanupError,
  DeviceLockReleaseUncertainError,
  type DeviceLockLease,
} from '../../mobile/devices/device-lock.ts';

function errorWithDeviceLockReleaseFailure(
  primary: unknown,
  supplemental: DeviceLockHandleCleanupError | DeviceLockReleaseUncertainError,
): AggregateError {
  const message = primary instanceof Error ? primary.message : String(primary);
  const suffix =
    supplemental instanceof DeviceLockHandleCleanupError
      ? 'Device lock ownership was released, but local handle cleanup also failed.'
      : 'Device lock release also became uncertain.';
  return new AggregateError([primary, supplemental], `${message}; ${suffix}`, {
    cause: primary,
  });
}

export type AppiumAdapterDefinition = {
  id: NativePlatform;
  label: string;
  platformName: string;
  automationName: string;
};

type InspectionProviders = Readonly<{
  devices(platform: NativePlatform): ReturnType<typeof discoverDevices>;
  applications(
    environment: NativeEnvironment,
    query: string,
    identity?: DeviceIdentity,
  ): ReturnType<typeof discoverApplications>;
}>;

const inspectionProviders = new WeakMap<AppiumPlatformAdapter, InspectionProviders>();
const productionInspectionProviders: InspectionProviders = Object.freeze({
  devices: discoverDevices,
  applications: (environment, query, identity) =>
    discoverApplications(environment, query, undefined, identity),
});

export class AppiumPlatformAdapter implements PlatformAdapter {
  readonly id: NativePlatform;
  readonly label: string;
  readonly #runtime = new NativeManager();
  readonly runtime!: Readonly<{
    readonly currentApp: NativeAppTarget | undefined;
    readonly isRunning: boolean;
    readonly hasUncertainOwnedSession: boolean;
    readonly hasUncertainCreation: boolean;
    readonly currentSessionGeneration: number | undefined;
  }>;
  get codeContext() {
    const target = this.#runtime.isRunning ? this.#runtime.currentApp : this.app;
    const appId = target?.['appium:appPackage'] ?? target?.['appium:bundleId'];
    return {
      language: 'javascript' as const,
      globals: [
        { name: 'driver', description: 'WebdriverIO client attached to the Appium Session' },
        { name: 'browser', description: 'Alias of driver' },
        { name: 'expect', description: 'expect-webdriverio' },
        ...(appId
          ? [
              {
                name: 'app',
                description:
                  'Configured Session App target; not the current foreground App after activation',
              },
            ]
          : []),
        { name: 'display', description: 'Return a screenshot UI observation' },
        { name: 'evidence', description: 'Capture a screenshot UI observation with screenshot()' },
      ],
      guidelines: [
        'Each exe_js call is isolated. Variables and functions created by earlier calls do not persist.',
        'Use WebdriverIO APIs through driver.$() and driver.$$(); there are no global $ or $$.',
        ...(this.id === 'android' || this.id === 'ios'
          ? [
              'Generate Appium JavaScript for exe_js; do not use host shell commands, direct WDA requests or temporary phone clients for UI interaction.',
              'Controls first: query current visible, unambiguous elements with driver.$()/driver.$$() and use their supported APIs; prefer an identified scroll container.',
              'Only use visual absolute-coordinate actions when the JS interface cannot reliably obtain the tree or the requested target exposes no usable control. A bad selector, truncated extraction or parsing error is not proof of missing controls.',
              'Explain coordinate fallback, use a current screenshot and map image pixels to Appium viewport units. Return to control locators when usable.',
            ]
          : []),
        ...(this.id === 'android'
          ? [
              'When a coordinate scroll fallback is necessary, keep its bounded gesture code in the current exe_js call and observe afterward; do not use the example as a default instead of an available container.',
            ]
          : []),
        ...(this.id === 'macos'
          ? [
              'Mac2 attributes include identifier, label, title and value; do not request name.',
              'macOS accessibility text may contain Unicode Cf controls; remove /\p{Cf}/gu before checking user-declared outcomes.',
              'Capture screenshots with evidence.screenshot(), not driver.takeScreenshot().',
            ]
          : []),
        ...(appId && this.id === 'android'
          ? [
              'The configured Android app target exposes app.resourceId(name); do not use it for a different foreground package.',
            ]
          : []),
        'Await every operation.',
        'Observe actual UI state; check only user-declared outcomes.',
      ],
    };
  }
  private environment?: NativeEnvironment;
  private app?: NativeAppTarget;
  private issue?: string;
  private notices: string[] = [];
  private readonly definition: AppiumAdapterDefinition;
  private initialized = false;
  readonly #selectionSecret = randomBytes(32);
  #selectionSnapshot?: {
    id: string;
    identities: DeviceIdentity[];
    candidates: PublicDeviceCandidate[];
  };
  #target?: {
    identity: DeviceIdentity;
    endpoint: string;
    selectedBy: 'single-candidate' | 'explicit-user-selection';
    candidate: PublicDeviceCandidate;
  };
  #lifecycleToken?: object;
  #deviceLock?: DeviceLockLease;
  #closeUncertain = false;
  private get hintsFile(): string {
    const directory =
      process.env.MAAT_SESSION_HINTS_DIR ?? path.join(homedir(), '.maat', 'session-hints');
    return path.join(directory, `${this.id}.json`);
  }

  constructor(definition: AppiumAdapterDefinition) {
    this.definition = definition;
    this.id = definition.id;
    this.label = definition.label;
    const runtime = this.#runtime;
    const runtimeFacade = Object.freeze({
      get currentApp() {
        const app = runtime.currentApp;
        return app ? Object.freeze({ ...app }) : undefined;
      },
      get isRunning() {
        return runtime.isRunning;
      },
      get hasUncertainOwnedSession() {
        return runtime.hasUncertainOwnedSession;
      },
      get hasUncertainCreation() {
        return runtime.hasUncertainCreation;
      },
      get currentSessionGeneration() {
        return runtime.currentSessionGeneration;
      },
    });
    Object.defineProperty(this, 'runtime', {
      value: runtimeFacade,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  }
  get sessionHints(): Readonly<NativeEnvironment> | undefined {
    return this.environment;
  }
  get appTarget(): Readonly<NativeAppTarget> | undefined {
    return this.app;
  }
  /** Side-effect-free route classification from an exact locally discovered target pin. */
  isMigratedLocalPhysicalRoute(): boolean {
    return isLocalPhysicalMobileTarget(this.#target?.identity);
  }

  /** Internal facade guard used before switching away from a blocked mobile lifecycle. */
  assertLifecycleCertain(): void {
    this.#assertCloseCertain();
  }

  hasLifecycleUncertainty(): boolean {
    if (this.id === 'android' || this.id === 'ios') {
      try {
        assertDeviceLockReleaseCertain();
      } catch {
        return true;
      }
    }
    return this.#closeUncertain || this.#runtime.hasUncertainOwnedSession;
  }

  async initialize(): Promise<void> {
    this.#assertCloseCertain();
    assertMobileCreationAllowed(this.isMigratedLocalPhysicalRoute());
    if (this.initialized) return;
    this.environment = await readNativeEnvironment(this.hintsFile).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { platform: this.id, capabilities: {} };
    });
    if (this.environment.platform !== this.id)
      throw new Error(`Environment platform must be ${this.id}.`);
    this.initialized = true;
  }

  async configureSession(input: SessionSetup): Promise<void> {
    this.#assertCloseCertain();
    if (input.clearAppTarget !== undefined && typeof input.clearAppTarget !== 'boolean')
      throw new Error('clearAppTarget must be a boolean.');
    if (!this.environment) await this.initialize();
    const split = splitCapabilities(input.capabilities ?? {});
    if (input.clearAppTarget && Object.keys(split.app).length)
      throw new Error('clearAppTarget cannot be combined with App target capabilities.');
    if (
      (split.environment['appium:noReset'] === false ||
        split.environment['appium:fullReset'] === true) &&
      !input.allowDataReset
    ) {
      throw new Error('Clearing app data requires explicit user intent and allowDataReset=true.');
    }
    delete split.environment.platformName;
    delete split.environment['appium:automationName'];
    const base = this.environment ?? { platform: this.id, capabilities: {} };
    const sanitizedBase = splitCapabilities(base.capabilities).environment;
    const nextEnvironment: NativeEnvironment = {
      platform: this.id,
      serverUrl: input.serverUrl ?? base.serverUrl,
      device: (input.device as NativeEnvironment['device']) ?? base.device,
      capabilities: { ...sanitizedBase, ...split.environment },
    };
    if (
      this.#target &&
      new URL(nextEnvironment.serverUrl ?? 'http://127.0.0.1:4723/').href !== this.#target.endpoint
    )
      throw new Error(
        'The active phone target pins its Appium endpoint. Release it before changing endpoints.',
      );
    const nextApp = input.clearAppTarget
      ? undefined
      : Object.keys(split.app).length
        ? split.app
        : this.app;
    capabilities({
      environment: nextEnvironment,
      capabilities: nextEnvironment.capabilities,
      app: nextApp,
    });
    // Candidate handles describe the exact prior configuration/discovery generation.
    this.#selectionSnapshot = undefined;
    this.environment = nextEnvironment;
    this.app = nextApp;
    this.issue = undefined;
    await this.#runtime.close();
  }

  async inspectSetup(request: SetupInspection): Promise<unknown> {
    if (this.id === 'android' || this.id === 'ios') assertDeviceLockReleaseCertain();
    const providers = inspectionProviders.get(this) ?? productionInspectionProviders;
    if (request.kind === 'devices') {
      const devices = await providers.devices(this.id);
      if (this.id === 'macos') return devices;
      return devices.map((device, index) => ({
        number: index + 1,
        displayName: device.name,
        platform: this.id,
        kind: device.kind,
        discriminator: `${device.kind}-${createHmac('sha256', this.#selectionSecret)
          .update(`${this.id}\0${device.kind}\0${device.id}`)
          .digest('hex')
          .slice(0, 8)}`,
      }));
    }
    if (!this.environment) await this.initialize();
    if (
      (this.id === 'android' ||
        (this.id === 'ios' && this.environment!.device?.kind !== 'simulator')) &&
      isLocalAppiumEndpoint(this.environment!.serverUrl ?? 'http://127.0.0.1:4723/') &&
      !this.#target
    )
      throw new Error('Select the current phone with check_device_ready before finding apps.');
    const apps = await providers.applications(
      this.#targetEnvironment() ?? this.environment!,
      request.query ?? '',
      this.#target?.identity,
    );
    const appCapability = this.id === 'android' ? 'appium:appPackage' : 'appium:bundleId';
    return apps.map((app) => ({ ...app, capabilities: { [appCapability]: app.id } }));
  }

  protected discoverSelectionDevices(signal?: AbortSignal): Promise<(Device | IosDevice)[]> {
    return this.id === 'ios'
      ? discoverIosDevices(signal)
      : this.discoverAndroidSelectionDevices(signal);
  }

  /** Selection talks only to an existing daemon; the connector parameter is an offline-test seam. */
  protected discoverAndroidSelectionDevices(
    signal?: AbortSignal,
    connectAdb?: Parameters<typeof discoverAndroidReadinessDevices>[1],
  ): Promise<Device[]> {
    return discoverAndroidReadinessDevices(signal, connectAdb);
  }

  #publicCandidate(identity: DeviceIdentity, candidateNumber: number): PublicDeviceCandidate {
    return {
      candidateNumber,
      displayName: identity.displayName ?? `${identity.platform} ${identity.kind}`,
      platform: identity.platform,
      kind: identity.kind,
      discriminator: `${identity.kind}-${createHmac('sha256', this.#selectionSecret)
        .update(canonicalDeviceKey(identity))
        .digest('hex')
        .slice(0, 8)}`,
    };
  }

  async #currentSelectionIdentities(signal?: AbortSignal): Promise<DeviceIdentity[]> {
    if (this.id !== 'android' && this.id !== 'ios')
      throw new Error('Phone target selection supports only Android and iOS.');
    const platform = this.id;
    const source = this.id === 'ios' ? 'local-core-device' : 'local-adb';
    return (await this.discoverSelectionDevices(signal)).map((device) =>
      identityFromLocalFact({ source, platform, device }),
    );
  }

  #sameGeneration(left: DeviceIdentity[], right: DeviceIdentity[]): boolean {
    if (left.length !== right.length) return false;
    const remaining = [...right];
    return left.every((identity) => {
      const index = remaining.findIndex((candidate) => sameDeviceIdentity(identity, candidate));
      if (index < 0) return false;
      remaining.splice(index, 1);
      return true;
    });
  }

  #hasDuplicateIdentities(identities: DeviceIdentity[]): boolean {
    return identities.some((identity, index) =>
      identities.slice(index + 1).some((candidate) => sameDeviceIdentity(identity, candidate)),
    );
  }

  #legacyHintProposal(
    identities: DeviceIdentity[],
    candidates: PublicDeviceCandidate[],
  ): PublicDeviceCandidate[] {
    const environment = this.environment!;
    const selectors: Array<{ kind?: string; name?: string }> = [];
    if (environment.device?.kind !== undefined || environment.device?.name !== undefined)
      selectors.push(environment.device);
    const deviceName = environment.capabilities['appium:deviceName'];
    if (typeof deviceName === 'string') selectors.push({ name: deviceName });
    const options = environment.capabilities['appium:options'];
    if (isRecord(options)) {
      for (const key of ['deviceName', 'appium:deviceName']) {
        const nestedDeviceName = options[key];
        if (typeof nestedDeviceName === 'string') selectors.push({ name: nestedDeviceName });
      }
    }

    if (!selectors.length) return candidates;

    const matches = identities.filter((identity) =>
      selectors.every(
        (selector) =>
          (selector.kind === undefined || identity.kind === selector.kind) &&
          (selector.name === undefined || identity.displayName === selector.name),
      ),
    );
    if (matches.length !== 1) return candidates;
    const matched = matches[0]!;
    return candidates.filter((_candidate, index) =>
      sameDeviceIdentity(identities[index]!, matched),
    );
  }

  async selectReadinessTarget(
    selection?: TargetSelectionInput,
    signal?: AbortSignal,
  ): Promise<TargetSelectionResult | undefined> {
    this.#assertCloseCertain();
    signal?.throwIfAborted();
    if (!this.environment) await this.initialize();
    if (this.id !== 'android' && this.id !== 'ios') return;
    if (
      this.environment!.device?.kind === 'emulator' ||
      this.environment!.device?.kind === 'simulator'
    )
      return;
    const platform = this.id;
    const endpoint = new URL(this.environment!.serverUrl ?? 'http://127.0.0.1:4723/').href;
    // Remote providers and the legacy simulator route are deliberately outside this slice.
    if (!isLocalAppiumEndpoint(endpoint)) return;

    if (this.#target) {
      return {
        status: 'selected',
        platform,
        selectedBy: this.#target.selectedBy,
        candidate: this.#target.candidate,
      };
    }

    if (selection) {
      const snapshot = this.#selectionSnapshot;
      if (!snapshot || selection.discoveryId !== snapshot.id)
        return { status: 'selection-stale', platform };
      if (
        !Number.isSafeInteger(selection.candidateNumber) ||
        !snapshot.candidates.some(
          (candidate) => candidate.candidateNumber === selection.candidateNumber,
        )
      )
        return { status: 'selection-invalid', platform };
      const current = (await this.#currentSelectionIdentities(signal)).filter(
        isLocalPhysicalMobileTarget,
      );
      if (
        this.#hasDuplicateIdentities(snapshot.identities) ||
        this.#hasDuplicateIdentities(current) ||
        !this.#sameGeneration(snapshot.identities, current)
      ) {
        this.#selectionSnapshot = undefined;
        return { status: 'selection-stale', platform };
      }
      const expected = snapshot.identities[selection.candidateNumber - 1]!;
      const exact = current.filter((candidate) => sameDeviceIdentity(candidate, expected));
      if (exact.length !== 1) {
        this.#selectionSnapshot = undefined;
        return { status: 'selection-stale', platform };
      }
      const identity = exact[0]!;
      const candidate = this.#publicCandidate(identity, selection.candidateNumber);
      const deviceLock = acquireDeviceLock(identity);
      this.#deviceLock = deviceLock;
      try {
        signal?.throwIfAborted();
      } catch (error) {
        this.#releaseBeforePin(deviceLock, error);
      }
      this.#target = {
        identity,
        endpoint,
        selectedBy: 'explicit-user-selection',
        candidate,
      };
      this.#lifecycleToken = Object.freeze({});
      assertMobileCreationAllowed(this.isMigratedLocalPhysicalRoute());
      this.#selectionSnapshot = undefined;
      return {
        status: 'target-selected',
        platform,
        selectedBy: 'explicit-user-selection',
        candidate,
      };
    }

    const discovered = await this.#currentSelectionIdentities(signal);
    const identities = discovered.filter(isLocalPhysicalMobileTarget);
    // A local emulator remains on the pre-migration resolver path. Discovery
    // classifies it but never turns it into a migrated target pin.
    if (!identities.length && discovered.length) {
      this.#selectionSnapshot = undefined;
      return;
    }
    if (!identities.length) {
      this.#selectionSnapshot = undefined;
      return { status: 'device-not-found', platform };
    }
    const candidates = identities.map((identity, index) =>
      this.#publicCandidate(identity, index + 1),
    );
    if (identities.length > 1) {
      const id = randomUUID();
      const proposal = this.#legacyHintProposal(identities, candidates);
      this.#selectionSnapshot = { id, identities, candidates: proposal };
      return {
        status: 'selection-required',
        platform,
        discoveryId: id,
        candidates: proposal,
      };
    }
    const identity = identities[0]!;
    const candidate = candidates[0]!;
    const deviceLock = acquireDeviceLock(identity);
    this.#deviceLock = deviceLock;
    try {
      signal?.throwIfAborted();
    } catch (error) {
      this.#releaseBeforePin(deviceLock, error);
    }
    this.#target = {
      identity,
      endpoint,
      selectedBy: 'single-candidate',
      candidate,
    };
    this.#lifecycleToken = Object.freeze({});
    assertMobileCreationAllowed(this.isMigratedLocalPhysicalRoute());
    this.#selectionSnapshot = undefined;
    return {
      status: 'target-selected',
      platform,
      selectedBy: 'single-candidate',
      candidate,
    };
  }

  #targetEnvironment(): NativeEnvironment | undefined {
    if (!this.#target || !this.environment) return;
    return {
      ...this.environment,
      serverUrl: this.#target.endpoint,
      device: {
        kind: this.#target.identity.kind,
        name: this.#target.identity.displayName,
      },
    };
  }

  #leaseContext(): NativeLeaseContext | undefined {
    if (!this.#target || !this.#lifecycleToken) return;
    return {
      lifecycleToken: this.#lifecycleToken,
      identity: Object.freeze({ ...this.#target.identity }),
      endpoint: this.#target.endpoint,
      backend: `${this.id}:${this.definition.automationName}`,
    };
  }

  #requiresTargetSelection(): boolean {
    if (!this.environment || (this.id !== 'android' && this.id !== 'ios')) return false;
    return (
      isLocalAppiumEndpoint(this.environment.serverUrl ?? 'http://127.0.0.1:4723/') &&
      this.environment.device?.kind !== 'simulator' &&
      this.environment.device?.kind !== 'emulator'
    );
  }

  #assertTargetSelected() {
    this.#assertCloseCertain();
    if (this.#requiresTargetSelection() && !this.#target)
      throw new Error(
        'PHONE_TARGET_SELECTION_REQUIRED: call check_device_ready to select the current phone before creating or using a Session.',
      );
  }

  #assertCloseCertain() {
    if (this.id === 'android' || this.id === 'ios') assertDeviceLockReleaseCertain();
    assertMobileCreationAllowed(this.isMigratedLocalPhysicalRoute());
    if (this.hasLifecycleUncertainty()) throw new PhoneCloseUncertainError();
  }

  #releaseBeforePin(deviceLock: DeviceLockLease, primary: unknown): never {
    try {
      deviceLock.release();
      this.#deviceLock = undefined;
    } catch (cleanup) {
      if (cleanup instanceof DeviceLockHandleCleanupError) this.#deviceLock = undefined;
      const supplemental =
        cleanup instanceof DeviceLockHandleCleanupError ||
        cleanup instanceof DeviceLockReleaseUncertainError
          ? cleanup
          : new DeviceLockReleaseUncertainError();
      throw errorWithDeviceLockReleaseFailure(primary, supplemental);
    }
    throw primary;
  }

  #persistentHintsEnvironment(): NativeEnvironment {
    if (this.id !== 'android' && this.id !== 'ios') return this.environment!;
    const routingId = this.#target?.identity.routingId;
    // These exact normalized names cover the same cold-routing inputs consumed by
    // session-resolver, plus transient lifecycle/selection metadata. Do not infer
    // routing from substrings: valid automation, App and signing capabilities survive.
    const unsafeCapabilityNames = new Set([
      'remoteadbhost',
      'adbport',
      'systemport',
      'wdalocalport',
      'udid',
      'serial',
      'devicename',
      'avd',
      'webdriveragenturl',
      'wdabaseurl',
      'sessionid',
      'routingid',
      'canonicalkey',
      'discoveryid',
      'candidatereference',
      'candidatenumber',
      'selectedby',
      'consent',
      'lifecyclepin',
    ]);
    const normalizedCapabilityName = (key: string) => key.split(':').at(-1)!.toLowerCase();
    const normalizedCredentialName = (key: string) =>
      normalizedCapabilityName(key).replace(/[_-]/g, '');
    const unsafeSecretNames = new Set([
      'password',
      'secret',
      'token',
      'accesstoken',
      'credential',
      'accesskey',
      'apikey',
      'authorization',
      'clientsecret',
      'clienttoken',
      'authtoken',
      'bearertoken',
      'refreshtoken',
      'securitytoken',
      'privatekey',
      'oauthtoken',
      'oauthsecret',
      'sessiontoken',
      'signingkey',
    ]);
    const unsafeVendorIdentityNames = new Set(['username', 'user']);
    const isVendorOptions = (key: string) =>
      /^[^:]+:options$/i.test(key) && key.toLowerCase() !== 'appium:options';
    const unsafePath = /^(?:file:|\/|[A-Za-z]:[\\/])/i;
    const sanitize = (value: unknown, vendorOptions = false): unknown => {
      if (typeof value === 'string') {
        if ((routingId && value === routingId) || unsafePath.test(value)) return undefined;
        try {
          const url = new URL(value);
          if (
            url.username ||
            url.password ||
            [...url.searchParams.keys()].some((key) => {
              const normalized = normalizedCredentialName(key);
              return unsafeSecretNames.has(normalized) || unsafeVendorIdentityNames.has(normalized);
            })
          )
            return undefined;
        } catch {
          // Non-URL strings are ordinary capability values.
        }
        return value;
      }
      if (Array.isArray(value)) {
        const items = value
          .map((item) => sanitize(item, vendorOptions))
          .filter((item) => item !== undefined);
        return items;
      }
      if (isRecord(value)) {
        return Object.fromEntries(
          Object.entries(value).flatMap(([key, item]) => {
            const normalized = normalizedCapabilityName(key);
            if (
              unsafeCapabilityNames.has(normalized) ||
              unsafeSecretNames.has(normalizedCredentialName(key)) ||
              (vendorOptions && unsafeVendorIdentityNames.has(normalized))
            )
              return [];
            const safe = sanitize(item, vendorOptions || isVendorOptions(key));
            return safe === undefined ? [] : [[key, safe]];
          }),
        );
      }
      return value;
    };
    const capabilities = sanitize(this.environment!.capabilities);
    return {
      platform: this.environment!.platform,
      ...(this.environment!.serverUrl ? { serverUrl: this.environment!.serverUrl } : {}),
      ...(this.environment!.device
        ? {
            device: {
              ...(this.environment!.device.kind ? { kind: this.environment!.device.kind } : {}),
              ...(this.environment!.device.name &&
              this.environment!.device.name !== routingId &&
              !unsafePath.test(this.environment!.device.name)
                ? { name: this.environment!.device.name }
                : {}),
            },
          }
        : {}),
      capabilities: isRecord(capabilities) ? capabilities : {},
    };
  }

  async #prepare(
    signal?: AbortSignal,
    readiness = false,
    allowWdaInstallation = false,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!this.environment) await this.initialize();
    try {
      const safeAndroid = this.id === 'android';
      const safeIos =
        this.id === 'ios' &&
        (readiness ||
          (this.environment!.device?.kind !== 'simulator' &&
            isLocalAppiumEndpoint(this.environment!.serverUrl ?? 'http://127.0.0.1:4723/')));
      if (safeIos && this.app && Object.keys(this.app).length)
        throw new Error(
          'IOS_READINESS_BASE_SESSION_REQUIRED: establish a base connection before launching an App through exe_js. The configured App target was not cleared automatically.',
        );
      const selectedEnvironment = this.#targetEnvironment() ?? this.environment!;
      let resolved = safeIos
        ? await this.resolveIosReadiness(
            signal,
            undefined,
            allowWdaInstallation,
            this.#target?.identity,
            selectedEnvironment,
          )
        : safeAndroid
          ? await this.resolveReadiness(signal, this.#target?.identity, selectedEnvironment)
          : await resolveAppiumSession(selectedEnvironment, undefined, signal);
      if (
        this.id === 'ios' &&
        !safeIos &&
        resolved.environment.device?.kind === 'device' &&
        isLocalAppiumEndpoint(resolved.environment.serverUrl!)
      )
        resolved = await this.resolveIosReadiness(signal, undefined, allowWdaInstallation);
      signal?.throwIfAborted();
      const definition = this.definition;
      await this.#runtime.configureResolved(
        {
          ...resolved,
          app: this.app,
          capabilities: {
            ...resolved.capabilities,
            platformName: definition.platformName,
            'appium:automationName': definition.automationName,
            ...(safeAndroid ? { 'appium:skipUnlock': true } : {}),
          },
        },
        this.isMigratedLocalPhysicalRoute(),
        this.#leaseContext(),
        readiness,
      );
      this.environment = resolved.environment;
      this.notices = resolved.notices ?? [];
      this.issue = undefined;
    } catch (error) {
      this.issue = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  protected resolveReadiness(
    signal?: AbortSignal,
    identity?: DeviceIdentity,
    environment = this.environment!,
  ) {
    return resolveAndroidReadinessSession(environment, signal, undefined, identity);
  }

  protected resolveIosReadiness(
    signal?: AbortSignal,
    currentTarget?: ResolvedNativeSession,
    allowWdaInstallation = false,
    identity?: DeviceIdentity,
    environment = this.environment!,
  ) {
    return resolveIosReadinessSession(
      environment,
      signal,
      undefined,
      currentTarget,
      allowWdaInstallation,
      identity,
    );
  }

  async executeReadiness(
    _code: string,
    signal?: AbortSignal,
    readinessOptions: {
      allowWdaInitialization?: boolean;
      allowWdaInstallation?: boolean;
      screenshot?: boolean;
    } = {},
  ) {
    if (this.id !== 'android' && this.id !== 'ios')
      throw new Error('Only Android and iOS support setup readiness.');
    signal?.throwIfAborted();
    if (!this.environment) await this.initialize();
    this.#assertTargetSelected();
    const options = this.environment!.capabilities['appium:options'];
    if (
      (this.app && Object.keys(this.app).length > 0) ||
      (isRecord(options) &&
        ['app', 'appPackage', 'appActivity', 'bundleId'].some(
          (key) => options[key] !== undefined || options[`appium:${key}`] !== undefined,
        )) ||
      (this.#runtime.isRunning &&
        this.#runtime.currentApp &&
        Object.keys(this.#runtime.currentApp).length > 0)
    )
      throw new Error(
        `${this.label} setup readiness requires a base Session without an App target.`,
      );
    if (this.id === 'android') await this.#prepareAndroidExecution(signal, true);
    else if (!this.#runtime.isRunning) {
      if (readinessOptions.allowWdaInitialization === false)
        throw new Error(
          'IOS_CONNECTION_INITIALIZATION_DISABLED: this caller requested an existing Session only; no new Session was created.',
        );
      await this.#prepare(signal, true, readinessOptions.allowWdaInstallation);
    } else {
      const generation = this.#runtime.currentSessionGeneration;
      const target = this.#runtime.currentTarget;
      if (!target || generation === undefined)
        throw new Error(
          'IOS_READINESS_UNSUPPORTED: the running Session has no provable device routing.',
        );
      await this.resolveIosReadiness(
        signal,
        target,
        false,
        this.#target?.identity,
        this.#targetEnvironment() ?? this.environment!,
      );
      return this.#executeReadinessTransaction(generation, signal, readinessOptions.screenshot);
    }
    return this.#executeReadinessTransaction(undefined, signal, readinessOptions.screenshot);
  }

  async #executeReadinessTransaction(
    generation: number | undefined,
    signal: AbortSignal | undefined,
    screenshot = false,
  ) {
    const code = nativeReadinessCode(this.id as 'android' | 'ios', screenshot);
    return this.#runtime.executeReadinessTransaction(
      code,
      signal,
      this.#leaseContext(),
      generation,
      async (raw) => {
        const observations = await this.#finishObservations(raw);
        const validated = validateReadinessObservations(observations, this.label, screenshot);
        signal?.throwIfAborted();
        return validated;
      },
    );
  }

  async #prepareAndroidExecution(signal?: AbortSignal, readiness = false) {
    signal?.throwIfAborted();
    if (!this.environment) await this.initialize();
    signal?.throwIfAborted();
    if (!this.#runtime.isRunning) {
      const skipUnlock = this.environment!.capabilities['appium:skipUnlock'];
      const options = this.environment!.capabilities['appium:options'];
      // Appium promotes these nested values over top-level capabilities.
      const unlockHints = [
        skipUnlock,
        ...(isRecord(options) ? [options.skipUnlock, options['appium:skipUnlock']] : []),
      ];
      if (unlockHints.some((value) => value !== undefined && value !== true))
        throw new Error(
          'ANDROID_READINESS_UNLOCK_UNSAFE: ready cannot create a Session with an explicit skipUnlock value other than true; set appium:skipUnlock to true and unlock/wake the phone yourself, then recheck.',
        );
      // Transient Session capability only: preserve user hints and healthy Sessions.
      await this.#prepare(signal, readiness);
    }
  }

  async execute(code: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.environment) await this.initialize();
    this.#assertTargetSelected();
    this.#runtime.assertExecutionLease(this.#leaseContext());
    if (this.id === 'android') {
      const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]);
      await this.#prepareAndroidExecution(bounded);
      return this.#executePrepared(code, bounded);
    }
    if (!this.#runtime.isRunning) await this.#prepare(signal);
    return this.#executePrepared(code, signal);
  }

  async #executePrepared(
    code: string,
    signal?: AbortSignal,
    allowAppFallback = true,
    sessionGeneration?: number,
    recovery = false,
  ) {
    let observations;
    try {
      observations =
        sessionGeneration === undefined
          ? await this.#runtime.executeLeased(code, signal, this.#leaseContext(), recovery)
          : await this.#runtime.executeExisting(
              code,
              sessionGeneration,
              signal,
              this.#leaseContext(),
              recovery,
            );
    } catch (error) {
      if (
        allowAppFallback &&
        // The legacy macOS backend may retry Session creation without an App target.
        // Mobile JavaScript can already have dispatched and must never be replayed.
        this.id === 'macos' &&
        !this.#runtime.isRunning &&
        !signal?.aborted &&
        !(error instanceof WorkerTerminatedError) &&
        !(error instanceof NativeSessionCreationUncertainError) &&
        !(error instanceof AggregateError) &&
        this.app &&
        Object.keys(this.app).length > 0 &&
        /app|bundle|package|activity/i.test(String(error))
      ) {
        const rejected = JSON.stringify(this.app);
        this.app = undefined;
        await this.#runtime.close();
        await this.#prepare(signal);
        observations = await this.#runtime.execute(code, signal);
        this.notices.push(
          `The configured App target ${rejected} could not create a Session. Maat created a base Session without it; discover or provide the App before further execution.`,
        );
      } else throw error;
    }
    return this.#finishObservations(observations);
  }

  async #finishObservations(
    observations: JavaScriptObservation[],
  ): Promise<JavaScriptObservation[]> {
    // A successful Session confirms stable hints; transient UUID/App data never enter environment.
    await mkdir(path.dirname(this.hintsFile), { recursive: true });
    await writeFile(
      this.hintsFile,
      JSON.stringify(this.#persistentHintsEnvironment(), null, 2) + '\n',
      {
        mode: 0o600,
      },
    );
    const notices = this.notices.splice(0);
    return notices.length
      ? [{ type: 'text' as const, text: notices.join('\n') }, ...observations]
      : observations;
  }

  status() {
    return {
      id: this.id,
      label: this.label,
      session: this.#runtime.isRunning ? ('ready' as const) : ('idle' as const),
      detail: this.issue ?? this.environment?.device?.name ?? 'device auto',
    };
  }
  async close() {
    if (this.id === 'android' || this.id === 'ios') assertDeviceLockReleaseCertain();
    assertMobileCreationAllowed(this.isMigratedLocalPhysicalRoute());
    if (this.#closeUncertain) throw new PhoneCloseUncertainError();
    const observingPriorCleanup = this.#runtime.hasUncertainOwnedSession;
    try {
      await this.#runtime.close();
    } catch (error) {
      if (!observingPriorCleanup && (this.id === 'android' || this.id === 'ios'))
        this.#closeUncertain = true;
      throw error;
    }
    try {
      this.#deviceLock?.release();
    } catch (error) {
      if (error instanceof DeviceLockHandleCleanupError) {
        this.#deviceLock = undefined;
        this.#target = undefined;
        this.#lifecycleToken = undefined;
        this.#selectionSnapshot = undefined;
        this.#closeUncertain = false;
        throw error;
      }
      if (error instanceof DeviceLockReleaseUncertainError) throw error;
      throw new DeviceLockReleaseUncertainError();
    }
    this.#deviceLock = undefined;
    this.#target = undefined;
    this.#lifecycleToken = undefined;
    this.#selectionSnapshot = undefined;
    this.#closeUncertain = false;
  }
}

/**
 * Source-internal inspection harness. Providers are held outside the instance and can only be
 * reached by inspectSetup after its mobile admission barrier.
 */
export function createAppiumPlatformAdapterWithInspectionProvidersForTests(
  definition: AppiumAdapterDefinition,
  providers: InspectionProviders,
): AppiumPlatformAdapter {
  const adapter = new AppiumPlatformAdapter(definition);
  inspectionProviders.set(adapter, Object.freeze({ ...providers }));
  return adapter;
}
