import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  readNativeEnvironment,
  splitCapabilities,
  type NativeAppTarget,
  type NativeEnvironment,
  type NativePlatform,
} from './schema.ts';
import { NativeManager } from './runtime/manager.ts';
import type { PlatformAdapter } from '../../core/platforms/contracts.ts';
import { resolveAppiumSession } from './session-resolver.ts';
import { discoverDevices } from '../../setup/devices.ts';
import { discoverApplications } from '../../setup/applications.ts';
import type {
  RuntimeRequirement,
  SessionSetup,
  SetupInspection,
} from '../../core/platforms/contracts.ts';
import { createAppiumTestSession } from './test-session.ts';

export type AppiumAdapterDefinition = {
  id: NativePlatform;
  label: string;
  platformName: string;
  automationName: string;
};

export class AppiumPlatformAdapter implements PlatformAdapter {
  readonly id: NativePlatform;
  readonly root: string;
  readonly label: string;
  readonly codeContext = {
    language: 'javascript' as const,
    globals: [
      { name: 'driver', description: 'WebdriverIO client attached to the Appium Session' },
      { name: 'browser', description: 'Alias of driver' },
      { name: 'expect', description: 'expect-webdriverio' },
      {
        name: 'app',
        description: 'Runtime App target with id and package-aware resourceId(name)',
      },
      { name: 'display', description: 'Return screenshot Evidence' },
    ],
    guidelines: [
      'Use WebdriverIO APIs.',
      'Use app.resourceId(name) for Android resource IDs; never hardcode an App package prefix.',
      'Await every operation.',
      'Assert only explicit test objectives.',
    ],
  };
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

  constructor(definition: AppiumAdapterDefinition, root: string) {
    this.definition = definition;
    this.id = definition.id;
    this.root = root;
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
    const split = splitCapabilities(input.capabilities ?? {});
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
    this.environment = {
      platform: this.id,
      serverUrl: input.serverUrl ?? base.serverUrl,
      device: (input.device as NativeEnvironment['device']) ?? base.device,
      capabilities: { ...base.capabilities, ...split.environment },
    };
    this.app = Object.keys(split.app).length ? split.app : this.app;
    this.issue = undefined;
    await this.runtime.close();
  }

  async inspectSetup(request: SetupInspection): Promise<unknown> {
    if (request.kind === 'devices') return discoverDevices(this.id);
    if (!this.environment) await this.initialize();
    return discoverApplications(this.environment!, request.query ?? '');
  }

  private async prepare(): Promise<void> {
    if (!this.environment) await this.initialize();
    try {
      const resolved = await resolveAppiumSession(this.environment!);
      const definition = this.definition;
      await this.runtime.configureResolved({
        ...resolved,
        app: this.app,
        capabilities: {
          ...resolved.capabilities,
          platformName: definition.platformName,
          'appium:automationName': definition.automationName,
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

  async execute(code: string, signal?: AbortSignal) {
    if (!this.runtime.isRunning) await this.prepare();
    let observations;
    try {
      observations = await this.runtime.execute(code, signal);
    } catch (error) {
      if (
        !this.runtime.isRunning &&
        this.app &&
        Object.keys(this.app).length > 0 &&
        /app|bundle|package|activity/i.test(String(error))
      ) {
        const rejected = JSON.stringify(this.app);
        this.app = undefined;
        await this.runtime.close();
        await this.prepare();
        observations = await this.runtime.execute(code, signal);
        this.notices.push(
          `The configured App target ${rejected} could not create a Session. Maat created a base Session without it; discover or provide the App before saving.`,
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

  runtimeRequirement(): RuntimeRequirement {
    return { adapterId: this.id, ...(this.app ? { setup: { app: this.app } } : {}) };
  }
  async createTestSession(requirement = this.runtimeRequirement()) {
    if (!this.environment) await this.initialize();
    const resolved = await resolveAppiumSession(this.environment!);
    const definition = this.definition;
    const declaredApp = requirement.setup?.app;
    const runtimeAppId = process.env.MAAT_APP_ID?.trim();
    const app =
      declaredApp === 'runtime'
        ? runtimeAppId
          ? this.id === 'android'
            ? ({ 'appium:appPackage': runtimeAppId } satisfies NativeAppTarget)
            : ({ 'appium:bundleId': runtimeAppId } satisfies NativeAppTarget)
          : undefined
        : (declaredApp as NativeAppTarget | undefined);
    if (declaredApp === 'runtime' && !app) {
      throw new Error(
        `Case requires a runtime App target. Pass --app-id for ${this.label} or set MAAT_APP_ID.`,
      );
    }
    return createAppiumTestSession(
      {
        ...resolved,
        capabilities: {
          ...resolved.capabilities,
          platformName: definition.platformName,
          'appium:automationName': definition.automationName,
        },
      },
      app,
    );
  }

  status() {
    return {
      id: this.id,
      label: this.label,
      root: this.root,
      session: this.runtime.isRunning ? ('ready' as const) : ('idle' as const),
      detail: this.issue ?? this.environment?.device?.name ?? 'device auto',
    };
  }
  async close() {
    await this.runtime.close();
  }
}
