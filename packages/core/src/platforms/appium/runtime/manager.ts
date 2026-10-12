import { startNativeSession } from './session.ts';
import { capabilities, type ResolvedNativeSession } from '../schema.ts';
import type { JavaScriptSession } from '../../../core/exploration/runtime.ts';
import { errorWithCleanupFailure } from '../../../core/exploration/runtime.ts';

export class NativeManager implements JavaScriptSession {
  private readonly executionTimeoutMs: number;
  constructor(executionTimeoutMs = 60_000) {
    this.executionTimeoutMs = executionTimeoutMs;
  }
  private session?: JavaScriptSession;
  private uncertainOwnership?: Readonly<{
    session: JavaScriptSession;
    closeResult: Promise<void>;
  }>;
  private sessionGeneration = 0;
  private resolved?: ResolvedNativeSession;
  private busy = false;
  get currentApp() {
    return this.resolved?.app;
  }
  get currentTarget(): ResolvedNativeSession | undefined {
    return this.resolved ? { ...this.resolved } : undefined;
  }
  get isRunning() {
    return this.session !== undefined && !this.session.isClosed;
  }
  /** Internal diagnostic state only; never exposes the owned Session or its identifiers. */
  get hasUncertainOwnedSession() {
    return this.uncertainOwnership !== undefined;
  }
  get currentSessionGeneration(): number | undefined {
    return this.isRunning ? this.sessionGeneration : undefined;
  }
  async configureResolved(resolved: ResolvedNativeSession) {
    capabilities(resolved);
    this.assertOwnershipCertain();
    await this.close();
    this.resolved = resolved;
  }
  async execute(code: string, signal?: AbortSignal) {
    return this.executeSession(code, signal);
  }
  async executeExisting(code: string, generation: number, signal?: AbortSignal) {
    return this.executeSession(code, signal, generation);
  }
  private async executeSession(code: string, signal?: AbortSignal, generation?: number) {
    this.assertOwnershipCertain();
    if (this.busy) throw new Error('Native execution already in progress.');
    signal?.throwIfAborted();
    if (!this.resolved) throw new Error('Select and configure a native project first.');
    this.busy = true;
    try {
      if (generation !== undefined && (!this.isRunning || this.sessionGeneration !== generation))
        throw new Error(
          'NATIVE_SESSION_CHANGED: the checked Session was closed or replaced; no new Session was created.',
        );
      if (generation === undefined && this.session?.isClosed) await this.invalidateSession();
      if (generation === undefined && !this.session) {
        signal?.throwIfAborted();
        this.session = await startNativeSession(this.resolved, this.executionTimeoutMs, { signal });
        this.sessionGeneration++;
      }
      signal?.throwIfAborted();
      return await this.session!.execute(code, signal);
    } catch (error) {
      if (signal?.aborted || this.session?.isClosed) {
        try {
          await this.invalidateSession();
        } catch (cleanup) {
          throw errorWithCleanupFailure(error, cleanup);
        }
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }
  private assertOwnershipCertain() {
    if (this.uncertainOwnership)
      throw new Error('Native Session ownership is uncertain after cleanup failure.');
  }
  private async invalidateSession() {
    const current = this.session;
    if (this.session === current) this.session = undefined;
    await current?.close();
  }
  async close() {
    if (this.uncertainOwnership) {
      await this.uncertainOwnership.closeResult;
      return;
    }
    const current = this.session;
    if (!current) return;
    // Explicit release immediately revokes execution, while retaining the exact ownership
    // and one-shot close result until cleanup is known to have succeeded.
    this.session = undefined;
    const ownership = Object.freeze({
      session: current,
      closeResult: Promise.resolve().then(() => current.close()),
    });
    this.uncertainOwnership = ownership;
    await ownership.closeResult;
    if (this.uncertainOwnership === ownership) this.uncertainOwnership = undefined;
  }
}
