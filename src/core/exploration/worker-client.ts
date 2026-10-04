import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isRecord, maxCodeBytes, parseObservations } from '../../worker/protocol.ts';
import type { JavaScriptSession } from '../../worker/javascript-session.ts';

export async function createExplorationWorker(
  module: URL,
  options: unknown,
  timeoutMs = 60_000,
  initializationTimeoutMs = 30_000,
): Promise<JavaScriptSession> {
  const child = fork(fileURLToPath(new URL('./worker-host.ts', import.meta.url)), [], {
    execArgv: ['--experimental-strip-types'],
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key),
      ),
    ),
  });
  let id = 0;
  let pending:
    | { id: number; resolve(value: unknown): void; reject(error: Error): void }
    | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let terminalError: Error | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  const killGroup = () => {
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  const terminate = (error: Error) => {
    terminalError ??= error;
    closed = true;
    pending?.reject(error);
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
    pending = undefined;
    if (typeof message.error === 'string') request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  child.on('error', (error) => terminate(error));
  function request(
    operation: string,
    payload: object,
    signal?: AbortSignal,
    deadlineMs = timeoutMs,
  ): Promise<unknown> {
    if (closed) return Promise.reject(terminalError ?? new Error('Exploration Worker is closed.'));
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
      const abort = () => terminate(new Error('Exploration execution aborted.'));
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
  await request('initialize', { module: module.href, options }, undefined, initializationTimeoutMs);
  return {
    async execute(code, signal) {
      if (!code.trim() || Buffer.byteLength(code) > maxCodeBytes)
        throw new Error('Code must be nonempty and at most 64 KiB.');
      return parseObservations(await request('execute', { code }, signal));
    },
    close() {
      if (closing) return closing;
      const alreadyClosed = closed;
      closed = true;
      closing = (async () => {
        if (!alreadyClosed && child.connected) child.send({ id: ++id, operation: 'close' });
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 500))]);
        if (child.exitCode === null && child.signalCode === null) killGroup();
        await exited;
        child.stderr?.destroy();
      })();
      return closing;
    },
  };
}
