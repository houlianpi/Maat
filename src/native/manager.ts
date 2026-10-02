import { startNativeSession } from './session.ts';
import { capabilities, type NativeTarget } from './config.ts';
import { selectDevice } from './devices.ts';
import type { JavaScriptSession } from '../worker/javascript-session.ts';

export class NativeManager implements JavaScriptSession {
  private session?: JavaScriptSession;
  private target?: NativeTarget;
  private busy = false;
  get currentTarget() { return this.target; }
  get isRunning() { return this.session !== undefined; }
  async configure(target: NativeTarget) {
    capabilities(target);
    await this.close();
    this.target = target;
  }
  async execute(code: string, signal?: AbortSignal) {
    if (this.busy) throw new Error('Native execution already in progress.');
    signal?.throwIfAborted();
    if (!this.target) throw new Error('Select and configure a native project first.');
    this.busy = true;
    try {
      if (!this.session) {
        this.target = await selectDevice(this.target);
        this.session = await startNativeSession(this.target);
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
