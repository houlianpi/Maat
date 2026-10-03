import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readNativeEnvironment, splitCapabilities, type NativeAppTarget, type NativeEnvironment, type NativePlatform } from './schema.ts';
import { NativeManager } from './runtime/manager.ts';
import type { PlatformAdapter } from '../contracts.ts';
import { resolveAppiumSession } from './session-resolver.ts';
import { discoverDevices } from '../../setup/devices.ts';
import { discoverApplications } from '../../setup/applications.ts';
import type { RuntimeRequirement, SessionSetup, SetupInspection } from '../contracts.ts';
import { createAppiumTestSession } from './test-session.ts';

export type AppiumAdapterDefinition = { id: NativePlatform; label: string; platformName: string; automationName: string };

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
      { name: 'display', description: 'Return screenshot Evidence' },
    ],
    guidelines: ['Use WebdriverIO APIs.', 'Await every operation.', 'Assert only explicit test objectives.'],
  };
  readonly runtime = new NativeManager();
  private environment?: NativeEnvironment;
  private app?: NativeAppTarget;
  private issue?: string;
  private notices: string[] = [];
  private readonly definition: AppiumAdapterDefinition;
  private initialized = false;

  constructor(definition: AppiumAdapterDefinition, root: string) { this.definition = definition; this.id = definition.id; this.root = root; this.label = definition.label; }
  get sessionHints(): Readonly<NativeEnvironment> | undefined { return this.environment; }
  get appTarget(): Readonly<NativeAppTarget> | undefined { return this.app; }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const file = path.join(this.root, 'native-target.local.json');
    this.environment = await readNativeEnvironment(file).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { platform: this.id, capabilities: {} };
    });
    if (this.environment.platform !== this.id) throw new Error(`Environment platform must be ${this.id}.`);
    await mkdir(path.join(this.root, 'cases'), { recursive: true });
    this.initialized = true;
  }

  async configureSession(input: SessionSetup): Promise<void> {
    const split = splitCapabilities(input.capabilities ?? {});
    if ((split.environment['appium:noReset'] === false || split.environment['appium:fullReset'] === true) && !input.allowDataReset) {
      throw new Error('Clearing app data requires explicit user intent and allowDataReset=true.');
    }
    delete split.environment.platformName;
    delete split.environment['appium:automationName'];
    const base = this.environment ?? { platform: this.id, capabilities: {} };
    this.environment = { platform: this.id, serverUrl: input.serverUrl ?? base.serverUrl, device: input.device as NativeEnvironment['device'] ?? base.device, capabilities: { ...base.capabilities, ...split.environment } };
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
      await this.runtime.configureResolved({ ...resolved, app: this.app, capabilities: { ...resolved.capabilities, platformName: definition.platformName, 'appium:automationName': definition.automationName } });
      this.environment = resolved.environment;
      this.notices = resolved.notices ?? [];
      this.issue = undefined;
    } catch (error) { this.issue = error instanceof Error ? error.message : String(error); throw error; }
  }

  async execute(code: string, signal?: AbortSignal) {
    if (!this.runtime.isRunning) await this.prepare();
    let observations;
    try { observations = await this.runtime.execute(code, signal); }
    catch (error) {
      if (!this.runtime.isRunning && this.app && Object.keys(this.app).length > 0 && /app|bundle|package|activity/i.test(String(error))) {
        const rejected = JSON.stringify(this.app);
        this.app = undefined;
        await this.runtime.close();
        await this.prepare();
        observations = await this.runtime.execute(code, signal);
        this.notices.push(`The configured App target ${rejected} could not create a Session. Maat created a base Session without it; discover or provide the App before saving.`);
      } else throw error;
    }
    // A successful Session confirms stable hints; transient UUID/App data never enter environment.
    await writeFile(path.join(this.root, 'native-target.local.json'), JSON.stringify(this.environment, null, 2) + '\n', { mode: 0o600 });
    const notices = this.notices.splice(0);
    return notices.length ? [{ type: 'text' as const, text: notices.join('\n') }, ...observations] : observations;
  }

  runtimeRequirement(): RuntimeRequirement { return { adapterId: this.id, ...(this.app ? { setup: { app: this.app } } : {}) }; }
  async createTestSession(requirement = this.runtimeRequirement()) {
    if (!this.environment) await this.initialize();
    const resolved = await resolveAppiumSession(this.environment!);
    const definition = this.definition;
    const app = requirement.setup?.app as NativeAppTarget | undefined;
    return createAppiumTestSession({ ...resolved, capabilities: { ...resolved.capabilities, platformName: definition.platformName, 'appium:automationName': definition.automationName } }, app);
  }

  status() { return { id: this.id, label: this.label, root: this.root, session: this.runtime.isRunning ? 'ready' as const : 'idle' as const, detail: this.issue ?? this.environment?.device?.name ?? 'device auto' }; }
  async close() { await this.runtime.close(); }
}
