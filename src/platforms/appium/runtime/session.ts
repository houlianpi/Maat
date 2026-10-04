import { remote } from 'webdriverio';
import { capabilities, connection, type ResolvedNativeSession } from '../schema.ts';
import { createExplorationWorker } from '../../../core/exploration/worker-client.ts';
import type { JavaScriptSession } from '../../../core/exploration/runtime.ts';

export async function startNativeSession(
  target: ResolvedNativeSession,
  timeoutMs = 60_000,
): Promise<JavaScriptSession> {
  const desired = capabilities(target);
  if (target.environment.serverUrl) connection(target.environment.serverUrl);
  if (!target.environment.serverUrl)
    throw new Error('Resolved Appium Session requires a serverUrl.');
  const endpoint = connection(target.environment.serverUrl);
  let driver: Awaited<ReturnType<typeof remote>>;
  try {
    driver = await remote({
      ...endpoint,
      capabilities: desired,
      logLevel: 'silent',
      connectionRetryCount: 0,
      connectionRetryTimeout: 180_000,
    });
  } catch (error) {
    throw error;
  }
  let worker: JavaScriptSession;
  try {
    worker = await createExplorationWorker(
      new URL('../exploration-runtime.ts', import.meta.url),
      {
        ...endpoint,
        sessionId: driver.sessionId,
        capabilities: driver.capabilities,
        logLevel: 'silent',
        connectionRetryCount: 0,
        connectionRetryTimeout: 30_000,
      },
      timeoutMs,
    );
  } catch (error) {
    await driver.deleteSession();
    throw error;
  }
  return {
    execute: (code, signal) => worker.execute(code, signal),
    async close() {
      try {
        await worker.close();
      } finally {
        await driver.deleteSession();
      }
    },
  };
}
