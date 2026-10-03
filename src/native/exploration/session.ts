import { fork } from 'node:child_process';
import { remote } from 'webdriverio';
import { capabilities, connection, type ResolvedNativeSession } from '../environment/schema.ts';
import { startOwnedServer } from '../appium/server.ts';
import { isRecord, maxCodeBytes, parseObservations } from '../../worker/protocol.ts';
import type { JavaScriptSession } from '../../worker/javascript-session.ts';

export async function startNativeSession(target: ResolvedNativeSession, timeoutMs = 60_000): Promise<JavaScriptSession> {
  const desired = capabilities(target);
  if (target.environment.serverUrl) connection(target.environment.serverUrl);
  const owned = target.environment.serverUrl ? undefined : await startOwnedServer();
  const endpoint = connection(target.environment.serverUrl ?? owned!.url);
  let driver: Awaited<ReturnType<typeof remote>>;
  try {
    driver = await remote({ ...endpoint, capabilities: desired, logLevel: 'silent',
      connectionRetryCount: 0, connectionRetryTimeout: 180_000 });
  } catch (error) { await owned?.close(); throw error; }
  let child: ReturnType<typeof fork>;
  try { child = fork(new URL('./worker.ts', import.meta.url), [], {
    execArgv: ['--experimental-strip-types'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key))),
  }); } catch (error) {
    try { await driver.deleteSession(); } finally { await owned?.close(); }
    throw error;
  }
  let sequence = 0;
  let pending: { id: number; resolve(value: unknown): void; reject(error: Error): void } | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  child.stderr?.on('data', () => {});
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    pending?.reject(new Error('Native session closed.'));
    pending = undefined;
    closing = (async () => {
      child.kill('SIGKILL');
      await exited;
      try { await driver.deleteSession(); } finally { await owned?.close(); child.stderr?.destroy(); }
    })();
    return closing;
  };
  const fail = (error: Error) => { pending?.reject(error); pending = undefined; void close().catch(() => {}); };
  child.on('error', fail);
  child.on('exit', () => { if (!closed) fail(new Error('Native worker exited unexpectedly.')); });
  child.on('message', (message: unknown) => {
    if (closed) return;
    if (!isRecord(message) || message.id !== pending?.id) { fail(new Error('Invalid native IPC response.')); return; }
    const request = pending!; pending = undefined;
    if (typeof message.error === 'string') request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  function request(operation: string, payload: object, signal?: AbortSignal): Promise<unknown> {
    if (closed) return Promise.reject(new Error('Native session closed.'));
    if (pending) return Promise.reject(new Error('Native worker is busy.'));
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => fail(new Error('Native execution timed out.')), timeoutMs);
      const abort = () => fail(new Error('Native execution aborted.'));
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      pending = { id, resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } };
      signal?.addEventListener('abort', abort, { once: true });
      child.send({ id, operation, ...payload }, error => { if (error) fail(error); });
    });
  }
  try { await request('initialize', { options: { ...endpoint, sessionId: driver.sessionId, capabilities: driver.capabilities, logLevel: 'silent', connectionRetryCount: 0, connectionRetryTimeout: 30_000 } }); }
  catch (error) { await close(); throw error; }
  return { close, async execute(code, signal) {
    if (!code.trim() || Buffer.byteLength(code) > maxCodeBytes) throw new Error('Code must be nonempty and at most 64 KiB.');
    const result = await request('execute', { code }, signal);
    try { return parseObservations(result); } catch (error) { await close(); throw error; }
  } };
}
