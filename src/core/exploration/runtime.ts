export interface ExplorationRuntime {
  bindings(): Record<string, unknown>;
  screenshot(): Promise<{ data: string; mimeType: string }>;
  close(): Promise<void>;
}

export type ExplorationRuntimeModule = {
  createRuntime(options: unknown): Promise<ExplorationRuntime>;
};
