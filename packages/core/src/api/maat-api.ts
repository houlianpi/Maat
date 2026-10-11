import type { SessionSetup, SetupInspection } from '../core/platforms/contracts.ts';
import { PlatformRegistry } from '../core/platforms/registry.ts';
import { SetupAssistant, type SetupAssistantOptions } from '../setup-assistant/setup-assistant.ts';
import type {
  SetupCapabilityId,
  SetupAction,
  AndroidSetupCheckInput,
  SetupReadiness,
} from '../setup-assistant/types.ts';
import { sameFingerprint } from '../setup-assistant/storage.ts';
import type { NativeAppTarget, NativeEnvironment } from '../platforms/appium/schema.ts';
import { isRecord, parseObservations } from '../core/exploration/protocol.ts';
import { androidLockGuardCode } from '../platforms/appium/runtime/session.ts';

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
    .split('\n')[0]!
    .slice(0, 1_000);
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

  readonly setup = {
    current: () => this.setupAssistant.current(),
    check: async (input: AndroidSetupCheckInput & { platform?: string } = {}) => {
      const previous = this.setupAssistant.current();
      const platform = input.platform ?? this.registry.current.id;
      const adapter = this.registry.get(platform) as
        | { sessionHints?: Readonly<NativeEnvironment>; initialize(): Promise<void> }
        | undefined;
      if (platform === 'android') {
        input.signal?.throwIfAborted();
        await adapter?.initialize();
        input.signal?.throwIfAborted();
      }
      const hints = platform === 'android' ? adapter?.sessionHints : undefined;
      const snapshot = await this.setupAssistant.check({
        ...input,
        platform,
        ...(platform === 'android'
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
    ready: async (
      input: { screenshot?: boolean; signal?: AbortSignal } = {},
    ): Promise<SetupReadiness> => {
      const adapter = this.registry.current;
      if (adapter.id !== 'android')
        throw new Error(
          `Setup readiness is unsupported for ${adapter.id}; only Android is supported.`,
        );
      if (input.screenshot !== undefined && typeof input.screenshot !== 'boolean')
        throw new Error('Setup readiness screenshot must be a boolean.');
      const signal = AbortSignal.any([
        ...(input.signal ? [input.signal] : []),
        AbortSignal.timeout(15_000),
      ]);
      input.signal?.throwIfAborted();
      const snapshot = await this.setup.check({ platform: 'android', signal });
      signal.throwIfAborted();
      if (!snapshot.canContinue)
        throw new Error('Android setup readiness is blocked by doctor preparation checks.');
      if (this.registry.current !== adapter)
        throw new Error('The selected platform changed during Android setup readiness.');
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
          'Android setup readiness requires a base Session without a legacy App target. Call configureSession({clearAppTarget:true}), then retry ready; or use explicit exploration for that App.',
        );
      const hints = native.sessionHints;
      if (
        snapshot.technicalDetails?.serverScope === 'local' &&
        !hints?.device &&
        hints?.capabilities['appium:deviceName']
      )
        throw new Error(
          'Android setup readiness requires a stable device selector for local deviceName routing.',
        );
      if (!adapter.executeReadiness)
        throw new Error(
          'ANDROID_READINESS_UNLOCK_UNSAFE: this adapter cannot observe readiness without automatic unlock.',
        );
      const code = [
        androidLockGuardCode,
        'const source = await driver.getPageSource();',
        'if (typeof source !== "string" || !source.trim()) throw new Error("Android readiness: page source is empty.");',
        'const viewport = await driver.getWindowSize();',
        'if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error("Android readiness: viewport is invalid.");',
        ...(input.screenshot ? ['await evidence.screenshot();'] : []),
        // Catch a lock/screen-off transition while source/image were being read, without retry.
        androidLockGuardCode,
        'console.log(JSON.stringify({maatSetupReadiness: 1, phoneUnlocked: true, sessionUsable: true, sourceReadable: true, viewportReadable: true, source, viewport: {width: viewport.width, height: viewport.height}}));',
      ].join('\n');
      let observations;
      try {
        observations = parseObservations(await adapter.executeReadiness(code, signal));
        signal.throwIfAborted();
      } catch (error) {
        // Preserve the execution error (including any cleanup failure) on cancellation.
        if (input.signal?.aborted)
          throw new Error(`Android setup readiness cancelled: ${readinessErrorSummary(error)}`, {
            cause: error,
          });
        if (signal.aborted)
          throw new Error(`Android setup readiness timed out: ${readinessErrorSummary(error)}`, {
            cause: error,
          });
        throw new Error(
          `Android setup readiness observation failed: ${readinessErrorSummary(error)}`,
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
          'Android setup readiness did not return phoneUnlocked:true, nonempty source and valid viewport observation.',
        );
      const screenshotReadable = observations.some((observation) => observation.type === 'image');
      if (input.screenshot && !screenshotReadable)
        throw new Error('Android setup readiness did not return a screenshot observation.');
      return {
        platform: 'android',
        ready: true,
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
    },
    action: (actionId?: SetupAction['id']) => this.setupAssistant.action(actionId),
    skip: (capabilityId: SetupCapabilityId) => this.setupAssistant.skip(capabilityId),
    interrupt: (input: Parameters<SetupAssistant['interrupt']>[0]) =>
      this.setupAssistant.interrupt(input),
    pendingInterruption: () => this.setupAssistant.pendingInterruption(),
    resume: () => this.setupAssistant.resume(),
  };

  readonly exploration = {
    executeJavaScript: (code: string, signal?: AbortSignal) =>
      this.registry.current.execute(code, signal),
    context: () => this.registry.current.codeContext,
  };

  close(): Promise<void> {
    return this.registry.close();
  }
}
