import type { JavaScriptSessionOptions } from '../../core/exploration/runtime.ts';
import { createExplorationWorker } from '../../core/exploration/worker-client.ts';

export function createWebExplorationSession(options: JavaScriptSessionOptions = {}) {
  return createExplorationWorker(
    new URL('./exploration-runtime.ts', import.meta.url),
    options,
    options.executionTimeoutMs ?? 60_000,
    options.initializationTimeoutMs ?? 30_000,
  );
}
