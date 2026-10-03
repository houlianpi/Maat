import { startNativeSession } from './session.ts';
import { capabilities, type NativeAppTarget, type NativeEnvironment, type ResolvedNativeSession } from '../schema.ts';
import { resolveDevice } from '../../../setup/devices.ts';
import type { JavaScriptSession } from '../../../worker/javascript-session.ts';

export class NativeManager implements JavaScriptSession {
  private session?: JavaScriptSession;
  private environment?: NativeEnvironment;
  private app?: NativeAppTarget;
  private resolved?: ResolvedNativeSession;
  private busy = false;
  get currentEnvironment() { return this.environment; }
  get currentApp() { return this.app; }
  get currentTarget(): ResolvedNativeSession | undefined {
    if (this.resolved) return { ...this.resolved, app: this.app };
    return this.environment ? { environment: this.environment, capabilities: { ...this.environment.capabilities }, app: this.app } : undefined;
  }
  get isRunning() { return this.session !== undefined; }
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
    if (this.busy) throw new Error('Native execution already in progress.');
    signal?.throwIfAborted();
    if (!this.environment) throw new Error('Select and configure a native project first.');
    this.busy = true;
    try {
      if (!this.session) {
        this.resolved ??= { ...(await resolveDevice(this.environment)), app: this.app };
        this.session = await startNativeSession(this.resolved);
      }
      if (signal?.aborted) { await this.close(); signal.throwIfAborted(); }
      return await this.session!.execute(code, signal);
    } catch (error) {
      if (signal?.aborted || /timed out|worker exited|session closed/.test(String(error))) await this.close();
      throw error;
    } finally { this.busy = false; }
  }
  async close() {
    const current = this.session; this.session = undefined; await current?.close();
  }
}
