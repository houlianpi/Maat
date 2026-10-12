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
import { NativeManager } from './runtime/manager.ts';
import { NativeInitializationCancelledError } from './runtime/session.ts';
import { WorkerTerminatedError } from '../../core/exploration/runtime.ts';
import { isRecord } from '../../core/exploration/protocol.ts';
import type { PlatformAdapter } from '../../core/platforms/contracts.ts';
import {
  resolveAppiumSession,
  resolveAndroidReadinessSession,
  resolveIosReadinessSession,
  isLocalAppiumEndpoint,
} from './session-resolver.ts';
import { discoverDevices } from '../../setup/devices.ts';
import { discoverApplications } from '../../setup/applications.ts';
import type { SessionSetup, SetupInspection } from '../../core/platforms/contracts.ts';

export type AppiumAdapterDefinition = {
  id: NativePlatform;
  label: string;
  platformName: string;
  automationName: string;
};

export class AppiumPlatformAdapter implements PlatformAdapter {
  readonly id: NativePlatform;
  readonly label: string;
  get codeContext() {
    const target = this.runtime.isRunning ? this.runtime.currentApp : this.app;
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
  readonly runtime = new NativeManager();
  private environment?: NativeEnvironment;
  private app?: NativeAppTarget;
  private issue?: string;
  private notices: string[] = [];
  private readonly definition: AppiumAdapterDefinition;
  private initialized = false;
  private get hintsFile(): string {
    const directory =
      process.env.MAAT_SESSION_HINTS_DIR ?? path.join(homedir(), '.maat', 'session-hints');
    return path.join(directory, `${this.id}.json`);
  }

  constructor(definition: AppiumAdapterDefinition) {
    this.definition = definition;
    this.id = definition.id;
    this.label = definition.label;
  }
  get sessionHints(): Readonly<NativeEnvironment> | undefined {
    return this.environment;
  }
  get appTarget(): Readonly<NativeAppTarget> | undefined {
    return this.app;
  }

  async initialize(): Promise<void> {
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
    this.environment = nextEnvironment;
    this.app = nextApp;
    this.issue = undefined;
    await this.runtime.close();
  }

  async inspectSetup(request: SetupInspection): Promise<unknown> {
    if (request.kind === 'devices') return discoverDevices(this.id);
    if (!this.environment) await this.initialize();
    const apps = await discoverApplications(this.environment!, request.query ?? '');
    const appCapability = this.id === 'android' ? 'appium:appPackage' : 'appium:bundleId';
    return apps.map((app) => ({ ...app, capabilities: { [appCapability]: app.id } }));
  }

  private async prepare(
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
      let resolved = safeIos
        ? await this.resolveIosReadiness(signal, undefined, allowWdaInstallation)
        : safeAndroid
          ? await this.resolveReadiness(signal)
          : await resolveAppiumSession(this.environment!, undefined, signal);
      if (
        this.id === 'ios' &&
        !safeIos &&
        resolved.environment.device?.kind === 'device' &&
        isLocalAppiumEndpoint(resolved.environment.serverUrl!)
      )
        resolved = await this.resolveIosReadiness(signal, undefined, allowWdaInstallation);
      signal?.throwIfAborted();
      const definition = this.definition;
      await this.runtime.configureResolved({
        ...resolved,
        app: this.app,
        capabilities: {
          ...resolved.capabilities,
          platformName: definition.platformName,
          'appium:automationName': definition.automationName,
          ...(safeAndroid ? { 'appium:skipUnlock': true } : {}),
        },
      });
      this.environment = resolved.environment;
      this.notices = resolved.notices ?? [];
      this.issue = undefined;
    } catch (error) {
      this.issue = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  protected resolveReadiness(signal?: AbortSignal) {
    return resolveAndroidReadinessSession(this.environment!, signal);
  }

  protected resolveIosReadiness(
    signal?: AbortSignal,
    currentTarget?: ResolvedNativeSession,
    allowWdaInstallation = false,
  ) {
    return resolveIosReadinessSession(
      this.environment!,
      signal,
      undefined,
      currentTarget,
      allowWdaInstallation,
    );
  }

  async executeReadiness(
    code: string,
    signal?: AbortSignal,
    readinessOptions: { allowWdaInitialization?: boolean; allowWdaInstallation?: boolean } = {},
  ) {
    if (this.id !== 'android' && this.id !== 'ios')
      throw new Error('Only Android and iOS support setup readiness.');
    signal?.throwIfAborted();
    if (!this.environment) await this.initialize();
    const options = this.environment!.capabilities['appium:options'];
    if (
      (this.app && Object.keys(this.app).length > 0) ||
      (isRecord(options) &&
        ['app', 'appPackage', 'appActivity', 'bundleId'].some(
          (key) => options[key] !== undefined || options[`appium:${key}`] !== undefined,
        )) ||
      (this.runtime.isRunning &&
        this.runtime.currentApp &&
        Object.keys(this.runtime.currentApp).length > 0)
    )
      throw new Error(
        `${this.label} setup readiness requires a base Session without an App target.`,
      );
    if (this.id === 'android') await this.prepareAndroidExecution(signal);
    else if (!this.runtime.isRunning) {
      if (readinessOptions.allowWdaInitialization === false)
        throw new Error(
          'IOS_CONNECTION_INITIALIZATION_DISABLED: this caller requested an existing Session only; no new Session was created.',
        );
      await this.prepare(signal, true, readinessOptions.allowWdaInstallation);
    } else {
      const generation = this.runtime.currentSessionGeneration;
      const target = this.runtime.currentTarget;
      if (!target || generation === undefined)
        throw new Error(
          'IOS_READINESS_UNSUPPORTED: the running Session has no provable device routing.',
        );
      await this.resolveIosReadiness(signal, target);
      return this.executePrepared(code, signal, false, generation);
    }
    return this.executePrepared(code, signal, false);
  }

  private async prepareAndroidExecution(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.environment) await this.initialize();
    signal?.throwIfAborted();
    if (!this.runtime.isRunning) {
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
      await this.prepare(signal);
    }
  }

  async execute(code: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.id === 'android') {
      const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]);
      await this.prepareAndroidExecution(bounded);
      return this.executePrepared(code, bounded);
    }
    if (!this.runtime.isRunning) await this.prepare(signal);
    return this.executePrepared(code, signal);
  }

  private async executePrepared(
    code: string,
    signal?: AbortSignal,
    allowAppFallback = true,
    sessionGeneration?: number,
  ) {
    let observations;
    try {
      observations =
        sessionGeneration === undefined
          ? await this.runtime.execute(code, signal)
          : await this.runtime.executeExisting(code, sessionGeneration, signal);
    } catch (error) {
      if (
        allowAppFallback &&
        // The legacy macOS backend may retry Session creation without an App target.
        // Mobile JavaScript can already have dispatched and must never be replayed.
        this.id === 'macos' &&
        !this.runtime.isRunning &&
        !signal?.aborted &&
        !(error instanceof WorkerTerminatedError) &&
        !(error instanceof NativeInitializationCancelledError) &&
        !(error instanceof AggregateError) &&
        this.app &&
        Object.keys(this.app).length > 0 &&
        /app|bundle|package|activity/i.test(String(error))
      ) {
        const rejected = JSON.stringify(this.app);
        this.app = undefined;
        await this.runtime.close();
        await this.prepare(signal);
        observations = await this.runtime.execute(code, signal);
        this.notices.push(
          `The configured App target ${rejected} could not create a Session. Maat created a base Session without it; discover or provide the App before further execution.`,
        );
      } else throw error;
    }
    // A successful Session confirms stable hints; transient UUID/App data never enter environment.
    await mkdir(path.dirname(this.hintsFile), { recursive: true });
    await writeFile(this.hintsFile, JSON.stringify(this.environment, null, 2) + '\n', {
      mode: 0o600,
    });
    const notices = this.notices.splice(0);
    return notices.length
      ? [{ type: 'text' as const, text: notices.join('\n') }, ...observations]
      : observations;
  }

  status() {
    return {
      id: this.id,
      label: this.label,
      session: this.runtime.isRunning ? ('ready' as const) : ('idle' as const),
      detail: this.issue ?? this.environment?.device?.name ?? 'device auto',
    };
  }
  async close() {
    await this.runtime.close();
  }
}
