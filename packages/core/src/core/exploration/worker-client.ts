import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isRecord, maxCodeBytes, parseObservations, parseWorkerError } from './protocol.ts';
import type { JavaScriptSession } from './runtime.ts';
import { ExplorationExecutionError, WorkerTerminatedError } from './runtime.ts';

const maxWorkerStderrBytes = 16 * 1024;
const gracefulCloseTimeoutMs = 500;
const forcedCloseTimeoutMs = 2_000;

export async function createExplorationWorker(
  module: URL,
  options: unknown,
  timeoutMs = 60_000,
  initializationTimeoutMs = 30_000,
  initializationSignal?: AbortSignal,
): Promise<JavaScriptSession> {
  initializationSignal?.throwIfAborted();
  const sourceRuntime = import.meta.url.endsWith('.ts');
  const child = fork(
    fileURLToPath(
      new URL(sourceRuntime ? './worker-host.ts' : './worker-host.js', import.meta.url),
    ),
    [],
    {
      execArgv: sourceRuntime ? ['--experimental-strip-types'] : [],
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key),
        ),
      ),
    },
  );
  let id = 0;
  let pending:
    | { id: number; resolve(value: unknown): void; reject(error: Error): void }
    | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let terminalError: Error | undefined;
  let workerStderr = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    workerStderr = (workerStderr + chunk.toString()).slice(-maxWorkerStderrBytes);
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve();
      if (closing || closed) return;
      const detail = workerStderr.trim();
      terminate(
        new Error(
          `Exploration Worker exited before responding (code ${code ?? 'unknown'}, signal ${signal ?? 'none'}).${detail ? `\n${detail}` : ''}`,
        ),
      );
    });
    child.once('error', () => resolve());
  });
  const waitForExit = async (timeoutMs: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const killGroup = () => {
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  const terminate = (error: Error) => {
    terminalError ??= new WorkerTerminatedError(error.message, { cause: error });
    closed = true;
    pending?.reject(terminalError);
    pending = undefined;
    killGroup();
  };
  child.on('message', (message: unknown) => {
    if (closing) return;
    if (!isRecord(message) || message.id !== pending?.id) {
      terminate(new Error('Invalid Exploration Worker response.'));
      return;
    }
    const request = pending!;
    const details = parseWorkerError(message.error);
    if (details) {
      pending = undefined;
      request.reject(new ExplorationExecutionError(details.message, details));
    } else if ('error' in message) {
      terminate(new Error('Invalid Exploration Worker error response.'));
    } else {
      pending = undefined;
      request.resolve(message.result);
    }
  });
  child.on('error', (error) => terminate(error));
  function request(
    operation: string,
    payload: object,
    signal?: AbortSignal,
    deadlineMs = timeoutMs,
  ): Promise<unknown> {
    if (closed)
      return Promise.reject(
        terminalError ?? new WorkerTerminatedError('Exploration Worker is closed.'),
      );
    if (pending) return Promise.reject(new Error('Exploration Worker is busy.'));
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(
        () =>
          terminate(
            new Error(
              `${operation === 'initialize' ? 'Exploration initialization' : 'Exploration execution'} exceeded ${deadlineMs}ms.`,
            ),
          ),
        deadlineMs,
      );
      const abort = () =>
        terminate(
          new Error(
            `Exploration ${operation === 'initialize' ? 'initialization' : 'execution'} aborted.`,
            { cause: signal?.reason },
          ),
        );
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      pending = {
        id: requestId,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      signal?.addEventListener('abort', abort, { once: true });
      child.send({ id: requestId, operation, ...payload }, (error) => {
        if (error) terminate(error);
      });
    });
  }
  try {
    await request(
      'initialize',
      { module: module.href, options },
      initializationSignal,
      initializationTimeoutMs,
    );
  } catch (error) {
    closed = true;
    if (child.exitCode === null && child.signalCode === null) killGroup();
    await exited;
    child.stderr?.destroy();
    if (error instanceof ExplorationExecutionError)
      throw new Error(`Exploration initialization failed: ${error.message}`, { cause: error });
    throw error;
  }
  return {
    get isClosed() {
      return closed;
    },
    async execute(code, signal) {
      if (!code.trim() || Buffer.byteLength(code) > maxCodeBytes)
        throw new ExplorationExecutionError('Code must be nonempty and at most 64 KiB.', {
          name: 'ValidationError',
          message: 'Code must be nonempty and at most 64 KiB.',
          category: 'invalid-input',
          phase: 'validate',
          actionState: 'not-started',
        });
      return parseObservations(await request('execute', { code }, signal));
    },
    close() {
      if (closing) return closing;
      const alreadyClosed = closed;
      closed = true;
      closing = (async () => {
        if (!alreadyClosed && child.connected) child.send({ id: ++id, operation: 'close' });
        await waitForExit(gracefulCloseTimeoutMs);
        if (child.exitCode === null && child.signalCode === null) killGroup();
        await waitForExit(forcedCloseTimeoutMs);
        if (child.connected) child.disconnect();
        child.removeAllListeners();
        child.stderr?.destroy();
      })();
      return closing;
    },
  };
}
