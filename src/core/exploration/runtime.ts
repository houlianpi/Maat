export interface ExplorationRuntime {
  bindings(): Record<string, unknown>;
  screenshot(): Promise<{ data: string; mimeType: string }>;
  close(): Promise<void>;
}

export type JavaScriptSession = {
  execute(
    code: string,
    signal?: AbortSignal,
  ): Promise<import('./protocol.ts').JavaScriptObservation[]>;
  close(): Promise<void>;
};

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
