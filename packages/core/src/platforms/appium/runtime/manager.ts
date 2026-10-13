import { NativeSessionCreationUncertainError, startNativeSession } from './session.ts';
import { capabilities, type ResolvedNativeSession } from '../schema.ts';
import type { JavaScriptSession } from '../../../core/exploration/runtime.ts';
import {
  errorWithCleanupFailure,
  ExplorationExecutionError,
  WorkerTerminatedError,
} from '../../../core/exploration/runtime.ts';
import { PhoneSessionCreationUncertainError } from '../../../mobile/contracts/device.ts';
import { sameDeviceIdentity, type DeviceIdentity } from '../../../mobile/contracts/device.ts';
import { installMobileCreationBarrier } from '../../../mobile/devices/coordinator.ts';

export type NativeLeaseContext = Readonly<{
  lifecycleToken: object;
  identity: DeviceIdentity;
  endpoint: string;
  backend: string;
}>;

type NativeSessionLease = NativeLeaseContext &
  Readonly<{
    generation: number;
    session: JavaScriptSession;
  }>;

type UncertainNativeOwnership = Readonly<{
  session: JavaScriptSession;
  closeResult: Promise<void>;
  cleanupFailure: { public?: Error };
}>;

export class NativeManager implements JavaScriptSession {
  readonly #executionTimeoutMs: number;
  constructor(executionTimeoutMs = 60_000) {
    this.#executionTimeoutMs = executionTimeoutMs;
  }
  #session?: JavaScriptSession;
  #uncertainOwnership?: UncertainNativeOwnership;
  #sessionGeneration = 0;
  #lease?: NativeSessionLease;
  #configuredLease?: NativeLeaseContext;
  #recoveryRequired?: NativeLeaseContext;
  #resolved?: ResolvedNativeSession;
  #creationSafetyEnabled = false;
  #creationUncertain?: Readonly<{
    state: 'creation-uncertain';
    resolved: ResolvedNativeSession;
    generation: number;
    causeCategory: string;
    cause: unknown;
  }>;
  #busy = false;
  get currentApp() {
    return this.#resolved?.app;
  }
  get currentTarget(): ResolvedNativeSession | undefined {
    return this.#resolved ? { ...this.#resolved } : undefined;
  }
  get isRunning() {
    return this.#session !== undefined && !this.#session.isClosed;
  }
  /** Internal diagnostic state only; never exposes the owned Session or its identifiers. */
  get hasUncertainOwnedSession() {
    return this.#uncertainOwnership !== undefined;
  }
  get hasUncertainCreation() {
    return this.#creationUncertain !== undefined;
  }
  get currentSessionGeneration(): number | undefined {
    return this.isRunning ? this.#sessionGeneration : undefined;
  }
  async configureResolved(
    resolved: ResolvedNativeSession,
    creationSafetyEnabled = false,
    lease?: NativeLeaseContext,
    recovery = false,
  ) {
    capabilities(resolved);
    this.assertLifecycleCertain(recovery);
    if (this.#recoveryRequired) {
      if (!recovery || !lease || !this.sameLeaseContext(this.#recoveryRequired, lease))
        throw this.recoveryRequiredError();
      if (new URL(resolved.environment.serverUrl!).href !== lease.endpoint)
        throw this.recoveryRequiredError();
      if (this.#session) this.assertLeaseContext(lease);
    } else {
      await this.close();
    }
    this.#resolved = resolved;
    this.#creationSafetyEnabled = creationSafetyEnabled;
    this.#configuredLease = lease;
  }
  async execute(code: string, signal?: AbortSignal) {
    return this.executeSession(code, signal);
  }
  async executeExisting(
    code: string,
    generation: number,
    signal?: AbortSignal,
    lease?: NativeLeaseContext,
    recovery = false,
  ) {
    return this.executeSession(code, signal, generation, lease, recovery);
  }
  async executeLeased(
    code: string,
    signal: AbortSignal | undefined,
    lease: NativeLeaseContext | undefined,
    recovery = false,
  ) {
    return this.executeSession(code, signal, undefined, lease, recovery);
  }
  async executeReadinessTransaction(
    code: string,
    signal: AbortSignal | undefined,
    lease: NativeLeaseContext | undefined,
    generation: number | undefined,
    finalize: (
      observations: Awaited<ReturnType<JavaScriptSession['execute']>>,
    ) => Promise<Awaited<ReturnType<JavaScriptSession['execute']>>>,
  ) {
    return this.executeSession(code, signal, generation, lease, true, finalize);
  }
  assertExecutionLease(lease: NativeLeaseContext | undefined) {
    this.assertLifecycleCertain();
    if (this.#creationSafetyEnabled && this.#session) this.assertLeaseContext(lease);
  }
  private async executeSession(
    code: string,
    signal?: AbortSignal,
    generation?: number,
    expectedLease?: NativeLeaseContext,
    recovery = false,
    finalize?: (
      observations: Awaited<ReturnType<JavaScriptSession['execute']>>,
    ) => Promise<Awaited<ReturnType<JavaScriptSession['execute']>>>,
  ) {
    this.assertLifecycleCertain(recovery);
    if (this.#busy) throw new Error('Native execution already in progress.');
    signal?.throwIfAborted();
    if (!this.#resolved) throw new Error('Select and configure a native project first.');
    if (generation !== undefined && (!this.isRunning || this.#sessionGeneration !== generation))
      throw new Error(
        'NATIVE_SESSION_CHANGED: the checked Session was closed or replaced; no new Session was created.',
      );
    if (this.#creationSafetyEnabled) this.assertLeaseContext(expectedLease);
    this.#busy = true;
    try {
      const recovering = recovery && this.#recoveryRequired !== undefined;
      if (generation === undefined && this.#session?.isClosed) await this.invalidateSession();
      if (generation === undefined && !this.#session) {
        signal?.throwIfAborted();
        this.#session = await startNativeSession(this.#resolved, this.#executionTimeoutMs, {
          signal,
        });
        this.#sessionGeneration++;
        if (this.#creationSafetyEnabled) {
          const configured = this.#configuredLease;
          if (!configured) {
            const untrusted = this.#session;
            this.#session = undefined;
            await untrusted.close();
            throw new Error(
              'Native Session lease context is unavailable; the Session was not leased.',
            );
          }
          this.#lease = Object.freeze({
            ...configured,
            generation: this.#sessionGeneration,
            session: this.#session,
          });
        }
      }
      if (this.#creationSafetyEnabled) this.assertLeaseContext(expectedLease);
      signal?.throwIfAborted();
      const result = await this.#session!.execute(code, signal);
      if (recovering) {
        const lease = this.#lease;
        if (!lease || !finalize) throw this.recoveryRequiredError();
        const finalized = await finalize(result);
        signal?.throwIfAborted();
        this.assertRecoveryLease(lease, expectedLease);
        this.#recoveryRequired = undefined;
        return finalized;
      }
      return finalize ? await finalize(result) : result;
    } catch (error) {
      if (error instanceof NativeSessionCreationUncertainError && this.#creationSafetyEnabled) {
        this.#creationUncertain ??= Object.freeze({
          state: 'creation-uncertain' as const,
          resolved: this.#resolved,
          generation: this.#sessionGeneration + 1,
          causeCategory: error.facts.causeCategory,
          cause: error.internalCause,
        });
        installMobileCreationBarrier(error.facts.causeCategory);
        throw new PhoneSessionCreationUncertainError();
      }
      const invalidSession =
        error instanceof ExplorationExecutionError &&
        error.details.name === 'InvalidSessionError' &&
        error.details.phase === 'execute';
      const workerFailure = error instanceof WorkerTerminatedError || this.#session?.isClosed;
      if (this.#creationSafetyEnabled && (invalidSession || workerFailure)) {
        if (this.#configuredLease) this.#recoveryRequired ??= this.#configuredLease;
        const primary = this.safeExecutionFailure(invalidSession);
        try {
          await this.invalidateSession();
        } catch (cleanup) {
          throw errorWithCleanupFailure(primary, cleanup);
        }
        throw primary;
      }
      if (signal?.aborted || this.#session?.isClosed) {
        try {
          await this.invalidateSession();
        } catch (cleanup) {
          throw errorWithCleanupFailure(error, cleanup);
        }
      }
      throw error;
    } finally {
      this.#busy = false;
    }
  }
  private sameLeaseContext(left: NativeLeaseContext, right: NativeLeaseContext) {
    return (
      left.lifecycleToken === right.lifecycleToken &&
      sameDeviceIdentity(left.identity, right.identity) &&
      left.endpoint === right.endpoint &&
      left.backend === right.backend
    );
  }
  private assertLeaseContext(expected: NativeLeaseContext | undefined) {
    const lease = this.#lease;
    const configured = this.#configuredLease;
    if (!expected || !configured || !this.sameLeaseContext(configured, expected))
      throw new Error(
        'NATIVE_SESSION_LEASE_MISMATCH: Session lease does not match the active phone lifecycle; no JavaScript was dispatched.',
      );
    if (
      lease &&
      (!this.sameLeaseContext(lease, expected) ||
        lease.generation !== this.#sessionGeneration ||
        lease.session !== this.#session ||
        lease.session.isClosed)
    )
      throw new Error(
        'NATIVE_SESSION_LEASE_MISMATCH: Session generation, Worker health or creator proof changed; no JavaScript was dispatched.',
      );
  }
  private recoveryRequiredError() {
    return new Error(
      'NATIVE_SESSION_RECOVERY_REQUIRED: the previous action result is uncertain. Call setup.ready for a fresh observation on the pinned phone before executing new JavaScript.',
    );
  }
  private assertRecoveryLease(
    pending: NativeSessionLease,
    expectedLease: NativeLeaseContext | undefined,
  ) {
    if (
      !expectedLease ||
      !this.#recoveryRequired ||
      pending !== this.#lease ||
      !this.sameLeaseContext(this.#recoveryRequired, expectedLease) ||
      !this.sameLeaseContext(pending, expectedLease) ||
      pending.generation !== this.#sessionGeneration ||
      pending.session !== this.#session ||
      pending.session.isClosed
    )
      throw this.recoveryRequiredError();
  }
  private safeExecutionFailure(invalidSession: boolean) {
    const message = invalidSession
      ? 'Phone Session became invalid during JavaScript execution; the action result is uncertain. No action was replayed. Call setup.ready for a fresh observation before executing new JavaScript.'
      : 'Phone JavaScript execution channel terminated after dispatch; the action result is uncertain. No action was replayed. Call setup.ready for a fresh observation before executing new JavaScript.';
    return new ExplorationExecutionError(message, {
      name: invalidSession ? 'InvalidSessionError' : 'NativeExecutionTerminatedError',
      message,
      category: 'runtime-error',
      phase: 'execute',
      actionState: 'uncertain',
    });
  }
  private assertLifecycleCertain(allowRecovery = false) {
    if (this.#creationUncertain) throw new PhoneSessionCreationUncertainError();
    if (this.#uncertainOwnership)
      throw new Error('Native Session ownership is uncertain after cleanup failure.');
    if (this.#recoveryRequired && !allowRecovery) throw this.recoveryRequiredError();
  }
  private async invalidateSession() {
    const current = this.#session;
    if (this.#session === current) this.#session = undefined;
    if (current) await this.closeOwnedSession(current);
  }
  private async closeOwnedSession(current: JavaScriptSession) {
    if (this.#uncertainOwnership) {
      try {
        await this.#uncertainOwnership.closeResult;
      } catch (error) {
        throw this.safeCleanupFailure(this.#uncertainOwnership, error);
      }
      return;
    }
    if (this.#creationSafetyEnabled && (!this.#lease || this.#lease.session !== current))
      throw new Error(
        'Native Session cleanup was blocked because current-process creator proof is unavailable.',
      );
    const ownership = Object.freeze({
      session: current,
      closeResult: Promise.resolve().then(() => current.close()),
      cleanupFailure: {},
    });
    this.#uncertainOwnership = ownership;
    try {
      await ownership.closeResult;
    } catch (error) {
      throw this.safeCleanupFailure(ownership, error);
    }
    if (this.#uncertainOwnership === ownership) this.#uncertainOwnership = undefined;
    if (this.#lease?.session === current) this.#lease = undefined;
  }
  private safeCleanupFailure(ownership: UncertainNativeOwnership, error: unknown): unknown {
    if (!this.#creationSafetyEnabled) return error;
    return (ownership.cleanupFailure.public ??= new Error(
      'Owned Session cleanup failed; the phone lifecycle is blocked until cleanup can be proven.',
    ));
  }
  async close() {
    if (this.#creationUncertain) throw new PhoneSessionCreationUncertainError();
    if (this.#uncertainOwnership) {
      try {
        await this.#uncertainOwnership.closeResult;
      } catch (error) {
        throw this.safeCleanupFailure(this.#uncertainOwnership, error);
      }
      return;
    }
    const current = this.#session;
    if (!current) {
      this.#lease = undefined;
      this.#configuredLease = undefined;
      this.#recoveryRequired = undefined;
      return;
    }
    // Explicit release immediately revokes execution, while retaining the exact ownership
    // and one-shot close result until cleanup is known to have succeeded.
    this.#session = undefined;
    await this.closeOwnedSession(current);
    this.#lease = undefined;
    this.#configuredLease = undefined;
    this.#recoveryRequired = undefined;
  }
}
