import { startNativeSession } from './session.ts';
import {
  capabilities,
  type NativeAppTarget,
  type NativeEnvironment,
  type ResolvedNativeSession,
} from '../schema.ts';
import { resolveDevice } from '../../../setup/devices.ts';
import type { JavaScriptSession } from '../../../core/exploration/runtime.ts';
import { errorWithCleanupFailure } from '../../../core/exploration/runtime.ts';

export class NativeManager implements JavaScriptSession {
  private readonly executionTimeoutMs: number;
  constructor(executionTimeoutMs = 60_000) {
    this.executionTimeoutMs = executionTimeoutMs;
  }
  private session?: JavaScriptSession;
  private sessionGeneration = 0;
  private environment?: NativeEnvironment;
  private app?: NativeAppTarget;
  private resolved?: ResolvedNativeSession;
  private busy = false;
  get currentEnvironment() {
    return this.environment;
  }
  get currentApp() {
    return this.app;
  }
  get currentTarget(): ResolvedNativeSession | undefined {
    if (this.resolved) return { ...this.resolved, app: this.app };
    return this.environment
      ? {
          environment: this.environment,
          capabilities: { ...this.environment.capabilities },
          app: this.app,
        }
      : undefined;
  }
  get isRunning() {
    return this.session !== undefined && !this.session.isClosed;
  }
  get currentSessionGeneration(): number | undefined {
    return this.isRunning ? this.sessionGeneration : undefined;
  }
  async configure(environment: NativeEnvironment, app?: NativeAppTarget) {
    capabilities(environment);
    await this.close();
    this.environment = environment;
    this.app = app;
    this.resolved = undefined;
  }
  async configureResolved(resolved: ResolvedNativeSession) {
    capabilities(resolved);
    await this.close();
    this.environment = resolved.environment;
    this.app = resolved.app;
    this.resolved = resolved;
  }
  async execute(code: string, signal?: AbortSignal) {
    return this.executeSession(code, signal);
  }
  async executeExisting(code: string, generation: number, signal?: AbortSignal) {
    return this.executeSession(code, signal, generation);
  }
  private async executeSession(code: string, signal?: AbortSignal, generation?: number) {
    if (this.busy) throw new Error('Native execution already in progress.');
    signal?.throwIfAborted();
    if (!this.environment) throw new Error('Select and configure a native project first.');
    this.busy = true;
    try {
      if (generation !== undefined && (!this.isRunning || this.sessionGeneration !== generation))
        throw new Error(
          'NATIVE_SESSION_CHANGED: the checked Session was closed or replaced; no new Session was created.',
        );
      if (generation === undefined && this.session?.isClosed) await this.close();
      if (generation === undefined && !this.session) {
        this.resolved ??= { ...(await resolveDevice(this.environment, signal)), app: this.app };
        signal?.throwIfAborted();
        this.session = await startNativeSession(this.resolved, this.executionTimeoutMs, { signal });
        this.sessionGeneration++;
      }
      signal?.throwIfAborted();
      return await this.session!.execute(code, signal);
    } catch (error) {
      if (signal?.aborted || this.session?.isClosed) {
        try {
          await this.close();
        } catch (cleanup) {
          throw errorWithCleanupFailure(error, cleanup);
        }
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async close() {
    const current = this.session;
    this.session = undefined;
    await current?.close();
  }
}
