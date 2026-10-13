import { remote } from 'webdriverio';
import { capabilities, connection, type ResolvedNativeSession } from '../schema.ts';
import { createExplorationWorker } from '../../../core/exploration/worker-client.ts';
import type { JavaScriptSession } from '../../../core/exploration/runtime.ts';
import {
  errorWithCleanupFailure,
  ExplorationExecutionError,
} from '../../../core/exploration/runtime.ts';

const nativeInitializationDiagnostics = new WeakMap<Error, unknown>();

function safeNativeInitializationFailure(cause: unknown): ExplorationExecutionError {
  const message =
    'Native Session Worker initialization failed before JavaScript dispatch. Retry setup.ready only after Session cleanup and ownership are resolved.';
  const error = new ExplorationExecutionError(message, {
    name: 'NativeSessionInitializationError',
    message,
    category: 'runtime-error',
    phase: 'validate',
    actionState: 'not-started',
  });
  nativeInitializationDiagnostics.set(error, cause);
  return error;
}

function safeNativeInitializationCleanupFailure(cause: unknown): Error {
  const error = new Error(
    'Native Session cleanup failed after Worker initialization failure; recovery is required before another Session can be created.',
  );
  nativeInitializationDiagnostics.set(error, cause);
  return error;
}

export type NativeSessionCreationFacts = Readonly<{
  dispatchPossible: boolean;
  responseReceived: boolean;
  responseValidated: boolean;
  explicitFailureReceived: boolean;
  trustedSessionId: boolean;
  causeCategory: 'abort' | 'timeout' | 'transport' | 'invalid-response' | 'missing-session-id';
}>;

/** Internal transport evidence. Managers retain it and expose only the stable safe public error. */
export class NativeSessionCreationUncertainError extends Error {
  readonly facts: NativeSessionCreationFacts;
  readonly internalCause: unknown;
  readonly abortReason: unknown;

  constructor(cause: unknown, facts: NativeSessionCreationFacts, abortReason?: unknown) {
    super(
      'Native Session creation is uncertain: POST /session may have dispatched and no trusted Session handle or complete explicit failure response was received.',
    );
    this.name = 'NativeSessionCreationUncertainError';
    this.facts = facts;
    this.internalCause = cause;
    this.abortReason = abortReason;
  }
}

/** Read-only guard in the same killable Worker dispatch, not per-action lock atomicity. */
function phoneLockGuardCode(platform: 'ANDROID' | 'IOS') {
  const state = platform === 'ANDROID' ? 'locked or screen off' : 'locked';
  return [
    'await (async () => {',
    '  let locked;',
    '  try { locked = await driver.isLocked(); }',
    '  catch (error) {',
    '    let reason = "lock query failed";',
    '    try { reason = (error && typeof error.message === "string" ? error.message : String(error)).slice(0, 1_000).replace(/[\\r\\n]+/g, " "); } catch {}',
    `    throw new Error("${platform}_DEVICE_LOCK_STATE_UNKNOWN: could not check whether phone is ${state}; check the connection and unlock/wake yourself then recheck. Original failure: " + reason, {cause: error});`,
    '  }',
    `  if (locked === true) throw new Error("${platform}_DEVICE_LOCKED: phone ${state}; unlock/wake yourself then recheck.");`,
    `  if (locked !== false) throw new Error("${platform}_DEVICE_LOCK_STATE_UNKNOWN: lock query did not return a boolean; check the connection and unlock/wake yourself then recheck.");`,
    '})();',
  ].join('\n');
}

export const androidLockGuardCode = phoneLockGuardCode('ANDROID');
export const iosLockGuardCode = phoneLockGuardCode('IOS');

export function nativeReadinessCode(platform: 'android' | 'ios', screenshot = false): string {
  const lockGuard = platform === 'ios' ? iosLockGuardCode : androidLockGuardCode;
  return [
    lockGuard,
    'const source = await driver.getPageSource();',
    'if (typeof source !== "string" || !source.trim()) throw new Error("READINESS_SOURCE_EMPTY: page source is empty.");',
    'const viewport = await driver.getWindowSize();',
    'if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error("READINESS_VIEWPORT_INVALID: viewport is invalid.");',
    ...(screenshot
      ? [
          'try { await evidence.screenshot(); } catch (error) { throw new Error("READINESS_SCREENSHOT_FAILED: screenshot command failed.", {cause: error}); }',
        ]
      : []),
    lockGuard,
    'console.log(JSON.stringify({maatSetupReadiness: 1, phoneUnlocked: true, sessionUsable: true, sourceReadable: true, viewportReadable: true, source, viewport: {width: viewport.width, height: viewport.height}}));',
  ].join('\n');
}

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
  const desired = {
    ...capabilities(target),
    ...(target.environment.platform === 'android' ? { 'appium:shouldTerminateApp': false } : {}),
  };
  const appId = target.app?.['appium:appPackage'] ?? target.app?.['appium:bundleId'];
  const supportsAppLifecycle = target.environment.platform === 'ios';
  const lockGuard =
    target.environment.platform === 'android'
      ? androidLockGuardCode
      : target.environment.platform === 'ios' && target.environment.device?.kind === 'device'
        ? iosLockGuardCode
        : undefined;
  if (target.environment.serverUrl) connection(target.environment.serverUrl);
  if (!target.environment.serverUrl)
    throw new Error('Resolved Appium Session requires a serverUrl.');
  const endpoint = connection(target.environment.serverUrl);
  let driver: Awaited<ReturnType<typeof remote>> | undefined;
  let worker: JavaScriptSession | undefined;
  let initializing = true;
  let dispatchPossible = false;
  let responseReceived = false;
  let responseValidated = false;
  let explicitFailureReceived = false;
  let trustedSessionId = false;
  const completeExplicitFailure = (response: unknown): boolean => {
    if (!response || typeof response !== 'object') return false;
    const record = response as { statusCode?: unknown; body?: unknown };
    if (typeof record.statusCode !== 'number' || record.statusCode < 400) return false;
    if (!record.body || typeof record.body !== 'object') return false;
    const value = (record.body as { value?: unknown }).value;
    if (!value || typeof value !== 'object') return false;
    const failure = value as { error?: unknown; message?: unknown };
    return (
      failure.error === 'session not created' &&
      typeof failure.message === 'string' &&
      failure.message.trim().length > 0
    );
  };
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
        const effectiveSignal = initializing
          ? AbortSignal.any([initializationSignal, ...(request.signal ? [request.signal] : [])])
          : request.signal;
        // If cancellation won before transport acceptance, dispatch is
        // disproven. Once this hook accepts the request, later cancellation
        // cannot prove whether bytes reached Appium, so remain conservative.
        if (initializing && request.method === 'POST') {
          effectiveSignal?.throwIfAborted();
          dispatchPossible = true;
        }
        return {
          ...request,
          ...(initializing ? { signal: effectiveSignal } : {}),
        };
      },
      transformResponse: (response, request) => {
        if (initializing && request.method === 'POST') {
          responseReceived = true;
          responseValidated =
            Boolean(response) &&
            typeof response === 'object' &&
            typeof (response as { statusCode?: unknown }).statusCode === 'number' &&
            Boolean((response as { body?: unknown }).body) &&
            typeof (response as { body?: unknown }).body === 'object' &&
            Object.hasOwn((response as { body: object }).body, 'value');
          explicitFailureReceived = completeExplicitFailure(response);
        }
        return response;
      },
    });
    trustedSessionId = typeof driver.sessionId === 'string' && driver.sessionId.trim().length > 0;
    if (!trustedSessionId) throw new Error('Native Session response did not include a Session ID.');
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
    let failure: unknown = trustedSessionId ? safeNativeInitializationFailure(error) : error;
    if (!trustedSessionId && dispatchPossible && !explicitFailureReceived) {
      const message = error instanceof Error ? error.message : String(error);
      const invalidResponse = /Could not parse response body/i.test(message);
      if (invalidResponse) responseReceived = true;
      const initializationTimedOut =
        !options.signal?.aborted && (initializationSignal.aborted || Date.now() >= deadline);
      const causeCategory =
        initializationSignal.aborted || initializationTimedOut
          ? options.signal?.aborted
            ? 'abort'
            : 'timeout'
          : invalidResponse
            ? 'invalid-response'
            : responseReceived
              ? /session id/i.test(message)
                ? 'missing-session-id'
                : 'invalid-response'
              : 'transport';
      failure = new NativeSessionCreationUncertainError(
        error,
        {
          dispatchPossible,
          responseReceived,
          responseValidated,
          explicitFailureReceived,
          trustedSessionId,
          causeCategory,
        },
        initializationSignal.reason,
      );
      // A WDIO object without a trusted nonempty Session ID is not an ownership handle.
      // Never let generic cleanup issue DELETE for such an object.
      driver = undefined;
    }
    if (worker) {
      try {
        await worker.close();
      } catch (cleanup) {
        failure = errorWithCleanupFailure(
          failure,
          trustedSessionId ? safeNativeInitializationCleanupFailure(cleanup) : cleanup,
        );
      }
    }
    if (driver) {
      driver.options.connectionRetryTimeout = 5_000;
      try {
        await driver.deleteSession();
      } catch (cleanup) {
        failure = errorWithCleanupFailure(
          failure,
          trustedSessionId ? safeNativeInitializationCleanupFailure(cleanup) : cleanup,
        );
      }
    }
    throw failure;
  }
  initializing = false;
  const ownedDriver = driver;
  const ownedWorker = worker;
  let closing: Promise<void> | undefined;
  const ownedSession: JavaScriptSession = {
    get isClosed() {
      return Boolean(closing) || ownedWorker.isClosed;
    },
    execute: (code, signal) =>
      ownedWorker.execute(
        lockGuard && !code.startsWith(`${lockGuard}\n`) ? `${lockGuard}\n${code}` : code,
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
  return ownedSession;
}
