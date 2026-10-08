import type { JavaScriptSessionOptions } from '../../core/exploration/runtime.ts';
import { createExplorationWorker } from '../../core/exploration/worker-client.ts';

export function createWebExplorationSession(options: JavaScriptSessionOptions = {}) {
  const runtimeModule = import.meta.url.endsWith('.ts')
    ? './exploration-runtime.ts'
    : './exploration-runtime.js';
  return createExplorationWorker(
    new URL(runtimeModule, import.meta.url),
    options,
    options.executionTimeoutMs ?? 60_000,
    options.initializationTimeoutMs ?? 30_000,
  );
}
