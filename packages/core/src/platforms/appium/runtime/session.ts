import { remote } from 'webdriverio';
import { capabilities, connection, type ResolvedNativeSession } from '../schema.ts';
import { createExplorationWorker } from '../../../core/exploration/worker-client.ts';
import type { JavaScriptSession } from '../../../core/exploration/runtime.ts';
import { errorWithCleanupFailure } from '../../../core/exploration/runtime.ts';

export class NativeInitializationCancelledError extends Error {
  readonly abortReason: unknown;
  constructor(cause: unknown, abortReason: unknown) {
    super(
      'Native Session initialization cancelled before a Session ID was received. POST /session may have completed remotely; cleanup cannot be confirmed without its ID. No action was replayed.',
      { cause },
    );
    this.abortReason = abortReason;
  }
}

/** Read-only guard in the same killable Worker dispatch, not per-action lock atomicity. */
export const androidLockGuardCode = [
  'await (async () => {',
  '  let locked;',
  '  try { locked = await driver.isLocked(); }',
  '  catch (error) {',
  '    let reason = "lock query failed";',
  '    try { reason = (error && typeof error.message === "string" ? error.message : String(error)).slice(0, 1_000).replace(/[\\r\\n]+/g, " "); } catch {}',
  '    throw new Error("ANDROID_DEVICE_LOCK_STATE_UNKNOWN: could not check whether phone is locked or screen off; check the connection and unlock/wake yourself then recheck. Original failure: " + reason, {cause: error});',
  '  }',
  '  if (locked === true) throw new Error("ANDROID_DEVICE_LOCKED: phone locked or screen off; unlock/wake yourself then recheck.");',
  '  if (locked !== false) throw new Error("ANDROID_DEVICE_LOCK_STATE_UNKNOWN: lock query did not return a boolean; check the connection and unlock/wake yourself then recheck.");',
  '})();',
].join('\n');

export async function startNativeSession(
  target: ResolvedNativeSession,
  timeoutMs = 60_000,
  options: { signal?: AbortSignal; initializationTimeoutMs?: number } = {},
): Promise<JavaScriptSession> {
  options.signal?.throwIfAborted();
  const initializationTimeoutMs = options.initializationTimeoutMs ?? 180_000;
  if (!Number.isFinite(initializationTimeoutMs) || initializationTimeoutMs <= 0)
    throw new Error('Native initialization timeout must be positive and finite.');
  const deadline = Date.now() + initializationTimeoutMs;
  const initializationSignal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(initializationTimeoutMs),
  ]);
  const remaining = () => Math.max(1, Math.ceil(deadline - Date.now()));
  const desired = capabilities(target);
  const appId = target.app?.['appium:appPackage'] ?? target.app?.['appium:bundleId'];
  const supportsAppLifecycle = target.environment.platform !== 'macos';
  if (target.environment.serverUrl) connection(target.environment.serverUrl);
  if (!target.environment.serverUrl)
    throw new Error('Resolved Appium Session requires a serverUrl.');
  const endpoint = connection(target.environment.serverUrl);
  let driver: Awaited<ReturnType<typeof remote>> | undefined;
  let worker: JavaScriptSession | undefined;
  let initializing = true;
  let sessionRequested = false;
  try {
    initializationSignal.throwIfAborted();
    driver = await remote({
      ...endpoint,
      capabilities: desired,
      logLevel: 'silent',
      connectionRetryCount: 0,
      connectionRetryTimeout: remaining(),
      // The SDK applies this RequestInit signal to the actual Undici request.
      // Do not keep an expired bootstrap signal on subsequent cleanup/commands.
      transformRequest: (request) => {
        if (initializing && request.method === 'POST') sessionRequested = true;
        return {
          ...request,
          ...(initializing
            ? {
                signal: AbortSignal.any([
                  initializationSignal,
                  ...(request.signal ? [request.signal] : []),
                ]),
              }
            : {}),
        };
      },
    });
    initializationSignal.throwIfAborted();
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
      Math.min(30_000, remaining()),
      initializationSignal,
    );
    initializationSignal.throwIfAborted();
  } catch (error) {
    initializing = false;
    let failure: unknown = error;
    if (!driver && sessionRequested && initializationSignal.aborted) {
      failure = new NativeInitializationCancelledError(error, initializationSignal.reason);
    }
    if (worker) {
      try {
        await worker.close();
      } catch (cleanup) {
        failure = errorWithCleanupFailure(failure, cleanup);
      }
    }
    if (driver) {
      driver.options.connectionRetryTimeout = 5_000;
      try {
        await driver.deleteSession();
      } catch (cleanup) {
        failure = errorWithCleanupFailure(failure, cleanup);
      }
    }
    throw failure;
  }
  initializing = false;
  const ownedDriver = driver;
  const ownedWorker = worker;
  let closing: Promise<void> | undefined;
  return {
    get isClosed() {
      return Boolean(closing) || ownedWorker.isClosed;
    },
    execute: (code, signal) =>
      ownedWorker.execute(
        target.environment.platform === 'android' && !code.startsWith(`${androidLockGuardCode}\n`)
          ? `${androidLockGuardCode}\n${code}`
          : code,
        signal,
      ),
    close() {
      return (closing ??= (async () => {
        // Cleanup is independent of the expired observation/bootstrap budget.
        ownedDriver.options.connectionRetryTimeout = 5_000;
        let failure: unknown;
        for (const cleanup of [
          () => ownedWorker.close(),
          async () => {
            if (appId && supportsAppLifecycle) await ownedDriver.terminateApp(appId);
          },
          () => ownedDriver.deleteSession(),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            failure = failure === undefined ? error : errorWithCleanupFailure(failure, error);
          }
        }
        if (failure !== undefined) throw failure;
      })());
    },
  };
}
