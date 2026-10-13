import {
  validateReadinessObservations,
  type SessionSetup,
  type SetupInspection,
} from '../core/platforms/contracts.ts';
import { PlatformRegistry } from '../core/platforms/registry.ts';
import { SetupAssistant, type SetupAssistantOptions } from '../setup-assistant/setup-assistant.ts';
import type {
  SetupCapabilityId,
  SetupAction,
  AndroidSetupCheckInput,
  SetupReadiness,
  SetupReadyInput,
  SetupReadinessSuccess,
} from '../setup-assistant/types.ts';
import { sameFingerprint } from '../setup-assistant/storage.ts';
import type { NativeAppTarget, NativeEnvironment } from '../platforms/appium/schema.ts';
import { isRecord, parseWorkerError, type WorkerError } from '../core/exploration/protocol.ts';
import { ExplorationExecutionError } from '../core/exploration/runtime.ts';
import { AppiumPlatformAdapter } from '../platforms/appium/appium-adapter.ts';
import { nativeReadinessCode } from '../platforms/appium/runtime/session.ts';
import { isMobilePlatform, runMobileOperation } from '../mobile/devices/coordinator.ts';
import { assertDeviceLockReleaseCertain } from '../mobile/devices/device-lock.ts';
import {
  processConnectionJobSupervisor,
  type ConnectionJobSupervisor,
} from '../mobile/connection/job-supervisor.ts';
import { assertConnectionJobAccess } from '../mobile/connection/job-slot.ts';

type MigratedRouteAdapter = {
  isMigratedLocalPhysicalRoute(): boolean;
  assertLifecycleCertain?(): void;
  hasLifecycleUncertainty?(): boolean;
};

function isMigratedLocalPhysicalRoute(adapter: unknown): boolean {
  return (
    typeof adapter === 'object' &&
    adapter !== null &&
    'isMigratedLocalPhysicalRoute' in adapter &&
    typeof adapter.isMigratedLocalPhysicalRoute === 'function' &&
    adapter.isMigratedLocalPhysicalRoute()
  );
}

const readinessDiagnostics = new WeakMap<Error, unknown>();
const readinessPublicCodes = new Set([
  'APPIUM_SERVICE_UNAVAILABLE',
  'ANDROID_DEVICE_MISSING',
  'ANDROID_DEVICE_OFFLINE',
  'ANDROID_DEVICE_SELECTION_REQUIRED',
  'ANDROID_DEVICE_UNAUTHORIZED',
  'ANDROID_DEVICE_LOCKED',
  'ANDROID_DEVICE_LOCK_STATE_UNKNOWN',
  'ANDROID_READINESS_COLD_UNSUPPORTED',
  'ANDROID_READINESS_UNLOCK_UNSAFE',
  'IOS_APP_DISCOVERY_FAILED',
  'IOS_CONNECTION_INITIALIZATION_DISABLED',
  'IOS_DEVELOPER_MODE_REQUIRED',
  'IOS_DEVICE_CHECK_FAILED',
  'IOS_DEVICE_LOCKED',
  'IOS_DEVICE_LOCK_STATE_UNKNOWN',
  'IOS_DEVICE_MISSING',
  'IOS_DEVICE_SELECTION_REQUIRED',
  'IOS_DEVICE_UNAVAILABLE',
  'IOS_HOST_UNSUPPORTED',
  'IOS_READINESS_BASE_SESSION_REQUIRED',
  'IOS_READINESS_UNSUPPORTED',
  'IOS_WDA_AUTHORIZATION_INVALID',
  'IOS_WDA_BUILD_INVALID',
  'IOS_WDA_BUILD_PATH_INVALID',
  'IOS_WDA_CERTIFICATE_INVALID',
  'IOS_WDA_CLEANUP_FAILED',
  'IOS_WDA_COMMAND_FAILED',
  'IOS_WDA_CONFIGURATION_CONFLICT',
  'IOS_WDA_DEVICE_REQUIRED',
  'IOS_WDA_IDENTITY_CONFLICT',
  'IOS_WDA_INSPECTION_FAILED',
  'IOS_WDA_INSTALLATION_AUTHORIZATION_REQUIRED',
  'IOS_WDA_OUTPUT_LIMIT',
  'IOS_WDA_PREPARATION_CANCELLED',
  'IOS_WDA_PREPARATION_FAILED',
  'IOS_WDA_PREPARATION_TIMEOUT',
  'IOS_WDA_PROFILE_INVALID',
  'IOS_WDA_SECURITY_REJECTED',
  'IOS_WDA_SIGNING_AUTHORIZATION_REQUIRED',
  'IOS_WDA_SIGNING_CHANGED',
  'IOS_WDA_SIGNING_REQUIRED',
  'NATIVE_SESSION_CHANGED',
  'NATIVE_SESSION_LEASE_MISMATCH',
  'NATIVE_SESSION_RECOVERY_REQUIRED',
  'PHONE_CLOSE_UNCERTAIN',
  'PHONE_SESSION_CREATION_UNCERTAIN',
  'PHONE_TARGET_SELECTION_REQUIRED',
  'READINESS_OUTPUT_LIMIT',
  'READINESS_PROOF_INVALID',
  'READINESS_SCREENSHOT_FAILED',
  'READINESS_SOURCE_EMPTY',
  'READINESS_VIEWPORT_INVALID',
]);

function readinessAggregateErrors(error: unknown): unknown[] | undefined {
  if (error instanceof AggregateError) return error.errors;
  return isRecord(error) && Array.isArray(error.errors) ? error.errors : undefined;
}

function readinessExecutionDetails(error: unknown, depth = 0): WorkerError | undefined {
  if (depth > 4) return;
  if (error instanceof ExplorationExecutionError) return error.details;
  if (isRecord(error)) {
    const details = parseWorkerError(error.details);
    if (details) return details;
  }
  const errors = readinessAggregateErrors(error);
  if (errors)
    for (const item of errors) {
      const details = readinessExecutionDetails(item, depth + 1);
      if (details) return details;
    }
  return error instanceof Error ? readinessExecutionDetails(error.cause, depth + 1) : undefined;
}

function readinessSafeCode(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.message !== 'string') return;
  const match = /^([A-Z][A-Z0-9_]+): /.exec(error.message);
  return match && readinessPublicCodes.has(match[1]) ? match[1] : undefined;
}

function safeReadinessError(prefix: string, raw: unknown): Error {
  const details = readinessExecutionDetails(raw);
  const code = readinessSafeCode(raw);
  const category =
    code === 'READINESS_OUTPUT_LIMIT' ? 'output-limit' : (details?.category ?? 'runtime-error');
  const phase = details?.phase ?? 'execute';
  const actionState = details?.actionState ?? 'uncertain';
  const cleanup = readinessAggregateErrors(raw) ? ' Owned Session cleanup failed.' : '';
  const message = `${prefix}${code ? ` (${code})` : ''}: ${category} during ${phase}; action state ${actionState}.${cleanup} No JavaScript was replayed. Retry setup.ready only after the fixed phone and Session ownership are ready for a fresh observation.`;
  const cause = new ExplorationExecutionError(message, {
    name: 'ReadinessExecutionError',
    message,
    category,
    phase,
    actionState,
  });
  const error = new Error(message, { cause });
  readinessDiagnostics.set(error, raw);
  return error;
}

function iosWdaSecurityRejection(error: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  if (error instanceof AggregateError)
    return error.errors.slice(0, 3).some((failure) => iosWdaSecurityRejection(failure, depth + 1));
  return (
    error instanceof Error &&
    (/invalid code signature|inadequate entitlements|profile has not been explicitly trusted/i.test(
      error.message,
    ) ||
      iosWdaSecurityRejection(error.cause, depth + 1))
  );
}

function hasErrorCode(error: unknown, code: string, depth = 0): boolean {
  if (depth > 4 || !error || typeof error !== 'object') return false;
  if ('code' in error && error.code === code) return true;
  if (error instanceof AggregateError)
    return error.errors.some((item) => hasErrorCode(item, code, depth + 1));
  return error instanceof Error && hasErrorCode(error.cause, code, depth + 1);
}

function validateReadyInput(input: SetupReadyInput): {
  waitSeconds: number;
  jobId?: string;
  jobAction?: 'query' | 'cancel';
} {
  if (!isRecord(input)) throw new Error('Setup readiness input must be an object.');
  const hasJobId = Object.hasOwn(input, 'jobId');
  const allowed = hasJobId
    ? ['jobId', 'jobAction', 'waitSeconds', 'signal']
    : [
        'screenshot',
        'signal',
        'waitSeconds',
        'allowWdaInitialization',
        'allowWdaInstallation',
        'targetSelection',
      ];
  if (Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !allowed.includes(key)))
    throw new Error('Setup readiness input contains fields that are invalid for this operation.');
  const waitSeconds = input.waitSeconds ?? 20;
  if (
    typeof waitSeconds !== 'number' ||
    !Number.isFinite(waitSeconds) ||
    waitSeconds < 0 ||
    waitSeconds > 20
  )
    throw new Error('Setup readiness waitSeconds must be between 0 and 20.');
  if (hasJobId) {
    const value = input as { jobId?: unknown; jobAction?: unknown };
    if (typeof value.jobId !== 'string' || !value.jobId)
      throw new Error('Connection job query requires a nonempty jobId.');
    if (
      value.jobAction !== undefined &&
      value.jobAction !== 'query' &&
      value.jobAction !== 'cancel'
    )
      throw new Error('Connection job action must be query or cancel.');
    return {
      waitSeconds,
      jobId: value.jobId,
      ...(value.jobAction ? { jobAction: value.jobAction } : {}),
    };
  }
  if ('jobAction' in input)
    throw new Error('Connection job cancellation requires a nonempty jobId.');
  return { waitSeconds };
}

/** Stable, host-neutral product API. Agent hosts translate this API into their own tools and UI. */
export class MaatApi {
  readonly #connectionJobCaller = Symbol('maat-api-connection-job-caller');
  #mobileRelease?: Promise<{ released: true; platform: 'android' | 'ios' }>;
  readonly workspaceRoot: string;
  readonly registry: PlatformRegistry;
  readonly setupAssistant: SetupAssistant;
  readonly connectionJobs: ConnectionJobSupervisor;

  constructor(
    registry: PlatformRegistry,
    workspaceRoot: string,
    setupOptions?: SetupAssistantOptions,
    connectionJobs: ConnectionJobSupervisor = processConnectionJobSupervisor,
  ) {
    this.registry = registry;
    this.workspaceRoot = workspaceRoot;
    this.setupAssistant = new SetupAssistant(setupOptions);
    this.connectionJobs = connectionJobs;
  }

  readonly platforms = {
    current: () => this.registry.current,
    list: () => this.registry.list(),
    select: async (id: string) => {
      this.connectionJobs.assertAccess();
      assertConnectionJobAccess();
      const current = this.registry.current as PlatformRegistry['current'] & MigratedRouteAdapter;
      const target = this.registry.get(id);
      if (isMobilePlatform(id)) assertDeviceLockReleaseCertain();
      let leavingAfterLockReleaseUncertainty = false;
      if (!isMobilePlatform(id)) {
        try {
          assertDeviceLockReleaseCertain();
        } catch {
          leavingAfterLockReleaseUncertainty = true;
        }
      }
      const select = async () => {
        if (isMigratedLocalPhysicalRoute(current) && !leavingAfterLockReleaseUncertainty)
          current.assertLifecycleCertain?.();
        await this.registry.select(id);
        const status = this.registry.current.status();
        if (id === 'macos') {
          const adapter = this.registry.current as { sessionHints?: { serverUrl?: string } };
          await this.setupAssistant.check({
            platform: id,
            serverUrl: adapter.sessionHints?.serverUrl,
          });
        }
        return status;
      };
      return isMobilePlatform(current.id) || (target && isMobilePlatform(target.id))
        ? runMobileOperation(
            select,
            () =>
              isMigratedLocalPhysicalRoute(current) ||
              (target !== undefined && isMigratedLocalPhysicalRoute(target)),
          )
        : select();
    },
    status: () => this.registry.current.status(),
    configure: async (configuration: Record<string, unknown>) => {
      const adapter = this.registry.current;
      if (isMobilePlatform(adapter.id)) assertDeviceLockReleaseCertain();
      if (isMigratedLocalPhysicalRoute(adapter)) {
        this.connectionJobs.assertAccess();
        assertConnectionJobAccess();
      }
      if (!adapter.configure) throw new Error(`${adapter.label} is not configurable.`);
      return adapter.configure(configuration);
    },
    configureSession: async (setup: SessionSetup) => {
      const adapter = this.registry.current;
      if (!adapter.configureSession) {
        throw new Error(`${adapter.label} does not accept Session hints.`);
      }
      if (isMobilePlatform(adapter.id)) {
        assertDeviceLockReleaseCertain();
        return runMobileOperation(
          () => adapter.configureSession!(setup),
          () => isMigratedLocalPhysicalRoute(adapter),
        );
      }
      await adapter.configureSession(setup);
    },
    inspectSetup: async (request: SetupInspection) => {
      const adapter = this.registry.current;
      if (isMobilePlatform(adapter.id)) assertDeviceLockReleaseCertain();
      if (!adapter.inspectSetup) {
        throw new Error(`${adapter.label} does not support this setup inspection.`);
      }
      return adapter.inspectSetup(request);
    },
  };

  /** Phone-only lifecycle facade. Adapter resolution and close share one process-wide slot. */
  readonly mobile = {
    releaseCurrentSession: (): Promise<{
      released: true;
      platform: 'android' | 'ios';
    }> => {
      if (this.#mobileRelease) return this.#mobileRelease;
      const adapter = this.registry.current;
      if (!isMobilePlatform(adapter.id))
        return Promise.reject(
          new Error('releaseCurrentSession requires the Android or iOS platform.'),
        );
      try {
        assertDeviceLockReleaseCertain();
      } catch (error) {
        return Promise.reject(error);
      }
      const platform = adapter.id;
      const release = runMobileOperation(
        async () => {
          await adapter.close();
          return { released: true as const, platform };
        },
        () => isMigratedLocalPhysicalRoute(adapter),
      );
      this.#mobileRelease = release;
      void release.then(
        () => {
          if (this.#mobileRelease === release) this.#mobileRelease = undefined;
        },
        () => {
          const lifecycle = adapter as typeof adapter & MigratedRouteAdapter;
          if (!lifecycle.hasLifecycleUncertainty?.() && this.#mobileRelease === release)
            this.#mobileRelease = undefined;
          // A failed owned cleanup retains this exact release result as the process-local
          // safety record. Admission failures such as mobile-busy remain retryable.
        },
      );
      return release;
    },
  };

  readonly setup = {
    current: () => this.setupAssistant.current(),
    check: async (input: AndroidSetupCheckInput & { platform?: string } = {}) => {
      const previous = this.setupAssistant.current();
      const platform = input.platform ?? this.registry.current.id;
      const adapter = this.registry.get(platform) as
        | { sessionHints?: Readonly<NativeEnvironment>; initialize(): Promise<void> }
        | undefined;
      if (platform === 'android' || platform === 'ios') {
        input.signal?.throwIfAborted();
        await adapter?.initialize();
        input.signal?.throwIfAborted();
      }
      const hints =
        platform === 'android' || platform === 'ios' ? adapter?.sessionHints : undefined;
      const snapshot = await this.setupAssistant.check({
        ...input,
        platform,
        ...(platform === 'android' || platform === 'ios'
          ? {
              serverUrl: input.serverUrl ?? hints?.serverUrl,
              device: input.device ?? hints?.device,
              remoteDeviceConfigured:
                input.remoteDeviceConfigured ??
                (typeof hints?.capabilities['appium:deviceName'] === 'string' &&
                  Boolean(hints.capabilities['appium:deviceName'].trim())),
            }
          : {}),
      });
      const previousHasProcess = Boolean(
        previous.fingerprint.appiumPid || previous.fingerprint.wdaPid,
      );
      if (
        snapshot.platform === 'macos' &&
        previousHasProcess &&
        !sameFingerprint(previous.fingerprint, snapshot.fingerprint)
      ) {
        await this.registry.get('macos')?.close();
      }
      return snapshot;
    },
    ready: async (input: SetupReadyInput = {}): Promise<SetupReadiness> => {
      const request = validateReadyInput(input);
      if (request.jobId)
        return request.jobAction === 'cancel'
          ? this.connectionJobs.cancel(this.#connectionJobCaller, request.jobId, {
              waitSeconds: request.waitSeconds,
              signal: input.signal,
            })
          : this.connectionJobs.query(this.#connectionJobCaller, request.jobId, {
              waitSeconds: request.waitSeconds,
              signal: input.signal,
            });
      const adapter = this.registry.current;
      if (adapter.id !== 'android' && adapter.id !== 'ios')
        throw new Error(
          `Setup readiness is unsupported for ${adapter.id}; only Android and iOS are supported.`,
        );
      assertDeviceLockReleaseCertain();
      const platform = adapter.id;
      if (
        input.targetSelection !== undefined &&
        (!isRecord(input.targetSelection) ||
          typeof input.targetSelection.discoveryId !== 'string' ||
          !Number.isSafeInteger(input.targetSelection.candidateNumber) ||
          typeof input.targetSelection.candidateNumber !== 'number')
      )
        throw new Error(
          'Target selection requires a string discoveryId and integer candidateNumber.',
        );
      if (input.screenshot !== undefined && typeof input.screenshot !== 'boolean')
        throw new Error('Setup readiness screenshot must be a boolean.');
      if (
        input.allowWdaInitialization !== undefined &&
        typeof input.allowWdaInitialization !== 'boolean'
      )
        throw new Error('WDA initialization authorization must be a boolean.');
      if (input.allowWdaInitialization && adapter.id !== 'ios')
        throw new Error(
          'WDA initialization authorization applies only to iOS; Android unlock protection is unchanged.',
        );
      if (
        input.allowWdaInstallation !== undefined &&
        typeof input.allowWdaInstallation !== 'boolean'
      )
        throw new Error('WDA first-installation authorization must be a boolean.');
      if (input.allowWdaInstallation && adapter.id !== 'ios')
        throw new Error('WDA installation authorization applies only to iOS.');
      const signal = AbortSignal.any([
        ...(input.signal ? [input.signal] : []),
        AbortSignal.timeout(adapter.id === 'ios' ? 180_000 : 15_000),
      ]);
      const label = adapter.label;
      if (input.signal?.aborted)
        throw safeReadinessError(`${label} setup readiness cancelled`, input.signal.reason);
      const targetSelection = await runMobileOperation(
        async () => await adapter.selectReadinessTarget?.(input.targetSelection, signal),
        () => isMigratedLocalPhysicalRoute(adapter),
      );
      if (signal.aborted)
        throw safeReadinessError(`${label} setup readiness cancelled`, signal.reason);
      if (targetSelection && targetSelection.status !== 'selected')
        return {
          ...targetSelection,
          ready: false as const,
        };
      const execute = (
        jobSignal: AbortSignal,
        connectionJobOwner?: symbol,
      ): Promise<SetupReadinessSuccess> =>
        runMobileOperation(
          async () => {
            const snapshot = await this.setup.check({ platform: adapter.id, signal: jobSignal });
            jobSignal.throwIfAborted();
            if (!snapshot.canContinue)
              throw new Error(`${label} setup readiness is blocked by doctor preparation checks.`);
            if (this.registry.current !== adapter)
              throw new Error(`The selected platform changed during ${label} setup readiness.`);
            // App-target Sessions can trigger the Adapter's existing automatic App fallback.
            // Do not enter that recovery path from a readiness observation.
            const native = adapter as {
              appTarget?: Readonly<NativeAppTarget>;
              runtime?: { isRunning: boolean; currentApp?: NativeAppTarget };
              sessionHints?: Readonly<NativeEnvironment>;
            };
            if (
              (native.appTarget && Object.keys(native.appTarget).length > 0) ||
              (native.runtime?.isRunning &&
                native.runtime.currentApp &&
                Object.keys(native.runtime.currentApp).length > 0)
            )
              throw new Error(
                `${label} setup readiness requires a base Session without a legacy App target. Call configureSession({clearAppTarget:true}), then retry ready; or use explicit exploration for that App.`,
              );
            const hints = native.sessionHints;
            if (
              snapshot.technicalDetails?.serverScope === 'local' &&
              !hints?.device &&
              hints?.capabilities['appium:deviceName'] &&
              !isMigratedLocalPhysicalRoute(adapter)
            )
              throw new Error(
                `${label} setup readiness requires a stable device selector for local deviceName routing.`,
              );
            if (!adapter.executeReadiness)
              throw new Error(
                `${adapter.id === 'ios' ? 'IOS' : 'ANDROID'}_READINESS_UNLOCK_UNSAFE: this adapter cannot observe readiness without automatic unlock.`,
              );
            let observations;
            try {
              observations = await adapter.executeReadiness(
                nativeReadinessCode(adapter.id as 'android' | 'ios', input.screenshot === true),
                jobSignal,
                {
                  allowWdaInitialization: input.allowWdaInitialization,
                  allowWdaInstallation: input.allowWdaInstallation,
                  screenshot: input.screenshot,
                },
              );
              if (!(adapter instanceof AppiumPlatformAdapter))
                observations = validateReadinessObservations(
                  observations,
                  label,
                  input.screenshot === true,
                );
            } catch (error) {
              if (hasErrorCode(error, 'phone-session-creation-uncertain')) throw error;
              if (!connectionJobOwner && input.signal?.aborted)
                throw safeReadinessError(`${label} setup readiness cancelled`, error);
              if (jobSignal.aborted)
                throw safeReadinessError(`${label} setup readiness timed out`, error);
              if (adapter.id === 'ios' && iosWdaSecurityRejection(error))
                throw safeReadinessError(
                  'IOS_WDA_SECURITY_REJECTED: iOS refused WDA because its signature, entitlements or developer-profile trust are not accepted. Ask the user to check developer App trust; if already trusted, inspect signing. Do not blindly retry, reinstall or change signing.',
                  error,
                );
              throw safeReadinessError(`${label} setup readiness observation failed`, error);
            }
            const screenshotReadable = observations.some(
              (observation) => observation.type === 'image',
            );
            return {
              platform,
              ready: true,
              ...(targetSelection
                ? {
                    targetSelection: {
                      selectedBy: targetSelection.selectedBy,
                      candidate: targetSelection.candidate,
                    },
                  }
                : {}),
              proof: {
                phoneUnlocked: true,
                sessionUsable: true,
                sourceReadable: true,
                viewportReadable: true,
                screenshotReadable,
              },
              observations,
            };
          },
          () => isMigratedLocalPhysicalRoute(adapter),
          connectionJobOwner,
        );
      if (isMigratedLocalPhysicalRoute(adapter))
        return this.connectionJobs.start(
          this.#connectionJobCaller,
          (jobSignal, owner) => execute(jobSignal, owner),
          {
            waitSeconds: request.waitSeconds,
            signal: input.signal,
            deadlineMs: adapter.id === 'ios' ? 180_000 : 15_000,
          },
        );
      return execute(signal);
    },
    action: (actionId?: SetupAction['id']) => this.setupAssistant.action(actionId),
    skip: (capabilityId: SetupCapabilityId) => this.setupAssistant.skip(capabilityId),
    interrupt: (input: Parameters<SetupAssistant['interrupt']>[0]) =>
      this.setupAssistant.interrupt(input),
    pendingInterruption: () => this.setupAssistant.pendingInterruption(),
    resume: () => this.setupAssistant.resume(),
  };

  readonly exploration = {
    executeJavaScript: (code: string, signal?: AbortSignal) => {
      const adapter = this.registry.current;
      if (!isMobilePlatform(adapter.id)) return adapter.execute(code, signal);
      assertDeviceLockReleaseCertain();
      return runMobileOperation(
        () => adapter.execute(code, signal),
        () => isMigratedLocalPhysicalRoute(adapter),
      );
    },
    context: () => this.registry.current.codeContext,
  };

  close(): Promise<void> {
    const adapters = this.registry.list();
    if (!adapters.some((adapter) => isMobilePlatform(adapter.id))) return this.registry.close();
    try {
      assertDeviceLockReleaseCertain();
    } catch (error) {
      return Promise.reject(error);
    }
    return runMobileOperation(
      () => this.registry.close(),
      () => adapters.some(isMigratedLocalPhysicalRoute),
    );
  }
}
