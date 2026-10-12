import type { SessionSetup, SetupInspection } from '../core/platforms/contracts.ts';
import { PlatformRegistry } from '../core/platforms/registry.ts';
import { SetupAssistant, type SetupAssistantOptions } from '../setup-assistant/setup-assistant.ts';
import type {
  SetupCapabilityId,
  SetupAction,
  AndroidSetupCheckInput,
  SetupReadiness,
  SetupReadyInput,
} from '../setup-assistant/types.ts';
import { sameFingerprint } from '../setup-assistant/storage.ts';
import type { NativeAppTarget, NativeEnvironment } from '../platforms/appium/schema.ts';
import { isRecord, parseObservations } from '../core/exploration/protocol.ts';
import { androidLockGuardCode, iosLockGuardCode } from '../platforms/appium/runtime/session.ts';
import { isMobilePlatform, runMobileOperation } from '../mobile/devices/coordinator.ts';

type MigratedRouteAdapter = {
  isMigratedLocalPhysicalRoute(): boolean;
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

function readinessErrorSummary(error: unknown, depth = 0): string {
  if (error instanceof AggregateError && depth < 3) {
    return error.errors
      .slice(0, 3)
      .map((failure) => readinessErrorSummary(failure, depth + 1))
      .join('; Owned Session cleanup also failed: ')
      .slice(0, 1_000);
  }
  const message =
    isRecord(error) && typeof error.message === 'string' ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[endpoint]')
    .replace(/(?:\/(?:Users|home|private|tmp|var)\/|[A-Za-z]:\\)[^\s"'<>]+/g, '[path]')
    .replace(
      /\b(password|secret|token|authorization|api[-_]?key|udid|serial)\s*[:=]\s*\S+/gi,
      '$1=[redacted]',
    )
    .replace(
      /\b(?:[A-Fa-f0-9]{8}-[A-Fa-f0-9]{16}|[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}|[A-Fa-f0-9]{40})\b/g,
      '[device-id]',
    )
    .split('\n')[0]!
    .slice(0, 1_000);
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

/** Stable, host-neutral product API. Agent hosts translate this API into their own tools and UI. */
export class MaatApi {
  readonly workspaceRoot: string;
  readonly registry: PlatformRegistry;
  readonly setupAssistant: SetupAssistant;

  constructor(
    registry: PlatformRegistry,
    workspaceRoot: string,
    setupOptions?: SetupAssistantOptions,
  ) {
    this.registry = registry;
    this.workspaceRoot = workspaceRoot;
    this.setupAssistant = new SetupAssistant(setupOptions);
  }

  readonly platforms = {
    current: () => this.registry.current,
    list: () => this.registry.list(),
    select: async (id: string) => {
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
    },
    status: () => this.registry.current.status(),
    configure: async (configuration: Record<string, unknown>) => {
      const adapter = this.registry.current;
      if (!adapter.configure) throw new Error(`${adapter.label} is not configurable.`);
      return adapter.configure(configuration);
    },
    configureSession: async (setup: SessionSetup) => {
      const adapter = this.registry.current;
      if (!adapter.configureSession) {
        throw new Error(`${adapter.label} does not accept Session hints.`);
      }
      if (isMobilePlatform(adapter.id))
        return runMobileOperation(
          () => adapter.configureSession!(setup),
          () => isMigratedLocalPhysicalRoute(adapter),
        );
      await adapter.configureSession(setup);
    },
    inspectSetup: async (request: SetupInspection) => {
      const adapter = this.registry.current;
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
      const adapter = this.registry.current;
      return runMobileOperation(
        async () => {
          if (!isMobilePlatform(adapter.id))
            throw new Error('releaseCurrentSession requires the Android or iOS platform.');
          await adapter.close();
          return { released: true, platform: adapter.id };
        },
        () => isMigratedLocalPhysicalRoute(adapter),
      );
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
      const adapter = this.registry.current;
      if (adapter.id !== 'android' && adapter.id !== 'ios')
        throw new Error(
          `Setup readiness is unsupported for ${adapter.id}; only Android and iOS are supported.`,
        );
      const platform = adapter.id;
      // Keep the established readiness flow together while the outer operation owns the slot.
      // prettier-ignore
      return runMobileOperation(async () => {
      if (
        input.targetSelection !== undefined &&
        (!isRecord(input.targetSelection) ||
          typeof input.targetSelection.discoveryId !== 'string' ||
          !Number.isSafeInteger(input.targetSelection.candidateNumber) ||
          typeof input.targetSelection.candidateNumber !== 'number')
      )
        throw new Error('Target selection requires a string discoveryId and integer candidateNumber.');
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
      input.signal?.throwIfAborted();
      const label = adapter.label;
      const targetSelection = await adapter.selectReadinessTarget?.(
        input.targetSelection,
        signal,
      );
      signal.throwIfAborted();
      if (targetSelection && targetSelection.status !== 'selected')
        return {
          ...targetSelection,
          ready: false as const,
        };
      const snapshot = await this.setup.check({ platform: adapter.id, signal });
      signal.throwIfAborted();
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
        hints?.capabilities['appium:deviceName']
      )
        throw new Error(
          `${label} setup readiness requires a stable device selector for local deviceName routing.`,
        );
      if (!adapter.executeReadiness)
        throw new Error(
          `${adapter.id === 'ios' ? 'IOS' : 'ANDROID'}_READINESS_UNLOCK_UNSAFE: this adapter cannot observe readiness without automatic unlock.`,
        );
      const lockGuard = adapter.id === 'ios' ? iosLockGuardCode : androidLockGuardCode;
      const code = [
        lockGuard,
        'const source = await driver.getPageSource();',
        `if (typeof source !== "string" || !source.trim()) throw new Error("${label} readiness: page source is empty.");`,
        'const viewport = await driver.getWindowSize();',
        `if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error("${label} readiness: viewport is invalid.");`,
        ...(input.screenshot ? ['await evidence.screenshot();'] : []),
        // Catch a lock/screen-off transition while source/image were being read, without retry.
        lockGuard,
        'console.log(JSON.stringify({maatSetupReadiness: 1, phoneUnlocked: true, sessionUsable: true, sourceReadable: true, viewportReadable: true, source, viewport: {width: viewport.width, height: viewport.height}}));',
      ].join('\n');
      let observations;
      try {
        observations = parseObservations(
          await adapter.executeReadiness(code, signal, {
            allowWdaInitialization: input.allowWdaInitialization,
            allowWdaInstallation: input.allowWdaInstallation,
          }),
        );
        signal.throwIfAborted();
      } catch (error) {
        if (hasErrorCode(error, 'phone-session-creation-uncertain')) throw error;
        // Preserve the execution error (including any cleanup failure) on cancellation.
        if (input.signal?.aborted)
          throw new Error(`${label} setup readiness cancelled: ${readinessErrorSummary(error)}`, {
            cause: error,
          });
        if (signal.aborted)
          throw new Error(`${label} setup readiness timed out: ${readinessErrorSummary(error)}`, {
            cause: error,
          });
        if (adapter.id === 'ios' && iosWdaSecurityRejection(error))
          throw new Error(
            `IOS_WDA_SECURITY_REJECTED: iOS refused WDA because its signature, entitlements or developer-profile trust are not accepted. Ask the user to check developer App trust; if already trusted, inspect signing. Do not blindly retry, reinstall or change signing. Original failure: ${readinessErrorSummary(error)}`,
            { cause: error },
          );
        throw new Error(
          `${label} setup readiness observation failed: ${readinessErrorSummary(error)}`,
          { cause: error },
        );
      }
      const proof = observations.find((observation) => {
        if (observation.type !== 'text') return false;
        try {
          const value: unknown = JSON.parse(observation.text);
          return (
            typeof value === 'object' &&
            value !== null &&
            'maatSetupReadiness' in value &&
            value.maatSetupReadiness === 1 &&
            'phoneUnlocked' in value &&
            value.phoneUnlocked === true &&
            'sessionUsable' in value &&
            value.sessionUsable === true &&
            'sourceReadable' in value &&
            value.sourceReadable === true &&
            'viewportReadable' in value &&
            value.viewportReadable === true &&
            'source' in value &&
            typeof value.source === 'string' &&
            Boolean(value.source.trim()) &&
            'viewport' in value &&
            isRecord(value.viewport) &&
            typeof value.viewport.width === 'number' &&
            Number.isFinite(value.viewport.width) &&
            value.viewport.width > 0 &&
            typeof value.viewport.height === 'number' &&
            Number.isFinite(value.viewport.height) &&
            value.viewport.height > 0
          );
        } catch {
          return false;
        }
      });
      if (!proof)
        throw new Error(
          `${label} setup readiness did not return phoneUnlocked:true, nonempty source and valid viewport observation.`,
        );
      const screenshotReadable = observations.some((observation) => observation.type === 'image');
      if (input.screenshot && !screenshotReadable)
        throw new Error(`${label} setup readiness did not return a screenshot observation.`);
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
        observations: observations.filter(
          (observation) => observation === proof || observation.type === 'image',
        ),
      };
      }, () => isMigratedLocalPhysicalRoute(adapter));
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
      return isMobilePlatform(adapter.id)
        ? runMobileOperation(
            () => adapter.execute(code, signal),
            () => isMigratedLocalPhysicalRoute(adapter),
          )
        : adapter.execute(code, signal);
    },
    context: () => this.registry.current.codeContext,
  };

  close(): Promise<void> {
    const adapters = this.registry.list();
    return adapters.some((adapter) => isMobilePlatform(adapter.id))
      ? runMobileOperation(
          () => this.registry.close(),
          () => adapters.some(isMigratedLocalPhysicalRoute),
        )
      : this.registry.close();
  }
}
