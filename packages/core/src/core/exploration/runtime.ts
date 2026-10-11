export interface ExplorationRuntime {
  bindings(): Record<string, unknown>;
  screenshot(): Promise<{ data: string; mimeType: string }>;
  close(): Promise<void>;
}

export type JavaScriptSession = {
  /** Authoritative Worker lifecycle state, when supplied by a managed session. */
  readonly isClosed?: boolean;
  execute(
    code: string,
    signal?: AbortSignal,
  ): Promise<import('./protocol.ts').JavaScriptObservation[]>;
  close(): Promise<void>;
};

export class ExplorationExecutionError extends Error {
  readonly code = 'MAAT_EXECUTION_ERROR';
  readonly details: import('./protocol.ts').WorkerError;
  constructor(
    message: string,
    details: import('./protocol.ts').WorkerError,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ExplorationExecutionError';
    this.details = details;
  }
}

/** Parent-side lifecycle failure; the action result is uncertain and the Worker is closed. */
export class WorkerTerminatedError extends Error {
  readonly code = 'MAAT_EXECUTION_TERMINATED';
}

export function errorWithCleanupFailure(primary: unknown, cleanup: unknown): AggregateError {
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  return new AggregateError(
    [primary, cleanup],
    `${message(primary)}; Owned Session cleanup also failed: ${message(cleanup)}`,
    { cause: primary },
  );
}

export type JavaScriptSessionOptions = {
  assertionTimeoutMs?: number;
  channel?: string;
  executablePath?: string;
  headless?: boolean;
  initializationTimeoutMs?: number;
  profileDirectory?: string;
  userDataDir?: string;
  executionTimeoutMs?: number;
};

export type ExplorationRuntimeModule = {
  createRuntime(options: unknown): Promise<ExplorationRuntime>;
};
