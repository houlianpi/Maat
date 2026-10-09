import { remote } from 'webdriverio';
import { capabilities, connection, type ResolvedNativeSession } from '../schema.ts';
import { createExplorationWorker } from '../../../core/exploration/worker-client.ts';
import type { JavaScriptSession } from '../../../core/exploration/runtime.ts';

function isMissingSessionError(error: unknown): boolean {
  return /invalid session id|session (?:is )?either terminated or not started|session (?:has been )?(?:terminated|deleted|closed)|no active session/i.test(
    String(error),
  );
}

export async function closeAppiumSession(
  driver: Pick<Awaited<ReturnType<typeof remote>>, 'terminateApp' | 'deleteSession'>,
  appId: string | undefined,
  supportsAppLifecycle: boolean,
): Promise<void> {
  let lifecycleError: unknown;
  if (appId && supportsAppLifecycle) {
    try {
      await driver.terminateApp(appId);
    } catch (error) {
      if (!isMissingSessionError(error)) lifecycleError = error;
    }
  }
  try {
    await driver.deleteSession();
  } catch (error) {
    if (!isMissingSessionError(error)) throw error;
  }
  if (lifecycleError) throw lifecycleError;
}

export async function startNativeSession(
  target: ResolvedNativeSession,
  timeoutMs = 60_000,
): Promise<JavaScriptSession> {
  const desired = capabilities(target);
  const appId = target.app?.['appium:appPackage'] ?? target.app?.['appium:bundleId'];
  const supportsAppLifecycle = target.environment.platform !== 'macos';
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
    const runtimeModule = import.meta.url.endsWith('.ts')
      ? '../exploration-runtime.ts'
      : '../exploration-runtime.js';
    worker = await createExplorationWorker(
      new URL(runtimeModule, import.meta.url),
      {
        ...endpoint,
        maatAppId: appId,
        maatPlatform: target.environment.platform,
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
        await closeAppiumSession(driver, appId, supportsAppLifecycle);
      }
    },
  };
}
