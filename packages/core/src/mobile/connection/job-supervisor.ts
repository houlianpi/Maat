import { randomBytes } from 'node:crypto';

import type { SetupReadinessSuccess } from '../../setup-assistant/types.ts';
import { MobileBusyError } from '../devices/coordinator.ts';
import { acquireConnectionJobSlot } from './job-slot.ts';

export type ConnectionJobState =
  | 'queued'
  | 'running'
  | 'creation-uncertain'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type ConnectionJobSnapshot = Readonly<{
  jobId: string;
  state: ConnectionJobState;
  operation: 'device-readiness';
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  completedAt?: string;
  category?: string;
  /** Additive compatibility fields retained from the existing safe readiness result. */
  platform?: SetupReadinessSuccess['platform'];
  ready?: true;
  targetSelection?: SetupReadinessSuccess['targetSelection'];
  proof?: SetupReadinessSuccess['proof'];
  observations?: SetupReadinessSuccess['observations'];
}>;

type WaitOptions = { waitSeconds: number; signal?: AbortSignal };
type Slot = { owner: symbol; release(): void };
type JobRecord = {
  callerOwner: symbol;
  snapshot: ConnectionJobSnapshot;
  controller: AbortController;
  slot: Slot;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  settled: Promise<void>;
  settle: () => void;
  terminalAt?: number;
  cancelRequested: boolean;
};

type SupervisorOptions = {
  now?: () => number;
  randomId?: () => string;
  terminalTtlMs?: number;
  maxTerminalRecords?: number;
  acquireSlot?: () => Slot;
};

export class ConnectionJobNotFoundError extends Error {
  readonly code = 'connection-job-not-found';

  constructor() {
    super('Connection job was not found.');
    this.name = 'ConnectionJobNotFoundError';
  }
}

function hasCode(error: unknown, code: string, depth = 0): boolean {
  if (depth > 4 || !error || typeof error !== 'object') return false;
  if ('code' in error && error.code === code) return true;
  if (error instanceof AggregateError)
    return error.errors.some((item) => hasCode(item, code, depth + 1));
  return error instanceof Error && hasCode(error.cause, code, depth + 1);
}

function isTerminal(state: ConnectionJobState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

function timer(ms: number, callback: () => void): ReturnType<typeof setTimeout> {
  const handle = setTimeout(callback, ms);
  handle.unref?.();
  return handle;
}

/**
 * Owns one readiness execution and exposes only bounded, sanitized process-memory snapshots.
 * Production uses `processConnectionJobSupervisor`; injected instances keep tests isolated.
 */
export class ConnectionJobSupervisor {
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #terminalTtlMs: number;
  readonly #maxTerminalRecords: number;
  readonly #acquireSlot: () => Slot;
  readonly #jobs = new Map<string, JobRecord>();
  #active?: JobRecord;

  constructor(options: SupervisorOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? (() => randomBytes(24).toString('base64url'));
    this.#terminalTtlMs = options.terminalTtlMs ?? 600_000;
    this.#maxTerminalRecords = options.maxTerminalRecords ?? 32;
    this.#acquireSlot =
      options.acquireSlot ??
      (() => ({
        owner: Symbol('isolated-connection-job'),
        release() {},
      }));
  }

  get activeOwner(): symbol | undefined {
    return this.#active?.slot.owner;
  }

  assertCanStart(): void {
    this.#prune();
    if (this.#active) throw new MobileBusyError();
  }

  assertAccess(owner?: symbol): void {
    if (this.#active && this.#active.slot.owner !== owner) throw new MobileBusyError();
  }

  async start(
    callerOwner: symbol,
    operation: (signal: AbortSignal, owner: symbol) => Promise<SetupReadinessSuccess>,
    options: WaitOptions & { deadlineMs?: number },
  ): Promise<ConnectionJobSnapshot> {
    this.assertCanStart();
    const slot = this.#acquireSlot();
    const now = this.#now();
    const deadlineMs = options.deadlineMs ?? 15_000;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const job: JobRecord = {
      callerOwner,
      snapshot: Object.freeze({
        jobId: this.#randomId(),
        state: 'queued',
        operation: 'device-readiness',
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + deadlineMs).toISOString(),
      }),
      controller: new AbortController(),
      slot,
      settled,
      settle,
      cancelRequested: false,
    };
    this.#jobs.set(job.snapshot.jobId, job);
    this.#active = job;
    job.deadlineTimer = timer(deadlineMs, () => {
      if (!isTerminal(job.snapshot.state) && job.snapshot.state !== 'creation-uncertain')
        job.controller.abort(new DOMException('Connection job deadline exceeded.', 'AbortError'));
    });
    let reportFailure: ((error: unknown) => void) | undefined;
    const failure =
      options.waitSeconds > 0
        ? new Promise<never>((_resolve, reject) => {
            reportFailure = reject;
          })
        : undefined;
    void this.#execute(job, operation, reportFailure);
    const waiting = this.#wait(job, options);
    return failure ? await Promise.race([waiting, failure]) : await waiting;
  }

  async query(
    callerOwner: symbol,
    jobId: string,
    options: WaitOptions,
  ): Promise<ConnectionJobSnapshot> {
    const job = this.#find(callerOwner, jobId);
    return await this.#wait(job, options);
  }

  async cancel(
    callerOwner: symbol,
    jobId: string,
    options: WaitOptions,
  ): Promise<ConnectionJobSnapshot> {
    const job = this.#find(callerOwner, jobId);
    if (isTerminal(job.snapshot.state) || job.snapshot.state === 'creation-uncertain')
      return job.snapshot;
    if (!job.cancelRequested) {
      job.cancelRequested = true;
      job.controller.abort(new DOMException('Connection job cancelled.', 'AbortError'));
    }
    return await this.#wait(job, options);
  }

  async #execute(
    job: JobRecord,
    operation: (signal: AbortSignal, owner: symbol) => Promise<SetupReadinessSuccess>,
    reportFailure?: (error: unknown) => void,
  ): Promise<void> {
    this.#update(job, { state: 'running' });
    try {
      job.controller.signal.throwIfAborted();
      const result = await operation(job.controller.signal, job.slot.owner);
      job.controller.signal.throwIfAborted();
      this.#finish(job, { state: 'succeeded', result });
    } catch (error) {
      if (
        hasCode(error, 'phone-session-creation-uncertain') ||
        hasCode(error, 'phone-close-uncertain')
      ) {
        this.#update(job, {
          state: 'creation-uncertain',
          category: hasCode(error, 'phone-close-uncertain')
            ? 'phone-close-uncertain'
            : 'phone-session-creation-uncertain',
        });
      } else if (job.controller.signal.aborted) {
        this.#finish(job, {
          state: 'cancelled',
          category: job.cancelRequested ? 'cancelled' : 'deadline-exceeded',
        });
      } else {
        this.#finish(job, { state: 'failed', category: 'readiness-failed' });
        reportFailure?.(error);
      }
    } finally {
      job.settle();
    }
  }

  #update(
    job: JobRecord,
    values: Pick<ConnectionJobSnapshot, 'state'> &
      Partial<Pick<ConnectionJobSnapshot, 'category'>> & {
        result?: SetupReadinessSuccess;
      },
  ): void {
    const now = this.#now();
    const { result, ...publicValues } = values;
    job.snapshot = Object.freeze({
      jobId: job.snapshot.jobId,
      operation: job.snapshot.operation,
      createdAt: job.snapshot.createdAt,
      deadlineAt: job.snapshot.deadlineAt,
      updatedAt: new Date(now).toISOString(),
      ...(result ?? {}),
      ...publicValues,
    });
  }

  #finish(
    job: JobRecord,
    values: Pick<ConnectionJobSnapshot, 'state'> &
      Partial<Pick<ConnectionJobSnapshot, 'category'>> & {
        result?: SetupReadinessSuccess;
      },
  ): void {
    const now = this.#now();
    this.#update(job, values);
    job.terminalAt = now;
    job.snapshot = Object.freeze({
      ...job.snapshot,
      completedAt: new Date(now).toISOString(),
    });
    if (job.deadlineTimer) clearTimeout(job.deadlineTimer);
    if (this.#active === job) this.#active = undefined;
    job.slot.release();
    this.#prune();
  }

  #find(callerOwner: symbol, jobId: string): JobRecord {
    this.#prune();
    const job = this.#jobs.get(jobId);
    if (!job || job.callerOwner !== callerOwner) throw new ConnectionJobNotFoundError();
    return job;
  }

  async #wait(job: JobRecord, options: WaitOptions): Promise<ConnectionJobSnapshot> {
    options.signal?.throwIfAborted();
    if (
      options.waitSeconds === 0 ||
      isTerminal(job.snapshot.state) ||
      job.snapshot.state === 'creation-uncertain'
    )
      return job.snapshot;

    await new Promise<void>((resolve, reject) => {
      let finished = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (rejected: boolean, error?: unknown) => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener('abort', aborted);
        if (rejected) reject(error);
        else resolve();
      };
      const aborted = () => finish(true, options.signal?.reason);
      options.signal?.addEventListener('abort', aborted, { once: true });
      timeout = timer(options.waitSeconds * 1_000, () => finish(false));
      void job.settled.then(() => finish(false));
    });
    return job.snapshot;
  }

  #prune(): void {
    const now = this.#now();
    const terminal = [...this.#jobs.values()]
      .filter((job) => job.terminalAt !== undefined)
      .sort((left, right) => left.terminalAt! - right.terminalAt!);
    for (const job of terminal) {
      if (now - job.terminalAt! >= this.#terminalTtlMs) this.#jobs.delete(job.snapshot.jobId);
    }
    const retained = terminal.filter((job) => this.#jobs.has(job.snapshot.jobId));
    while (retained.length > this.#maxTerminalRecords) {
      const oldest = retained.shift();
      if (oldest) this.#jobs.delete(oldest.snapshot.jobId);
    }
  }
}

export const processConnectionJobSupervisor = new ConnectionJobSupervisor({
  acquireSlot: acquireConnectionJobSlot,
});
