import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConnectionJobNotFoundError,
  ConnectionJobSupervisor,
} from '../packages/core/src/mobile/connection/job-supervisor.ts';
import {
  MobileBusyError,
  assertMobileCreationAllowed,
  runMobileOperation,
} from '../packages/core/src/mobile/devices/coordinator.ts';
import { PhoneSessionCreationUncertainError } from '../packages/core/src/mobile/contracts/device.ts';
import { MaatApi } from '../packages/core/src/api/maat-api.ts';
import { PlatformRegistry } from '../packages/core/src/core/platforms/registry.ts';
import type { PlatformAdapter } from '../packages/core/src/core/platforms/contracts.ts';
import { aggregateSetup } from '../packages/core/src/setup-assistant/model.ts';

const success = {
  platform: 'android' as const,
  ready: true as const,
  proof: {
    phoneUnlocked: true as const,
    sessionUsable: true as const,
    sourceReadable: true as const,
    viewportReadable: true as const,
    screenshotReadable: false,
  },
  observations: [{ type: 'text' as const, text: '<safe />' }],
};
const directOwner = Symbol('direct-test-caller');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function trackedSignal(controller: AbortController): {
  signal: AbortSignal;
  listenerCount: () => number;
} {
  let listeners = 0;
  const signal = controller.signal;
  return {
    signal: {
      get aborted() {
        return signal.aborted;
      },
      get reason() {
        return signal.reason;
      },
      throwIfAborted: () => signal.throwIfAborted(),
      addEventListener: (...args: Parameters<AbortSignal['addEventListener']>) => {
        listeners += 1;
        signal.addEventListener(...args);
      },
      removeEventListener: (...args: Parameters<AbortSignal['removeEventListener']>) => {
        listeners -= 1;
        signal.removeEventListener(...args);
      },
    } as AbortSignal,
    listenerCount: () => listeners,
  };
}

test('two synchronous starts execute once and the conflict discloses no job id', async () => {
  const supervisor = new ConnectionJobSupervisor();
  const gate = deferred<typeof success>();
  let calls = 0;
  const first = supervisor.start(
    directOwner,
    async () => {
      calls += 1;
      return gate.promise;
    },
    { waitSeconds: 0 },
  );
  await assert.rejects(
    supervisor.start(directOwner, async () => success, { waitSeconds: 0 }),
    (error: unknown) =>
      error instanceof MobileBusyError && !('jobId' in (error as unknown as object)),
  );
  assert.equal(calls, 1);
  gate.resolve(success);
  const terminal = await supervisor.query(directOwner, (await first).jobId, { waitSeconds: 1 });
  assert.equal(terminal.state, 'succeeded');
});

test('wait expiry and caller abort stop only waiters; later query observes one execution', async () => {
  const supervisor = new ConnectionJobSupervisor();
  const gate = deferred<typeof success>();
  let calls = 0;
  let jobSignal: AbortSignal | undefined;
  const started = await supervisor.start(
    directOwner,
    async (signal) => {
      calls += 1;
      jobSignal = signal;
      return gate.promise;
    },
    { waitSeconds: 0 },
  );
  assert.equal(started.state, 'running');
  const caller = new AbortController();
  const waiting = supervisor.query(directOwner, started.jobId, {
    waitSeconds: 20,
    signal: caller.signal,
  });
  caller.abort();
  await assert.rejects(waiting, /abort/i);
  assert.equal(jobSignal?.aborted, false);
  gate.resolve(success);
  const terminal = await supervisor.query(directOwner, started.jobId, { waitSeconds: 1 });
  assert.equal(terminal.jobId, started.jobId);
  assert.equal(terminal.state, 'succeeded');
  assert.equal(calls, 1);
});

test('real wait expiry leaves the job running and repeated queries clean waiter listeners', async () => {
  const supervisor = new ConnectionJobSupervisor();
  const gate = deferred<typeof success>();
  let calls = 0;
  const startedAt = Date.now();
  const started = await supervisor.start(
    directOwner,
    async () => {
      calls += 1;
      return gate.promise;
    },
    { waitSeconds: 0.01, deadlineMs: 5_000 },
  );
  assert.ok(Date.now() - startedAt >= 5);
  assert.equal(started.state, 'running');

  for (let index = 0; index < 5; index += 1) {
    const tracked = trackedSignal(new AbortController());
    const snapshot = await supervisor.query(directOwner, started.jobId, {
      waitSeconds: 0.005,
      signal: tracked.signal,
    });
    assert.equal(snapshot.state, 'running');
    assert.equal(tracked.listenerCount(), 0);
  }

  gate.resolve(success);
  const terminal = await supervisor.query(directOwner, started.jobId, { waitSeconds: 1 });
  assert.equal(terminal.state, 'succeeded');
  assert.equal(calls, 1);
});

test('job settlement cleans a long waiter before a later caller abort', async () => {
  const supervisor = new ConnectionJobSupervisor();
  const gate = deferred<typeof success>();
  const started = await supervisor.start(directOwner, async () => gate.promise, {
    waitSeconds: 0,
  });
  const controller = new AbortController();
  const tracked = trackedSignal(controller);
  let completions = 0;
  const waiting = supervisor
    .query(directOwner, started.jobId, {
      waitSeconds: 20,
      signal: tracked.signal,
    })
    .then((snapshot) => {
      completions += 1;
      return snapshot;
    });
  assert.equal(tracked.listenerCount(), 1);
  gate.resolve(success);
  const terminal = await waiting;
  assert.equal(terminal.state, 'succeeded');
  assert.equal(tracked.listenerCount(), 0);
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completions, 1);
});

test('unknown and foreign ids are stable not-found without start fallback', async () => {
  const supervisor = new ConnectionJobSupervisor();
  for (const id of ['unknown', 'foreign']) {
    await assert.rejects(
      supervisor.query(directOwner, id, { waitSeconds: 0 }),
      (error: unknown) =>
        error instanceof ConnectionJobNotFoundError &&
        error.code === 'connection-job-not-found' &&
        error.message === 'Connection job was not found.',
    );
  }
});

test('cancel aborts the owned operation once and is terminal-idempotent', async () => {
  const supervisor = new ConnectionJobSupervisor();
  let aborts = 0;
  const started = await supervisor.start(
    directOwner,
    async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborts += 1;
            reject(signal.reason);
          },
          { once: true },
        );
      });
      return success;
    },
    { waitSeconds: 0 },
  );
  const cancelled = await supervisor.cancel(directOwner, started.jobId, { waitSeconds: 1 });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(aborts, 1);
  assert.deepEqual(
    await supervisor.cancel(directOwner, started.jobId, { waitSeconds: 0 }),
    cancelled,
  );
  assert.equal(aborts, 1);
});

test('cancellation before dispatch performs no POST; possible POST becomes creation-uncertain', async () => {
  const before = new ConnectionJobSupervisor();
  let posts = 0;
  const preDispatch = await before.start(
    directOwner,
    async (signal) => {
      await new Promise((resolve) => setImmediate(resolve));
      signal.throwIfAborted();
      posts += 1;
      return success;
    },
    { waitSeconds: 0 },
  );
  const cancelled = await before.cancel(directOwner, preDispatch.jobId, { waitSeconds: 1 });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(posts, 0);

  const after = new ConnectionJobSupervisor();
  const possiblePost = await after.start(
    directOwner,
    async (signal) => {
      posts += 1;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () =>
            reject(
              Object.assign(new Error('private transport detail'), {
                code: 'phone-session-creation-uncertain',
              }),
            ),
          { once: true },
        );
      });
      return success;
    },
    { waitSeconds: 0 },
  );
  const uncertain = await after.cancel(directOwner, possiblePost.jobId, { waitSeconds: 1 });
  assert.equal(uncertain.state, 'creation-uncertain');
  assert.equal(posts, 1);
  assert.equal(JSON.stringify(uncertain).includes('private transport detail'), false);
});

test('creation uncertainty remains active and blocks starts and cancellation', async () => {
  const supervisor = new ConnectionJobSupervisor();
  const uncertain = Object.assign(new Error('raw endpoint and secret'), {
    code: 'phone-session-creation-uncertain',
  });
  const started = await supervisor.start(directOwner, async () => Promise.reject(uncertain), {
    waitSeconds: 1,
  });
  assert.equal(started.state, 'creation-uncertain');
  assert.equal(JSON.stringify(started).includes('raw endpoint'), false);
  assert.deepEqual(
    await supervisor.cancel(directOwner, started.jobId, { waitSeconds: 0 }),
    started,
  );
  await assert.rejects(
    supervisor.start(directOwner, async () => success, { waitSeconds: 0 }),
    MobileBusyError,
  );
});

test('terminal retention expires by ttl, caps at 32, and queries do not renew it', async () => {
  let now = 0;
  let sequence = 0;
  const supervisor = new ConnectionJobSupervisor({
    now: () => now,
    randomId: () => `opaque-${++sequence}`,
    terminalTtlMs: 600_000,
    maxTerminalRecords: 32,
  });
  const first = await supervisor.start(directOwner, async () => success, { waitSeconds: 1 });
  assert.equal(
    (await supervisor.query(directOwner, first.jobId, { waitSeconds: 0 })).state,
    'succeeded',
  );
  now = 599_999;
  await supervisor.query(directOwner, first.jobId, { waitSeconds: 0 });
  now = 600_000;
  await assert.rejects(
    supervisor.query(directOwner, first.jobId, { waitSeconds: 0 }),
    ConnectionJobNotFoundError,
  );

  const ids: string[] = [];
  for (let index = 0; index < 33; index += 1) {
    now += 1;
    ids.push((await supervisor.start(directOwner, async () => success, { waitSeconds: 1 })).jobId);
  }
  await assert.rejects(
    supervisor.query(directOwner, ids[0]!, { waitSeconds: 0 }),
    ConnectionJobNotFoundError,
  );
  assert.equal(
    (await supervisor.query(directOwner, ids.at(-1)!, { waitSeconds: 0 })).state,
    'succeeded',
  );
});

test('MaatApi production readiness surface starts, queries, cancels, and blocks conflicting operations', async () => {
  const supervisor = new ConnectionJobSupervisor();
  let readinessCalls = 0;
  let mobileConfigurations = 0;
  let webConfigurations = 0;
  let macConfigurations = 0;
  const adapter: PlatformAdapter & { isMigratedLocalPhysicalRoute(): boolean } = {
    id: 'android',
    label: 'Android',
    codeContext: { language: 'javascript', globals: [], guidelines: [] },
    isMigratedLocalPhysicalRoute: () => true,
    async initialize() {},
    async configure() {
      mobileConfigurations += 1;
      return {};
    },
    async configureSession() {},
    async selectReadinessTarget() {
      return {
        status: 'selected',
        platform: 'android',
        selectedBy: 'single-candidate',
        candidate: {
          candidateNumber: 1,
          displayName: 'Sanitized Phone',
          platform: 'android',
          kind: 'device',
          discriminator: 'A',
        },
      };
    },
    async execute() {
      return [];
    },
    async executeReadiness(_code, signal) {
      readinessCalls += 1;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return [];
    },
    status() {
      return { id: 'android', label: 'Android', session: 'idle' };
    },
    async close() {},
  };
  const web: PlatformAdapter = {
    id: 'web',
    label: 'Web',
    codeContext: { language: 'javascript', globals: [], guidelines: [] },
    async initialize() {},
    async configure() {
      webConfigurations += 1;
      return {};
    },
    async execute() {
      return [];
    },
    status() {
      return { id: 'web', label: 'Web', session: 'idle' };
    },
    async close() {},
  };
  const macos: PlatformAdapter = {
    id: 'macos',
    label: 'macOS',
    codeContext: { language: 'javascript', globals: [], guidelines: [] },
    async initialize() {},
    async configure() {
      macConfigurations += 1;
      return {};
    },
    async execute() {
      return [];
    },
    status() {
      return { id: 'macos', label: 'macOS', session: 'idle' };
    },
    async close() {},
  };
  const api = new MaatApi(
    new PlatformRegistry([adapter, web], 'android'),
    process.cwd(),
    {
      androidDetector: async () =>
        aggregateSetup({
          platform: 'android',
          capabilities: [
            {
              id: 'uiInteraction',
              status: 'ready',
              required: true,
              messageKey: 'capability.interaction.ready',
            },
          ],
        }),
    },
    supervisor,
  );

  const started = await api.setup.ready({ waitSeconds: 0 });
  assert.ok('jobId' in started);
  assert.equal(started.state, 'running');
  assert.equal(readinessCalls, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readinessCalls, 1);

  await assert.rejects(api.exploration.executeJavaScript('return 1'), MobileBusyError);
  await assert.rejects(api.platforms.select('web'), MobileBusyError);
  assert.equal(api.platforms.current(), adapter);
  await assert.rejects(api.platforms.configure({}), MobileBusyError);
  assert.equal(mobileConfigurations, 0);
  await assert.rejects(api.platforms.configureSession({}), MobileBusyError);
  await assert.rejects(api.mobile.releaseCurrentSession(), MobileBusyError);
  await assert.rejects(api.close(), MobileBusyError);

  const legacy = new MaatApi(
    new PlatformRegistry([web], 'web'),
    '/other-workspace',
    undefined,
    supervisor,
  );
  await legacy.platforms.configure({});
  assert.equal(webConfigurations, 1);
  const legacyMac = new MaatApi(
    new PlatformRegistry([macos], 'macos'),
    '/mac-workspace',
    undefined,
    supervisor,
  );
  await legacyMac.platforms.configure({});
  assert.equal(macConfigurations, 1);
  await assert.rejects(
    api.setup.ready({
      jobId: started.jobId,
      screenshot: true,
    } as never),
    /invalid for this operation/,
  );
  await assert.rejects(
    api.setup.ready({ jobAction: 'cancel' } as never),
    /invalid for this operation/,
  );

  const cancelled = await api.setup.ready({
    jobId: started.jobId,
    jobAction: 'cancel',
    waitSeconds: 1,
  });
  assert.ok('jobId' in cancelled);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(readinessCalls, 1);
  await api.close();
  await legacy.close();
  await legacyMac.close();
});

test('default process supervisor coordinates MaatApi instances across workspaces without adoption', async () => {
  const gate = deferred<typeof success>();
  let callbacks = 0;
  let configurations = 0;
  const makeAdapter = (): PlatformAdapter & { isMigratedLocalPhysicalRoute(): boolean } => ({
    id: 'android',
    label: 'Android',
    codeContext: { language: 'javascript', globals: [], guidelines: [] },
    isMigratedLocalPhysicalRoute: () => true,
    async initialize() {},
    async configure() {
      configurations += 1;
      return {};
    },
    async selectReadinessTarget() {
      return {
        status: 'selected',
        platform: 'android',
        selectedBy: 'single-candidate',
        candidate: {
          candidateNumber: 1,
          displayName: 'Sanitized Phone',
          platform: 'android',
          kind: 'device',
          discriminator: 'A',
        },
      };
    },
    async execute() {
      return [];
    },
    async executeReadiness() {
      callbacks += 1;
      await gate.promise;
      return [
        {
          type: 'text',
          text: JSON.stringify({
            maatSetupReadiness: 1,
            phoneUnlocked: true,
            sessionUsable: true,
            sourceReadable: true,
            viewportReadable: true,
            source: '<safe />',
            viewport: { width: 1, height: 1 },
          }),
        },
      ];
    },
    status() {
      return { id: 'android', label: 'Android', session: 'idle' };
    },
    async close() {},
  });
  const setup = {
    androidDetector: async () =>
      aggregateSetup({
        platform: 'android',
        capabilities: [
          {
            id: 'uiInteraction' as const,
            status: 'ready' as const,
            required: true,
            messageKey: 'capability.interaction.ready' as const,
          },
        ],
      }),
  };
  const web: PlatformAdapter = {
    id: 'web',
    label: 'Web',
    codeContext: { language: 'javascript', globals: [], guidelines: [] },
    async initialize() {},
    async configure() {
      return {};
    },
    async execute() {
      return [];
    },
    status() {
      return { id: 'web', label: 'Web', session: 'idle' };
    },
    async close() {},
  };
  const first = new MaatApi(
    new PlatformRegistry([makeAdapter()], 'android'),
    '/workspace-one',
    setup,
  );
  const second = new MaatApi(
    new PlatformRegistry([makeAdapter(), web], 'android'),
    '/workspace-two',
    setup,
  );

  const started = await first.setup.ready({ waitSeconds: 0.01 });
  assert.ok('jobId' in started);
  assert.equal(started.state, 'running');
  assert.equal(callbacks, 1);
  await assert.rejects(
    second.setup.ready({ waitSeconds: 0 }),
    (error: unknown) =>
      error instanceof MobileBusyError && !('jobId' in (error as unknown as object)),
  );
  await assert.rejects(second.platforms.configure({}), MobileBusyError);
  assert.equal(configurations, 0);
  const selectedBefore = second.platforms.current();
  await assert.rejects(second.platforms.select('web'), MobileBusyError);
  assert.equal(second.platforms.current(), selectedBefore);
  assert.equal(callbacks, 1);
  for (const jobAction of ['query', 'cancel'] as const) {
    await assert.rejects(
      second.setup.ready({
        jobId: started.jobId,
        jobAction,
        waitSeconds: 0,
      }),
      (error: unknown) =>
        error instanceof ConnectionJobNotFoundError &&
        error.code === 'connection-job-not-found' &&
        error.message === 'Connection job was not found.',
    );
  }
  const ownedRunning = await first.setup.ready({
    jobId: started.jobId,
    waitSeconds: 0,
  });
  assert.ok('jobId' in ownedRunning);
  assert.equal(ownedRunning.state, 'running');
  gate.resolve(success);
  const terminal = await first.setup.ready({
    jobId: started.jobId,
    waitSeconds: 1,
  });
  assert.ok('jobId' in terminal);
  assert.equal(terminal.state, 'succeeded');
  assert.equal(callbacks, 1);
  await first.close();
  await second.close();
});

test('production uncertainty keeps the lower process creation barrier fail-closed', async () => {
  const supervisor = new ConnectionJobSupervisor();
  const started = await supervisor.start(
    directOwner,
    async (_signal, owner) =>
      runMobileOperation(
        async () => {
          throw new PhoneSessionCreationUncertainError();
        },
        true,
        owner,
      ),
    { waitSeconds: 1 },
  );
  assert.equal(started.state, 'creation-uncertain');
  assert.throws(() => assertMobileCreationAllowed(true), PhoneSessionCreationUncertainError);
});
