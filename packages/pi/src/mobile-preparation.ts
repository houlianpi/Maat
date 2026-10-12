import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import * as core from '@houlianpi/maat-core';
import type {
  MaatApi,
  NativeDeviceSelector,
  IosWdaInput,
  IosWdaInspection,
} from '@houlianpi/maat-core';

const exec = promisify(execFile);
type Adapter = ReturnType<MaatApi['platforms']['current']>;
type Hints = {
  serverUrl?: string;
  device?: NativeDeviceSelector;
  capabilities?: Record<string, unknown>;
};
type WdaInput = IosWdaInput;
type WdaInspection = IosWdaInspection;
export type MobilePreparationResult = {
  taskId: string;
  action: 'status' | 'start-appium' | 'build-ios-wda';
  state: 'running' | 'ready' | 'completed' | 'failed' | 'cancelled';
  summary: string;
  category?: string;
  error?: string;
  cleanupError?: string;
  serviceResponding?: boolean;
  owned?: boolean;
  wda?: Omit<WdaInspection, 'summary' | 'capabilities'>;
};
export type MobilePreparationInput = {
  action: MobilePreparationResult['action'];
  taskId?: string;
  waitSeconds?: number;
  signingAuthorized?: boolean;
};
type Task = {
  result: MobilePreparationResult;
  controller: AbortController;
  done?: Promise<void>;
  work?: Promise<void>;
  workSettlement?: Promise<void>;
  child?: ChildProcess;
  stop?: Promise<void>;
  endpoint?: URL;
  listening: boolean;
  outputTail: string;
};
/** Also bound broken/misbehaving collaborators that do not honor AbortSignal. */
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
type Dependencies = {
  resolveAppium: typeof core.resolveAppiumCommand;
  resolveAndroid: typeof core.resolveAndroidTools;
  spawn: (file: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  responding: (endpoint: URL, signal: AbortSignal) => Promise<boolean>;
  occupied: (endpoint: URL, signal: AbortSignal) => Promise<boolean>;
  stop: (child: ChildProcess) => Promise<void>;
  inspectWda: (input: WdaInput) => Promise<WdaInspection>;
  prepareWda: (input: WdaInput & { signingAuthorized: boolean }) => Promise<WdaInspection>;
  appiumDeadlineMs: number;
  wdaDeadlineMs: number;
  pollMs: number;
  cleanupGraceMs: number;
};

const ownFailures = new WeakSet<Error>();
function failure(category: string, summary: string): Error & { category: string } {
  const error = Object.assign(new Error(summary), { category });
  ownFailures.add(error);
  return error;
}
function safeCoreFailure(error: unknown): Error & { category: string } {
  const message = error instanceof Error ? error.message : '';
  const code = /^((?:IOS_WDA|APPIUM_CLI|ANDROID_SDK)_[A-Z_]+):/.exec(message)?.[1];
  if (!code)
    return failure(
      'PREPARATION_FAILED',
      'Preparation failed. Inspect the selected installation/configuration locally; raw process and signing logs are withheld.',
    );
  const summary =
    code === 'IOS_WDA_SIGNING_REQUIRED'
      ? 'Complete Xcode account authorization and select the existing intended Team yourself; no account or Team was chosen automatically.'
      : code === 'IOS_WDA_DEVICE_REQUIRED'
        ? 'Connect and select exactly one paired physical iPhone; no device was substituted.'
        : code === 'IOS_WDA_CLEANUP_FAILED'
          ? 'Core reported that owned WDA build-process cleanup failed; the original failure remains relevant.'
          : `Core preparation stopped (${code}); no automatic replay or device action was performed.`;
  return failure(code, summary);
}

function endpointFor(hints: Hints): URL {
  let url: URL;
  try {
    url = new URL(hints.serverUrl ?? 'http://127.0.0.1:4723');
  } catch {
    throw failure('INVALID_ENDPOINT', 'Configure a valid local Appium endpoint.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw failure(
      'LOCAL_ENDPOINT_REQUIRED',
      'Preparation supports only a credential-free loopback Android/iOS endpoint.',
    );
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url;
}

async function responding(endpoint: URL, signal: AbortSignal): Promise<boolean> {
  const status = new URL(endpoint);
  status.pathname = `${endpoint.pathname.replace(/\/$/, '')}/status`;
  try {
    const response = await fetch(status, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
      redirect: 'error',
    });
    // Bound the response rather than buffering arbitrary data from a port occupant.
    const reader = response.body?.getReader();
    if (!reader) return false;
    let text = '';
    try {
      while (text.length < 16_384) {
        const { done, value } = await reader.read();
        if (done) {
          const body = JSON.parse(text);
          const status = body?.value;
          return (
            response.ok &&
            status?.ready === true &&
            typeof status?.build?.version === 'string' &&
            /^[23]\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(status.build.version) &&
            typeof status?.message === 'string' &&
            /^The server is ready to accept new connections\.?$/.test(status.message)
          );
        }
        text += Buffer.from(value).toString('utf8');
      }
      return false;
    } finally {
      await reader.cancel();
    }
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

function listenerMatches(output: string, endpoint: URL): boolean {
  const plain = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const matches = plain.matchAll(
    /Appium REST http interface listener started on (https?:\/\/[^\s]+)(?=\s)/gi,
  );
  for (const match of matches) {
    try {
      const listening = new URL(match[1]!);
      if (
        listening.protocol === endpoint.protocol &&
        listening.hostname === endpoint.hostname &&
        !listening.username &&
        !listening.password &&
        (listening.port || '80') === (endpoint.port || '80')
      )
        return true;
    } catch {
      // A partial/malformed line is not ownership proof; keep waiting.
    }
  }
  return false;
}

async function occupied(endpoint: URL, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: endpoint.hostname.replace(/^\[|\]$/g, ''),
      port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    });
    const finish = (value: boolean) => {
      socket.destroy();
      signal.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => {
      socket.destroy();
      reject(signal.reason);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    signal.addEventListener('abort', abort, { once: true });
  });
}

// Source-only seam for ownership regression tests; not exported by the package.
// The child must be spawned into its own POSIX group, with handle/stdio retained.
export async function stopOwnedAppiumChild(
  child: ChildProcess,
  dependencies = {
    platform: process.platform,
    kill: process.kill,
    taskkill: async (pid: number) => {
      await exec('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: 3_000,
        maxBuffer: 16_384,
        windowsHide: true,
      });
    },
  },
): Promise<void> {
  const pid = child.pid;
  if (!pid) return; // spawn failure, no owned process
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new Error('Owned Appium process identity is invalid; cleanup was not attempted.');
  if (dependencies.platform === 'win32') {
    // After root exit a PID-based taskkill cannot prove ownership of survivors.
    // Do not target an exited/reusable PID or claim successful tree cleanup.
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('Windows owned Appium tree cleanup cannot be confirmed after root exit.');
    await dependencies.taskkill(pid);
    return;
  }
  const errors: unknown[] = [];
  const kill = (signal: NodeJS.Signals) => {
    try {
      dependencies.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') errors.push(error);
    }
  };
  // The owned group survives root exit/reparenting. Never cancel escalation on
  // parent close, even when descendants ignore TERM and inherited stdio is closed.
  kill('SIGTERM');
  await delay(250);
  kill('SIGKILL');
  if (errors.length) throw new AggregateError(errors, 'Owned Appium process cleanup failed.');
}

const defaults: Dependencies = {
  resolveAppium: core.resolveAppiumCommand,
  resolveAndroid: core.resolveAndroidTools,
  spawn: (file, args, env) =>
    spawn(file, args, {
      env,
      shell: false,
      // setsid creates an owned killable POSIX group, not an untracked daemon:
      // keep the child handle/stdio and never unref it.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }),
  responding,
  occupied,
  stop: stopOwnedAppiumChild,
  inspectWda: core.inspectIosWda,
  prepareWda: core.prepareIosWda,
  appiumDeadlineMs: 60_000,
  wdaDeadlineMs: 180_000,
  pollMs: 250,
  cleanupGraceMs: 3_000,
};

/** Two concrete host-side jobs, not a command runner, planner or service manager. */
export class MobilePreparation {
  private readonly tasks = new Map<string, Task>();
  private readonly appiumFlights = new Map<string, Task>();
  private readonly wdaFlights = new Map<Adapter, Task>();
  private readonly wdaKeys = new Map<Adapter, string>();
  private closing?: Promise<void>;
  private closed = false;
  private readonly deps: Dependencies;
  private readonly maat: MaatApi;

  constructor(maat: MaatApi, dependencies: Partial<Dependencies> = {}) {
    this.maat = maat;
    this.deps = { ...defaults, ...dependencies };
  }

  async execute(
    input: MobilePreparationInput,
    signal?: AbortSignal,
  ): Promise<MobilePreparationResult> {
    if (!['status', 'start-appium', 'build-ios-wda'].includes(input.action))
      throw new Error('Unknown mobile preparation action.');
    const wait = input.waitSeconds ?? 0;
    if (!Number.isFinite(wait) || wait < 0 || wait > 20)
      throw new Error('waitSeconds must be between 0 and 20.');
    if (input.signingAuthorized !== undefined && typeof input.signingAuthorized !== 'boolean')
      throw new Error('signingAuthorized must be a boolean.');
    if (input.taskId !== undefined && (typeof input.taskId !== 'string' || !input.taskId))
      throw new Error('taskId must be a nonempty string.');
    if (input.taskId && input.action !== 'status')
      throw new Error('Use status with taskId to track existing work; never replay a start.');
    signal?.throwIfAborted();
    if (this.closed) throw new Error('Mobile preparation is closed.');
    if (input.taskId) {
      const task = this.tasks.get(input.taskId);
      if (!task) throw new Error('Unknown mobile preparation taskId.');
      await this.wait(task, wait, signal);
      if (task.result.state === 'ready' && task.endpoint) await this.refresh(task, signal);
      return this.result(task);
    }
    const adapter = this.maat.platforms.current();
    if (adapter.id !== 'android' && adapter.id !== 'ios')
      throw new Error('Mobile preparation requires Android or iOS.');
    // Resolve saved hints read-only before capturing device/platform identity.
    await bounded(adapter.initialize(), this.readSignal(signal));
    signal?.throwIfAborted();
    if (this.closed) throw new Error('Mobile preparation is closed.');
    if (this.maat.platforms.current() !== adapter)
      throw new Error('Platform changed while reading preparation configuration.');
    const hints = structuredClone(
      (adapter as Adapter & { sessionHints?: Hints }).sessionHints ?? {},
    );
    const endpoint = endpointFor(hints);
    if (input.action === 'status') {
      const existing = this.appiumFlights.get(endpoint.href);
      if (existing) {
        await this.wait(existing, wait, signal);
        if (existing.result.state === 'ready') await this.refresh(existing, signal);
        return this.result(existing);
      }
      const task = this.create('status');
      task.endpoint = endpoint;
      try {
        const readSignal = this.readSignal(signal);
        task.result.serviceResponding = await bounded(
          this.deps.responding(endpoint, readSignal),
          readSignal,
        );
        task.result.owned = false;
        task.result.state = task.result.serviceResponding ? 'ready' : 'completed';
        task.result.summary = task.result.serviceResponding
          ? 'Existing Appium service responds; it is not owned and phone readiness is not established.'
          : 'The selected Appium endpoint is not responding; no service was started.';
        if (adapter.id === 'ios') {
          const readSignal = this.readSignal(signal);
          const inspection = await bounded(
            this.deps.inspectWda({
              device: hints.device,
              capabilities: hints.capabilities,
              signal: readSignal,
            }),
            readSignal,
          );
          task.result.wda = this.facts(inspection);
          task.result.summary += ` WDA inspection: ${inspection.state}.`;
        }
      } catch (error) {
        this.fail(task, error);
      }
      return this.result(task);
    }
    if (input.action === 'start-appium') {
      const existing = this.appiumFlights.get(endpoint.href);
      if (existing) {
        await this.wait(existing, wait, signal);
        if (existing.result.state === 'ready') await this.refresh(existing, signal);
        return this.result(existing);
      }
      const task = this.create(input.action);
      task.endpoint = endpoint;
      this.appiumFlights.set(endpoint.href, task);
      this.launch(task, this.deps.appiumDeadlineMs, (bounded) =>
        this.startAppium(task, adapter.id, bounded),
      );
      await this.wait(task, wait, signal);
      return this.result(task);
    }
    if (adapter.id !== 'ios') throw new Error('build-ios-wda requires iOS.');
    const wdaKey = JSON.stringify({
      hints,
      session: adapter.status().session,
      authorized: input.signingAuthorized === true,
    });
    const existing = this.wdaFlights.get(adapter);
    if (existing && (existing.result.state === 'running' || this.wdaKeys.get(adapter) === wdaKey)) {
      await this.wait(existing, wait, signal);
      return this.result(existing);
    }
    const task = this.create(input.action);
    this.wdaFlights.set(adapter, task);
    this.wdaKeys.set(adapter, wdaKey);
    this.launch(task, this.deps.wdaDeadlineMs, async (bounded) => {
      const inspection = await this.deps.inspectWda({
        device: hints.device,
        capabilities: hints.capabilities,
        signal: bounded,
      });
      bounded.throwIfAborted();
      task.result.wda = this.facts(inspection);
      const result =
        inspection.state === 'ready'
          ? inspection
          : input.signingAuthorized === true
            ? await this.deps.prepareWda({
                device: hints.device,
                capabilities: hints.capabilities,
                signal: bounded,
                signingAuthorized: true,
              })
            : (() => {
                throw failure(
                  'SIGNING_AUTHORIZATION_REQUIRED',
                  'WDA needs signing preparation. Obtain user authorization; no build or signing change was performed.',
                );
              })();
      bounded.throwIfAborted();
      task.result.wda = this.facts(result);
      if (result.state !== 'ready')
        throw failure(
          'WDA_SIGNING_REQUIRED',
          'WDA is not reusable yet. Select the existing intended Team in Xcode if signing is missing; do not choose an account automatically.',
        );
      if (
        this.maat.platforms.current() !== adapter ||
        JSON.stringify((adapter as Adapter & { sessionHints?: Hints }).sessionHints ?? {}) !==
          JSON.stringify(hints)
      )
        throw failure(
          'CONFIGURATION_CHANGED',
          'WDA preparation finished for the original configuration, but the selected platform/device or hints changed. Nothing was applied.',
        );
      if (
        result.capabilities &&
        Object.keys(result.capabilities).some(
          (key) =>
            JSON.stringify(hints.capabilities?.[key]) !== JSON.stringify(result.capabilities![key]),
        )
      ) {
        if (adapter.status().session === 'ready')
          throw failure(
            'SESSION_IN_USE',
            'Reusable WDA build is ready, but changing hints would close an active phone Session. Nothing was applied; release that Session only when phone interaction is no longer needed.',
          );
        await this.maat.platforms.configureSession({ capabilities: result.capabilities });
        bounded.throwIfAborted();
      }
      task.result.state = 'completed';
      task.result.summary =
        inspection.state === 'ready'
          ? 'Existing device-matching WDA build reused; no rebuild. Phone readiness still requires check_device_ready.'
          : 'Authorized WDA build completed and reuse hints applied. No phone readiness or business success is claimed.';
    });
    await this.wait(task, wait, signal);
    return this.result(task);
  }

  private readSignal(signal?: AbortSignal) {
    return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5_000)]);
  }

  private create(action: MobilePreparationResult['action']): Task {
    const task: Task = {
      result: {
        taskId: randomUUID(),
        action,
        state: 'running',
        summary: 'Preparation is running; query this taskId without starting again.',
      },
      controller: new AbortController(),
      listening: false,
      outputTail: '',
    };
    this.tasks.set(task.result.taskId, task);
    return task;
  }

  private facts(value: WdaInspection): NonNullable<MobilePreparationResult['wda']> {
    // Explicit allowlist: never copy future Core fields or raw summaries.
    return {
      state: value.state,
      signingConfigured: value.signingConfigured,
      ...(value.profile
        ? {
            profile: {
              createdAt: value.profile.createdAt,
              expiresAt: value.profile.expiresAt,
              expired: value.profile.expired,
              includesSelectedDevice: value.profile.includesSelectedDevice,
            },
          }
        : {}),
      ...(value.certificate
        ? {
            certificate: {
              expiresAt: value.certificate.expiresAt,
              expired: value.certificate.expired,
            },
          }
        : {}),
    };
  }

  private result(task: Task): MobilePreparationResult {
    return structuredClone(task.result);
  }

  private fail(task: Task, error: unknown) {
    if (task.result.state === 'failed' || task.result.state === 'cancelled') return;
    const categorized =
      error instanceof Error && ownFailures.has(error)
        ? (error as Error & { category: string })
        : safeCoreFailure(error);
    const cancelled = task.controller.signal.aborted;
    task.result.state = cancelled ? 'cancelled' : 'failed';
    task.result.category = cancelled
      ? 'CANCELLED'
      : (categorized?.category ?? 'PREPARATION_FAILED');
    // Only our own categorized errors are safe, never raw child/helper exceptions.
    task.result.error = categorized.message;
    task.result.summary = task.result.error;
    if (task.result.action === 'start-appium') task.result.serviceResponding = false;
  }

  private launch(task: Task, deadline: number, run: (signal: AbortSignal) => Promise<void>) {
    const timeout = new AbortController();
    const timer = setTimeout(
      () =>
        timeout.abort(
          failure(
            'PREPARATION_TIMEOUT',
            'Preparation exceeded its overall deadline; owned work is being stopped.',
          ),
        ),
      deadline,
    );
    const signal = AbortSignal.any([task.controller.signal, timeout.signal]);
    // Retain actual work independently of the abortable outer wait. In particular,
    // Core may still be escalating/killing its owned build group after abort.
    task.work = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return run(signal);
    });
    task.workSettlement = task.work.then(
      () => {},
      (error: unknown) => {
        if (signal.aborted && !this.expectedAbort(error, signal))
          this.cleanupFailure(
            task,
            'Owned preparation work reported an additional cleanup failure; raw errors are withheld.',
          );
      },
    );
    task.done = (async () => {
      try {
        await bounded(task.work!, signal);
      } catch (error) {
        this.fail(task, signal.aborted ? signal.reason : error);
        await Promise.all([this.stop(task), this.settleWork(task)]);
      } finally {
        clearTimeout(timer);
      }
    })();
  }

  private expectedAbort(error: unknown, signal: AbortSignal): boolean {
    return (
      error === signal.reason ||
      (error instanceof Error &&
        (/^IOS_WDA_PREPARATION_CANCELLED:/.test(error.message) ||
          (error.name === 'AbortError' && error.cause === signal.reason)) &&
        !(error instanceof AggregateError))
    );
  }

  private cleanupFailure(task: Task, summary: string) {
    if (!task.result.cleanupError) task.result.cleanupError = summary;
    else if (!task.result.cleanupError.includes(summary)) task.result.cleanupError += ` ${summary}`;
  }

  private async settleWork(task: Task) {
    if (!task.workSettlement) return;
    const grace = new AbortController();
    // Referenced timer: even an uncooperative helper with no live child/IO must
    // not leave close() as an unresolved top-level await at process exit.
    const timer = setTimeout(() => grace.abort(), this.deps.cleanupGraceMs);
    try {
      // Independent cleanup grace, never the already-aborted task signal.
      await bounded(task.workSettlement, grace.signal);
    } catch {
      this.cleanupFailure(
        task,
        'Owned preparation work did not settle within the cleanup grace; cleanup cannot be confirmed.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async wait(task: Task, seconds: number, signal?: AbortSignal) {
    if (!seconds || !task.done || task.result.state !== 'running') return;
    const stop = new AbortController();
    try {
      await Promise.race([
        task.done,
        delay(seconds * 1_000, undefined, {
          signal: AbortSignal.any([stop.signal, ...(signal ? [signal] : [])]),
        }),
      ]);
      signal?.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally {
      stop.abort();
    }
    // Cancelling a wait does not cancel or restart possibly executed work.
  }

  private async startAppium(task: Task, platform: string, signal: AbortSignal) {
    const endpoint = task.endpoint!;
    if (await this.deps.responding(endpoint, signal)) {
      signal.throwIfAborted();
      task.result.state = 'ready';
      task.result.owned = false;
      task.result.serviceResponding = true;
      task.result.summary =
        'Existing Appium service responds and is preserved, not owned. This is serviceResponding only, not deviceReady or business success.';
      return;
    }
    if (await this.deps.occupied(endpoint, signal))
      throw failure(
        'ENDPOINT_OCCUPIED',
        'The exact selected endpoint is occupied but not healthy Appium. Its process was preserved; no fallback or second server was started.',
      );
    if (endpoint.protocol !== 'http:')
      throw failure(
        'ENDPOINT_CONFIGURATION_REQUIRED',
        'An absent HTTPS endpoint cannot be started without its TLS configuration. No endpoint substitution was made.',
      );
    const command = await this.deps.resolveAppium({ signal });
    const tools = platform === 'android' ? await this.deps.resolveAndroid({ signal }) : undefined;
    signal.throwIfAborted();
    const child = this.deps.spawn(
      command.file,
      [
        ...command.args,
        '--address',
        endpoint.hostname.replace(/^\[|\]$/g, ''),
        '--port',
        endpoint.port || '80',
        '--base-path',
        endpoint.pathname,
      ],
      { ...process.env, ...tools?.environment },
    );
    task.child = child;
    task.result.owned = true;
    const lost = (error: Error) => {
      this.fail(task, error);
      if (!signal.aborted) task.controller.abort(error);
      void this.stop(task);
    };
    child.once('error', () =>
      lost(
        failure(
          'APPIUM_PROCESS_ERROR',
          'The owned Appium process failed to start or run. Check the installed CLI; no raw stderr was exposed.',
        ),
      ),
    );
    child.once('exit', () => {
      if (!this.closed && task.result.state !== 'failed' && task.result.state !== 'cancelled')
        lost(
          failure(
            'APPIUM_PROCESS_EXITED',
            'The owned Appium process exited; a responding port cannot override this failed task.',
          ),
        );
    });
    child.stderr?.resume();
    child.stdout?.on('data', (chunk: Buffer) => {
      task.outputTail = (task.outputTail + chunk.toString()).slice(-2_048);
      if (listenerMatches(task.outputTail, endpoint)) task.listening = true;
    });
    while (true) {
      signal.throwIfAborted();
      if (task.listening && (await this.deps.responding(endpoint, signal))) {
        signal.throwIfAborted();
        if (task.result.state !== 'running') return;
        task.result.state = 'ready';
        task.result.serviceResponding = true;
        task.result.summary =
          'Owned Appium service responds at the exact selected endpoint. This is serviceResponding only, not deviceReady or business success; continue with check_device_ready.';
        return;
      }
      await delay(this.deps.pollMs, undefined, { signal });
    }
  }

  private async refresh(task: Task, signal?: AbortSignal) {
    try {
      const readSignal = this.readSignal(signal);
      if (!(await bounded(this.deps.responding(task.endpoint!, readSignal), readSignal))) {
        this.fail(
          task,
          failure(
            'APPIUM_NOT_RESPONDING',
            'The previously ready service no longer responds. No restart or device action was performed.',
          ),
        );
        await this.stop(task);
      }
    } catch (error) {
      signal?.throwIfAborted();
      this.fail(task, error);
      await this.stop(task);
    }
  }

  private stop(task: Task): Promise<void> {
    if (!task.child) return Promise.resolve();
    return (task.stop ??= bounded(this.deps.stop(task.child), AbortSignal.timeout(4_000)).catch(
      () => {
        this.cleanupFailure(
          task,
          'Owned Appium process-tree cleanup failed or could not be confirmed; the primary task result is preserved.',
        );
      },
    ));
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      for (const task of this.tasks.values()) {
        task.controller.abort(failure('CANCELLED', 'Preparation was cancelled by host shutdown.'));
        if (task.result.owned && task.result.state === 'ready') {
          task.result.state = 'cancelled';
          task.result.serviceResponding = false;
          task.result.summary = 'Owned Appium service stopped by host shutdown.';
        }
      }
      await Promise.all(
        [...this.tasks.values()].map(async (task) => {
          await task.done;
          await this.stop(task);
        }),
      );
      if ([...this.tasks.values()].some((task) => task.result.cleanupError))
        throw new Error(
          'Mobile preparation shutdown could not stop every owned process; primary task errors were preserved.',
        );
    })());
  }
}

const runtimeClosures = new WeakMap<MobilePreparation, Promise<void>>();
/** Keep Worker/Session shutdown ahead of owned service shutdown; report both errors. */
export function closeMobileRuntime(maat: MaatApi, preparation: MobilePreparation): Promise<void> {
  const existing = runtimeClosures.get(preparation);
  if (existing) return existing;
  const closing = (async () => {
    const errors: unknown[] = [];
    try {
      await bounded(maat.close(), AbortSignal.timeout(10_000));
    } catch (error) {
      errors.push(error);
    }
    try {
      await preparation.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(errors, 'Session and mobile preparation cleanup failed.');
  })();
  runtimeClosures.set(preparation, closing);
  return closing;
}
