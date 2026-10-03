import type { JavaScriptObservation } from './protocol.ts';

export type JavaScriptSession = {
  execute(code: string, signal?: AbortSignal): Promise<JavaScriptObservation[]>;
  close(): Promise<void>;
};

export type JavaScriptSessionOptions = {
  assertionTimeoutMs?: number; channel?: string; executablePath?: string; headless?: boolean; initializationTimeoutMs?: number;
  profileDirectory?: string; userDataDir?: string; executionTimeoutMs?: number;
};

/** Compatibility facade; Web execution is implemented by the Web Adapter Runtime. */
export async function launchJavaScriptSession(options: JavaScriptSessionOptions = {}): Promise<JavaScriptSession> {
  const { createWebExplorationSession } = await import('../platforms/web/exploration-session.ts');
  return createWebExplorationSession(options);
}
