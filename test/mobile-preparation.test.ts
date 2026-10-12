import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import type { MaatApi } from '../packages/core/src/api/maat-api.ts';
import {
  closeMobileRuntime,
  MobilePreparation,
  stopOwnedAppiumChild,
} from '../packages/pi/src/mobile-preparation.ts';
import { createMobilePreparationTool } from '../packages/pi/src/tools/mobile-preparation-tool.ts';

function fixture(platform = 'android', serverUrl = 'http://127.0.0.1:4723') {
  const hints = {
    serverUrl,
    device: { kind: 'device' as const, name: 'private-device' },
    capabilities: {} as Record<string, unknown>,
  };
  const adapter = {
    id: platform,
    initialize: async () => {},
    sessionHints: hints,
    status: () => ({ session: 'idle' as 'idle' | 'ready' }),
  };
  let current = adapter;
  const applied: Record<string, unknown>[] = [];
  const maat = {
    platforms: {
      current: () => current,
      configureSession: async ({ capabilities }: { capabilities: Record<string, unknown> }) => {
        applied.push(capabilities);
        hints.capabilities = { ...hints.capabilities, ...capabilities };
      },
    },
    close: async () => {},
  } as unknown as MaatApi;
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  }) as unknown as ChildProcess;
  let spawns = 0;
  let stops = 0;
  let healthy = false;
  let occupied = false;
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const dependencies = {
    resolveAppium: async () => ({ file: process.execPath, args: ['private-appium-entry.js'] }),
    resolveAndroid: async () => ({
      source: 'managed' as const,
      environment: { ANDROID_HOME: 'private-sdk', PATH: 'resolved-tools' },
    }),
    responding: async () => healthy,
    occupied: async () => occupied,
    spawn: (file: string, args: string[], env: NodeJS.ProcessEnv) => {
      spawns++;
      calls.push({ file, args, env });
      const host = args[args.indexOf('--address') + 1];
      const port = args[args.indexOf('--port') + 1];
      queueMicrotask(() =>
        child.stdout!.emit(
          'data',
          Buffer.from(`Appium REST http interface listener started on http://${host}:${port}\n`),
        ),
      );
      return child;
    },
    stop: async (exact: ChildProcess) => {
      assert.equal(exact, child);
      stops++;
    },
    pollMs: 2,
    appiumDeadlineMs: 200,
    wdaDeadlineMs: 200,
    cleanupGraceMs: 40,
  };
  return {
    maat,
    adapter,
    hints,
    applied,
    child,
    dependencies,
    calls,
    counts: () => ({ spawns, stops }),
    healthy: (value: boolean) => {
      healthy = value;
    },
    occupied: (value: boolean) => {
      occupied = value;
    },
    switch: () => {
      current = { ...adapter, id: 'android' };
    },
  };
}

test('status is read-only; healthy user Appium is never owned or stopped', async () => {
  const f = fixture();
  f.healthy(true);
  const preparation = new MobilePreparation(f.maat, f.dependencies);
  const read = await preparation.execute({ action: 'status' });
  assert.equal(read.state, 'ready');
  assert.equal(read.owned, false);
  assert.equal(read.serviceResponding, true);
  assert.deepEqual(f.counts(), { spawns: 0, stops: 0 });
  const start = await preparation.execute({ action: 'start-appium', waitSeconds: 1 });
  assert.equal(start.state, 'ready');
  assert.equal(start.owned, false);
  assert.match(start.summary, /not deviceReady/);
  await preparation.close();
  await preparation.close();
  assert.deepEqual(f.counts(), { spawns: 0, stops: 0 });
});

test('wait expiry tracks one exact endpoint child and passes resolved Android environment', async () => {
  const f = fixture('android', 'http://localhost:4799/wd/hub/');
  const preparation = new MobilePreparation(f.maat, f.dependencies);
  const first = await preparation.execute({ action: 'start-appium', waitSeconds: 0.01 });
  assert.equal(first.state, 'running');
  const second = await preparation.execute({ action: 'start-appium' });
  assert.equal(second.taskId, first.taskId);
  assert.equal(f.counts().spawns, 1);
  assert.deepEqual(f.calls[0]!.args, [
    'private-appium-entry.js',
    '--address',
    '127.0.0.1',
    '--port',
    '4799',
    '--base-path',
    '/wd/hub',
  ]);
  assert.equal(f.calls[0]!.env.ANDROID_HOME, 'private-sdk');
  assert.equal(f.calls[0]!.env.PATH, 'resolved-tools');
  f.healthy(true);
  const ready = await preparation.execute({
    action: 'status',
    taskId: first.taskId,
    waitSeconds: 1,
  });
  assert.equal(ready.state, 'ready');
  assert.match(ready.summary, /not deviceReady/);
  assert.doesNotMatch(JSON.stringify(ready), /private-|pid|resolved-tools/);
  await preparation.close();
  assert.equal(f.counts().stops, 1);
});

test('concurrent starts share one task, but a different endpoint is never silently substituted', async () => {
  const f = fixture();
  const preparation = new MobilePreparation(f.maat, f.dependencies);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => preparation.execute({ action: 'start-appium' })),
  );
  assert.equal(new Set(results.map((r) => r.taskId)).size, 1);
  await delay(10);
  assert.equal(f.counts().spawns, 1);
  f.hints.serverUrl = 'http://127.0.0.1:4798';
  f.occupied(true);
  const other = await preparation.execute({ action: 'start-appium', waitSeconds: 1 });
  assert.notEqual(other.taskId, results[0]!.taskId);
  assert.equal(other.category, 'ENDPOINT_OCCUPIED');
  assert.equal(f.counts().spawns, 1);
  await preparation.close();
});

test('spawn/process error stays failed even when a service later responds; raw logs stay private', async () => {
  const f = fixture();
  const preparation = new MobilePreparation(f.maat, f.dependencies);
  const start = await preparation.execute({ action: 'start-appium', waitSeconds: 0.01 });
  f.child.stderr!.emit(
    'data',
    Buffer.from('secret=token /Users/private Team=private-device'.repeat(10_000)),
  );
  f.child.emit('error', new Error('sensitive raw spawn error'));
  f.healthy(true);
  const result = await preparation.execute({
    action: 'status',
    taskId: start.taskId,
    waitSeconds: 1,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.category, 'APPIUM_PROCESS_ERROR');
  assert.doesNotMatch(JSON.stringify(result), /secret|token|Users|Team|raw spawn/);
  const again = await preparation.execute({ action: 'start-appium' });
  assert.equal(again.taskId, start.taskId);
  assert.equal(again.state, 'failed');
  await preparation.close();
  assert.equal(f.counts().stops, 1);
});

test('early child exit is not hidden by HTTPready', async () => {
  const f = fixture();
  const preparation = new MobilePreparation(f.maat, f.dependencies);
  const start = await preparation.execute({ action: 'start-appium', waitSeconds: 0.01 });
  f.child.emit('exit', 1);
  f.healthy(true);
  const result = await preparation.execute({
    action: 'status',
    taskId: start.taskId,
    waitSeconds: 1,
  });
  assert.equal(result.category, 'APPIUM_PROCESS_EXITED');
  assert.equal(result.state, 'failed');
  await preparation.close();
});

test('a spawned child requires its listener confirmation as well as HTTP before ready', async () => {
  const f = fixture();
  const preparation = new MobilePreparation(f.maat, {
    ...f.dependencies,
    spawn: () => {
      f.healthy(true);
      return f.child;
    },
    appiumDeadlineMs: 25,
  });
  const result = await preparation.execute({ action: 'start-appium', waitSeconds: 1 });
  assert.equal(result.state, 'failed');
  assert.equal(result.category, 'PREPARATION_TIMEOUT');
  assert.equal(f.counts().stops, 1);
  await preparation.close();
});

test('overall startup deadline stops owned work and preserves primary timeout if cleanup fails', async () => {
  const f = fixture();
  const preparation = new MobilePreparation(f.maat, {
    ...f.dependencies,
    appiumDeadlineMs: 25,
    stop: async () => {
      throw new Error('raw sensitive cleanup error');
    },
  });
  const result = await preparation.execute({ action: 'start-appium', waitSeconds: 1 });
  assert.equal(result.state, 'failed');
  assert.equal(result.category, 'PREPARATION_TIMEOUT');
  assert.match(result.cleanupError!, /cleanup failed/);
  assert.doesNotMatch(JSON.stringify(result), /raw sensitive/);
  await assert.rejects(preparation.close(), /could not stop/);
});

test('deadline also bounds an uncooperative resolver; cleanup is explicitly unconfirmed and no late child starts', async () => {
  const f = fixture();
  let release!: () => void;
  const preparation = new MobilePreparation(f.maat, {
    ...f.dependencies,
    appiumDeadlineMs: 20,
    resolveAppium: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { file: 'appium', args: [] };
    },
  });
  const result = await preparation.execute({ action: 'start-appium', waitSeconds: 1 });
  assert.equal(result.category, 'PREPARATION_TIMEOUT');
  await assert.rejects(preparation.close(), /could not stop/);
  release();
  await delay(10);
  assert.equal(f.counts().spawns, 0);
});

test('cancelling a bounded wait does not restart/cancel possibly executing work; shutdown does', async () => {
  const f = fixture();
  const preparation = new MobilePreparation(f.maat, f.dependencies);
  const start = await preparation.execute({ action: 'start-appium' });
  const controller = new AbortController();
  const wait = preparation.execute(
    { action: 'status', taskId: start.taskId, waitSeconds: 1 },
    controller.signal,
  );
  controller.abort(new Error('wait cancelled'));
  await assert.rejects(wait, /wait cancelled/);
  const status = await preparation.execute({ action: 'status', taskId: start.taskId });
  assert.equal(status.state, 'running');
  await preparation.close();
  assert.equal(f.counts().stops, 1);
});

test('strict input and remote endpoints fail without spawning', async () => {
  for (const endpoint of [
    'http://remote.example:4723',
    'http://user:password@localhost:4723',
    'http://127.0.0.1:4723/?token=private',
    'file:///tmp/private',
  ]) {
    const f = fixture('android', endpoint);
    const preparation = new MobilePreparation(f.maat, f.dependencies);
    await assert.rejects(preparation.execute({ action: 'start-appium' }), /loopback/);
    assert.equal(f.counts().spawns, 0);
    await preparation.close();
  }
  const f = fixture();
  const preparation = new MobilePreparation(f.maat, f.dependencies);
  for (const waitSeconds of [-1, 21, NaN])
    await assert.rejects(preparation.execute({ action: 'status', waitSeconds }), /waitSeconds/);
  await assert.rejects(
    preparation.execute({ action: 'start-appium', taskId: 'old' }),
    /Use status/,
  );
  await assert.rejects(preparation.execute({ action: 'status', taskId: 'unknown' }), /Unknown/);
  await preparation.close();
});

const validWda = {
  state: 'ready' as const,
  summary: 'sensitive Core path /Users/private TeamID=secret',
  signingConfigured: true,
  profile: {
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: '2027-01-01T00:00:00Z',
    expired: false,
    includesSelectedDevice: true,
  },
  certificate: { expiresAt: '2027-01-02T00:00:00Z', expired: false },
  capabilities: { 'appium:usePrebuiltWDA': true, 'appium:derivedDataPath': '/Users/private/wda' },
};

test('valid paid or free WDA is reused without authorization/build; only safe facts reach content', async () => {
  const f = fixture('ios');
  let builds = 0;
  const preparation = new MobilePreparation(f.maat, {
    ...f.dependencies,
    inspectWda: async (input) => {
      assert.deepEqual(input.device, f.hints.device);
      return validWda;
    },
    prepareWda: async () => {
      builds++;
      return validWda;
    },
  });
  const tool = createMobilePreparationTool(preparation);
  const result = await tool.execute(
    'wda',
    { action: 'build-ios-wda', waitSeconds: 1 },
    undefined,
    undefined,
    {} as never,
  );
  const content = JSON.stringify(result.content);
  assert.match(content, /completed/);
  assert.match(content, /2027-01-01/);
  assert.doesNotMatch(content, /TeamID|secret|Users|derivedDataPath|private-device|usePrebuiltWDA/);
  assert.equal(builds, 0);
  assert.deepEqual(f.applied, [validWda.capabilities]);
  await preparation.close();
});

test('iOS status inspects signing read-only without apply or prepare', async () => {
  const f = fixture('ios');
  const preparation = new MobilePreparation(f.maat, {
    ...f.dependencies,
    inspectWda: async () => validWda,
    prepareWda: async () => {
      throw new Error('must not build');
    },
  });
  const result = await preparation.execute({ action: 'status' });
  assert.equal(result.wda?.profile?.expired, false);
  assert.equal(f.applied.length, 0);
  assert.equal(f.counts().spawns, 0);
  await preparation.close();
});

test('preparation tool throws a safe failed task envelope, never a resolved success-shaped result', async () => {
  const f = fixture();
  f.occupied(true);
  const preparation = new MobilePreparation(f.maat, f.dependencies);
  const tool = createMobilePreparationTool(preparation);
  await assert.rejects(
    tool.execute(
      'start',
      { action: 'start-appium', waitSeconds: 1 },
      undefined,
      undefined,
      {} as never,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const result = JSON.parse(error.message);
      assert.equal(result.state, 'failed');
      assert.equal(result.category, 'ENDPOINT_OCCUPIED');
      assert.equal(typeof result.taskId, 'string');
      assert.equal(typeof result.error, 'string');
      assert.doesNotMatch(error.message, /private-device|pid/);
      return true;
    },
  );
  await preparation.close();
});

test('expired WDA requires explicit signing authorization and authorized single-flight does not replay', async () => {
  const f = fixture('ios');
  let builds = 0;
  const preparation = new MobilePreparation(f.maat, {
    ...f.dependencies,
    inspectWda: async () => ({ ...validWda, state: 'expired', capabilities: undefined }),
    prepareWda: async (input) => {
      assert.equal(input.signingAuthorized, true);
      builds++;
      throw new Error('sensitive raw xcode error');
    },
  });
  const unauthorized = await preparation.execute({ action: 'build-ios-wda', waitSeconds: 1 });
  assert.equal(unauthorized.category, 'SIGNING_AUTHORIZATION_REQUIRED');
  assert.equal(builds, 0);
  const authorized = await preparation.execute({
    action: 'build-ios-wda',
    signingAuthorized: true,
    waitSeconds: 1,
  });
  assert.equal(authorized.state, 'failed');
  assert.equal(builds, 1);
  const repeated = await preparation.execute({ action: 'build-ios-wda', signingAuthorized: true });
  assert.equal(repeated.taskId, authorized.taskId);
  assert.equal(builds, 1);
  assert.doesNotMatch(JSON.stringify(authorized), /raw xcode/);
  await preparation.close();
});

test('authorized renewal applies reusable build caps, not deployment or phone readiness', async () => {
  const f = fixture('ios');
  const preparation = new MobilePreparation(f.maat, {
    ...f.dependencies,
    inspectWda: async () => ({ ...validWda, state: 'missing' }),
    prepareWda: async () => validWda,
  });

  const result = await preparation.execute({
    action: 'build-ios-wda',
    signingAuthorized: true,
    waitSeconds: 1,
  });
  assert.equal(result.state, 'completed');
  assert.match(result.summary, /No phone readiness/);
  assert.deepEqual(f.applied, [validWda.capabilities]);
  await preparation.close();
});

test('WDA result never closes an active phone Session to change hints', async () => {
  const f = fixture('ios');
  f.adapter.status = () => ({ session: 'ready' });
  const preparation = new MobilePreparation(f.maat, {
    ...f.dependencies,
    inspectWda: async () => validWda,
  });
  const result = await preparation.execute({ action: 'build-ios-wda', waitSeconds: 1 });
  assert.equal(result.category, 'SESSION_IN_USE');
  assert.equal(f.applied.length, 0);
  f.adapter.status = () => ({ session: 'idle' });
  const reused = await preparation.execute({ action: 'build-ios-wda', waitSeconds: 1 });
  assert.equal(reused.state, 'completed');
  assert.equal(f.applied.length, 1);
  await preparation.close();
});

test('a platform/device change during WDA work cannot apply caps to a different adapter', async () => {
  for (const change of ['platform', 'device']) {
    const f = fixture('ios');
    const preparation = new MobilePreparation(f.maat, {
      ...f.dependencies,
      inspectWda: async () => ({ ...validWda, state: 'missing' }),
      prepareWda: async () => {
        if (change === 'platform') f.switch();
        else f.hints.device.name = 'different-private-device';
        return validWda;
      },
    });
    const result = await preparation.execute({
      action: 'build-ios-wda',
      signingAuthorized: true,
      waitSeconds: 1,
    });
    assert.equal(result.category, 'CONFIGURATION_CHANGED');
    assert.equal(f.applied.length, 0);
    await preparation.close();
  }
});

test('helper failure/needs-signing never claims WDA ready and shutdown bounds uncooperative work', async () => {
  const f = fixture('ios');
  const preparation = new MobilePreparation(f.maat, {
    ...f.dependencies,
    wdaDeadlineMs: 20,
    inspectWda: async () => new Promise(() => {}),
  });
  const result = await preparation.execute({ action: 'build-ios-wda', waitSeconds: 1 });
  assert.equal(result.category, 'PREPARATION_TIMEOUT');
  assert.equal(f.applied.length, 0);
  assert.match(result.cleanupError!, /did not settle/);
  await assert.rejects(preparation.close(), /could not stop/);
});

test('cleanup attempts preparation after Session failure and preserves both failures', async () => {
  const sequence: string[] = [];
  const maat = {
    close: async () => {
      sequence.push('session');
      throw new Error('primary');
    },
  } as unknown as MaatApi;
  const preparation = {
    close: async () => {
      sequence.push('owned-process');
      throw new Error('cleanup');
    },
  } as unknown as MobilePreparation;
  await assert.rejects(closeMobileRuntime(maat, preparation), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].message, 'primary');
    assert.equal(error.errors[1].message, 'cleanup');
    return true;
  });
  await assert.rejects(closeMobileRuntime(maat, preparation), /cleanup failed/);
  assert.deepEqual(sequence, ['session', 'owned-process']);
});

test('shutdown during hint initialization prevents a late new startup task', async () => {
  const f = fixture();
  let release!: () => void;
  f.adapter.initialize = async () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const preparation = new MobilePreparation(f.maat, f.dependencies);
  const starting = preparation.execute({ action: 'start-appium' });
  await preparation.close();
  release();
  await assert.rejects(starting, /closed/);
  assert.equal(f.counts().spawns, 0);
});

test('timed-out WDA inspection cannot later trigger an authorized build/apply', async () => {
  const f = fixture('ios');
  let release!: (value: typeof validWda) => void;
  let builds = 0;
  const preparation = new MobilePreparation(f.maat, {
    ...f.dependencies,
    wdaDeadlineMs: 20,
    inspectWda: async () =>
      new Promise<typeof validWda>((resolve) => {
        release = resolve;
      }),
    prepareWda: async () => {
      builds++;
      return validWda;
    },
  });
  const result = await preparation.execute({
    action: 'build-ios-wda',
    signingAuthorized: true,
    waitSeconds: 1,
  });
  assert.equal(result.state, 'failed');
  release(validWda);
  await delay(10);
  const status = await preparation.execute({ action: 'status', taskId: result.taskId });
  assert.equal(status.state, 'failed');
  assert.equal(builds, 0);
  assert.equal(f.applied.length, 0);
  assert.match(status.cleanupError!, /did not settle/);
  await assert.rejects(preparation.close(), /could not stop/);
});

test('Core signing failure keeps a useful safe category, never raw categorized exception text', async () => {
  const f = fixture('ios');
  const preparation = new MobilePreparation(f.maat, {
    ...f.dependencies,
    inspectWda: async () => {
      throw Object.assign(new Error('IOS_WDA_SIGNING_REQUIRED: /Users/private Team=secret'), {
        category: 'PRIVATE',
      });
    },
  });
  const result = await preparation.execute({ action: 'build-ios-wda', waitSeconds: 1 });
  assert.equal(result.category, 'IOS_WDA_SIGNING_REQUIRED');
  assert.match(result.error!, /Team yourself/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|Users|secret/);
  await preparation.close();
});

test('real foreground child + controlled HTTP becomes ready and owned cleanup exits that exact child', async (t) => {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const f = fixture('android', `http://127.0.0.1:${port}/wd/hub`);
  let exactChild: ChildProcess | undefined;
  let descendantPid: number | undefined;
  const preparation = new MobilePreparation(f.maat, {
    resolveAppium: async () => ({ file: process.execPath, args: [] }),
    resolveAndroid: f.dependencies.resolveAndroid,
    spawn: (_file, args, env) => {
      assert.deepEqual(args, [
        '--address',
        '127.0.0.1',
        '--port',
        String(port),
        '--base-path',
        '/wd/hub',
      ]);
      exactChild = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import http from 'node:http'; import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',shell:false,detached:false}); console.log('test-owned-descendant:'+child.pid); http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({value:{ready:q.url==='/wd/hub/status',message:'The server is ready to accept new connections',build:{version:'3.1.0'}}}));}).listen(${port},'127.0.0.1',()=>console.log('Appium REST http interface listener started on http://127.0.0.1:${port}'));`,
        ],
        {
          env,
          shell: false,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      exactChild.stdout!.on('data', (chunk: Buffer) => {
        const match = /test-owned-descendant:(\d+)/.exec(chunk.toString());
        if (match) descendantPid = Number(match[1]);
      });
      return exactChild;
    },
    appiumDeadlineMs: 2_000,
    pollMs: 10,
  });
  t.after(() => preparation.close());
  const result = await preparation.execute({ action: 'start-appium', waitSeconds: 2 });
  assert.equal(result.state, 'ready');
  assert.equal(result.owned, true);
  assert.equal(result.serviceResponding, true);
  await preparation.close();
  assert.ok(exactChild);
  assert.ok(exactChild.exitCode !== null || exactChild.signalCode !== null);
  assert.ok(descendantPid);
  assert.throws(() => process.kill(descendantPid!, 0), /ESRCH/);
});

test(
  'owned local child drains large stderr before readiness and still cleans up',
  { timeout: 10_000 },
  async (t) => {
    const f = fixture();
    let child: ChildProcess | undefined;
    const preparation = new MobilePreparation(f.maat, {
      ...f.dependencies,
      spawn: () => {
        child = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import {once} from 'node:events';
const chunk = 'private-stderr-token\\n'.repeat(4096);
for (let i = 0; i < 128; i++) {
  if (!process.stderr.write(chunk)) await once(process.stderr, 'drain');
}
console.log('Appium REST http interface listener started on http://127.0.0.1:4723');
setInterval(() => {}, 1000);`,
          ],
          {
            shell: false,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        return child;
      },
      // No actual Appium or listening service: stdout ownership gates this fixture.
      responding: async () => child !== undefined,
      stop: stopOwnedAppiumChild,
      appiumDeadlineMs: 5_000,
      pollMs: 10,
    });
    t.after(() => preparation.close());
    const result = await preparation.execute({ action: 'start-appium', waitSeconds: 6 });
    assert.equal(result.state, 'ready');
    assert.equal(result.owned, true);
    assert.equal(result.serviceResponding, true);
    assert.doesNotMatch(JSON.stringify(result), /private-stderr-token/);
    const status = await preparation.execute({ action: 'status', taskId: result.taskId });
    assert.equal(status.state, 'ready');
    assert.doesNotMatch(JSON.stringify(status), /private-stderr-token/);
    await preparation.close();
    await preparation.close();
    assert.ok(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  },
);

test('read/reuse requires Appium status features, not generic WebDriver ready', async (t) => {
  const cases = [
    { value: { ready: true } },
    { value: { ready: true, build: { version: '4.1.0' }, message: 'Selenium Grid ready.' } },
    { value: { ready: true, build: { version: '3.1.0' }, message: 'Other WebDriver ready.' } },
    {
      value: {
        ready: true,
        build: { version: 'invalid' },
        message: 'The server is ready to accept new connections',
      },
    },
    {
      value: {
        ready: false,
        build: { version: '3.1.0' },
        message: 'The server is ready to accept new connections',
      },
    },
    {
      value: {
        ready: true,
        build: { version: '3.1.0' },
        message: 'The server is ready to accept new connections',
      },
    },
  ];
  for (const [index, body] of cases.entries()) {
    await t.test(`status shape ${index}`, async () => {
      const server = createHttpServer((_request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(body));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const f = fixture('android', `http://127.0.0.1:${address.port}/wd/hub`);
      const { responding: _responding, occupied: _occupied, ...dependencies } = f.dependencies;
      const preparation = new MobilePreparation(f.maat, dependencies);
      try {
        const read = await preparation.execute({ action: 'status' });
        const isAppium = index === cases.length - 1;
        assert.equal(read.serviceResponding, isAppium);
        assert.equal(read.state, isAppium ? 'ready' : 'completed');
        const start = await preparation.execute({ action: 'start-appium', waitSeconds: 1 });
        assert.equal(start.state, isAppium ? 'ready' : 'failed');
        assert.equal(start.owned, isAppium ? false : undefined);
        if (!isAppium) assert.equal(start.category, 'ENDPOINT_OCCUPIED');
        assert.equal(f.counts().spawns, 0);
        await preparation.close();
        assert.equal(f.counts().stops, 0);
        // The service occupying the port remains intact, including wrong shapes.
        assert.equal((await fetch(`http://127.0.0.1:${address.port}/status`)).status, 200);
      } finally {
        await preparation.close();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
    });
  }
});

test('owned listener must match selected host/port even when HTTP later becomes healthy', async () => {
  for (const line of [
    'Appium REST http interface listener started',
    'Appium REST http interface listener started on http://127.0.0.1:47230',
    'Appium REST http interface listener started on http://0.0.0.0:4723',
    'Appium REST http interface listener started on http://127.0.0.1.other:4723',
  ]) {
    const f = fixture();
    const preparation = new MobilePreparation(f.maat, {
      ...f.dependencies,
      appiumDeadlineMs: 20,
      spawn: () => {
        f.healthy(true);
        queueMicrotask(() => f.child.stdout!.emit('data', Buffer.from(line)));
        return f.child;
      },
    });
    const result = await preparation.execute({ action: 'start-appium', waitSeconds: 1 });
    assert.equal(result.category, 'PREPARATION_TIMEOUT');
    assert.equal(result.state, 'failed');
    assert.equal(f.counts().stops, 1);
    await preparation.close();
  }
});

test('exact owned listener accepts split/colorized IPv6 address without endpoint substitution', async () => {
  const f = fixture('android', 'http://[::1]:4799');
  const preparation = new MobilePreparation(f.maat, {
    ...f.dependencies,
    spawn: () => {
      f.healthy(true);
      queueMicrotask(() => {
        f.child.stdout!.emit('data', Buffer.from('\u001b[32mAppium REST http interface listener'));
        f.child.stdout!.emit('data', Buffer.from(' started on http://[::1]:4799\u001b[0m\n'));
      });
      return f.child;
    },
  });
  const result = await preparation.execute({ action: 'start-appium', waitSeconds: 1 });
  assert.equal(result.state, 'ready');
  assert.equal(result.owned, true);
  await preparation.close();
});

test('a partial listener port token cannot confirm the selected endpoint', async () => {
  const f = fixture();
  const preparation = new MobilePreparation(f.maat, {
    ...f.dependencies,
    appiumDeadlineMs: 25,
    spawn: () => {
      f.healthy(true);
      queueMicrotask(() => {
        f.child.stdout!.emit(
          'data',
          Buffer.from('Appium REST http interface listener started on http://127.0.0.1:4723'),
        );
        setTimeout(() => f.child.stdout!.emit('data', Buffer.from('0\n')), 5);
      });
      return f.child;
    },
  });
  const result = await preparation.execute({ action: 'start-appium', waitSeconds: 1 });
  assert.equal(result.category, 'PREPARATION_TIMEOUT');
  await preparation.close();
});

test(
  'POSIX owned group kills reparented TERM-ignoring grandchild after root exit, not a neighbor',
  {
    skip: process.platform === 'win32',
  },
  async (t) => {
    const neighbor = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      detached: false,
      shell: false,
    });
    t.after(() => neighbor.kill('SIGKILL'));
    const f = fixture();
    let root: ChildProcess | undefined;
    let descendantPid: number | undefined;
    let survivedTerm = false;
    // IPC proves the grandchild installed its TERM handler before root exits;
    // all of its stdio is ignored and it does not become a separate group.
    const grandchild =
      "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); process.send('ready');";
    const middle = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','ignore','ignore','ipc'],detached:false,shell:false}); c.once('message',()=>{c.disconnect();console.log('owned-grandchild:'+c.pid);process.exit(0);});`;
    const program = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:['ignore','pipe','ignore'],detached:false,shell:false});c.stdout.on('data',d=>process.stdout.write(d));c.on('exit',()=>process.exit(0));`;
    const preparation = new MobilePreparation(f.maat, {
      ...f.dependencies,
      appiumDeadlineMs: 2_000,
      spawn: () => {
        root = spawn(process.execPath, ['-e', program], {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          shell: false,
        });
        root.stdout!.on('data', (chunk: Buffer) => {
          const match = /owned-grandchild:(\d+)/.exec(chunk.toString());
          if (match) descendantPid = Number(match[1]);
        });
        return root;
      },
      stop: async (child) => {
        assert.equal(child, root);
        assert.ok(child.exitCode !== null || child.signalCode !== null);
        assert.ok(descendantPid);
        process.kill(descendantPid!, 0);
        const stopping = stopOwnedAppiumChild(child);
        await delay(40);
        process.kill(descendantPid!, 0);
        survivedTerm = true;
        await stopping;
      },
    });
    t.after(async () => {
      await preparation.close();
      if (root?.pid) {
        try {
          process.kill(-root.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    });
    const result = await preparation.execute({ action: 'start-appium', waitSeconds: 2 });
    assert.equal(result.state, 'failed');
    assert.equal(result.category, 'APPIUM_PROCESS_EXITED');
    assert.equal(result.cleanupError, undefined);
    assert.equal(survivedTerm, true);
    assert.ok(descendantPid);
    // Allow the OS to reap the killed orphan; no names/ports are targeted.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        process.kill(descendantPid!, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
        throw error;
      }
      await delay(10);
    }
    assert.throws(() => process.kill(descendantPid!, 0), /ESRCH/);
    assert.ok(neighbor.pid);
    assert.doesNotThrow(() => process.kill(neighbor.pid!, 0));
    await preparation.close();
  },
);

test('Windows root already exited cannot claim tree cleanup or taskkill a reusable PID', async () => {
  const exited = { pid: 42, exitCode: 0, signalCode: null } as ChildProcess;
  let calls = 0;
  await assert.rejects(
    stopOwnedAppiumChild(exited, {
      platform: 'win32',
      kill: () => {
        calls++;
        return true;
      },
      taskkill: async () => {
        calls++;
      },
    }),
    /cannot be confirmed/,
  );
  assert.equal(calls, 0);
  const f = fixture();
  const preparation = new MobilePreparation(f.maat, {
    ...f.dependencies,
    stop: async () =>
      stopOwnedAppiumChild(exited, {
        platform: 'win32',
        kill: () => {
          calls++;
          return true;
        },
        taskkill: async () => {
          calls++;
        },
      }),
  });
  const start = await preparation.execute({ action: 'start-appium', waitSeconds: 0.01 });
  f.child.emit('exit', 1);
  await delay(5);
  const result = await preparation.execute({ action: 'status', taskId: start.taskId });
  assert.equal(result.category, 'APPIUM_PROCESS_EXITED');
  assert.match(result.cleanupError!, /could not be confirmed/);
  await assert.rejects(preparation.close(), /could not stop/);
  assert.equal(calls, 0);
});

function delayedBuildFixture(cleanupMs: number, cleanupFails = false) {
  const f = fixture('ios');
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cleaned = false;
  const dependencies = {
    ...f.dependencies,
    cleanupGraceMs: 100,
    wdaDeadlineMs: 500,
    inspectWda: async () => ({ ...validWda, state: 'missing' as const }),
    prepareWda: async ({ signal }: { signal?: AbortSignal }) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener(
          'abort',
          () => {
            setTimeout(() => {
              cleaned = true;
              const cancellation = new Error(
                'IOS_WDA_PREPARATION_CANCELLED: preparation cancelled.',
              );
              reject(
                cleanupFails
                  ? new AggregateError(
                      [cancellation, new Error('IOS_WDA_CLEANUP_FAILED: private path secret')],
                      'sensitive cleanup details',
                    )
                  : cancellation,
              );
            }, cleanupMs);
          },
          { once: true },
        );
      });
      return validWda;
    },
  };
  return { f, dependencies, ready, cleaned: () => cleaned };
}

test('shutdown waits for cooperative Core cleanup settlement with an independent grace', async () => {
  const d = delayedBuildFixture(35);
  const preparation = new MobilePreparation(d.f.maat, d.dependencies);
  const resultPromise = preparation.execute({
    action: 'build-ios-wda',
    signingAuthorized: true,
    waitSeconds: 1,
  });
  await d.ready;
  let closed = false;
  const closing = preparation.close().then(() => {
    closed = true;
  });
  await delay(5);
  assert.equal(closed, false);
  assert.equal(d.cleaned(), false);
  const result = await resultPromise;
  await closing;
  assert.equal(d.cleaned(), true);
  assert.equal(result.state, 'cancelled');
  assert.equal(result.category, 'CANCELLED');
  assert.equal(result.cleanupError, undefined);
  assert.equal(d.f.applied.length, 0);
});

test('cooperative cleanup failure is secondary and shutdown cannot hide it', async () => {
  const d = delayedBuildFixture(35, true);
  const preparation = new MobilePreparation(d.f.maat, d.dependencies);
  const resultPromise = preparation.execute({
    action: 'build-ios-wda',
    signingAuthorized: true,
    waitSeconds: 1,
  });
  await d.ready;
  const closing = assert.rejects(preparation.close(), /could not stop/);
  const result = await resultPromise;
  await closing;
  assert.equal(d.cleaned(), true);
  assert.equal(result.state, 'cancelled');
  assert.equal(result.category, 'CANCELLED');
  assert.match(result.cleanupError!, /additional cleanup failure/);
  assert.doesNotMatch(JSON.stringify(result), /private path|secret|sensitive/);
  assert.equal(d.f.applied.length, 0);
});

test('overall timeout remains primary while cooperative Core cleanup finishes', async () => {
  const d = delayedBuildFixture(35);
  const preparation = new MobilePreparation(d.f.maat, { ...d.dependencies, wdaDeadlineMs: 10 });
  const result = await preparation.execute({
    action: 'build-ios-wda',
    signingAuthorized: true,
    waitSeconds: 1,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.category, 'PREPARATION_TIMEOUT');
  assert.equal(d.cleaned(), true);
  assert.equal(result.cleanupError, undefined);
  assert.equal(d.f.applied.length, 0);
  await preparation.close();
});

test('cleanup grace timeout is bounded, records late failure, and never applies late build results', async () => {
  const d = delayedBuildFixture(60, true);
  const preparation = new MobilePreparation(d.f.maat, {
    ...d.dependencies,
    wdaDeadlineMs: 10,
    cleanupGraceMs: 10,
  });
  const result = await preparation.execute({
    action: 'build-ios-wda',
    signingAuthorized: true,
    waitSeconds: 1,
  });
  assert.equal(result.category, 'PREPARATION_TIMEOUT');
  assert.match(result.cleanupError!, /did not settle/);
  assert.equal(d.cleaned(), false);
  await delay(70);
  const later = await preparation.execute({ action: 'status', taskId: result.taskId });
  assert.equal(later.category, 'PREPARATION_TIMEOUT');
  assert.match(later.cleanupError!, /additional cleanup failure/);
  assert.doesNotMatch(JSON.stringify(later), /private path|secret|sensitive/);
  assert.equal(d.f.applied.length, 0);
  await assert.rejects(preparation.close(), /could not stop/);
});

function preparationAgent(
  tool: ReturnType<typeof createMobilePreparationTool>,
  reply: (
    results: Map<string, { isError: boolean; text: string }>,
    request: number,
  ) => AssistantMessage['content'],
) {
  const model: Model<'openai-completions'> = {
    id: 'preparation-transport-test',
    name: 'Preparation transport test',
    api: 'openai-completions',
    provider: 'test',
    baseUrl: 'http://127.0.0.1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 1_024,
  };
  let requests = 0;
  const agent = new Agent({
    initialState: {
      model,
      // Register the actual definition/execute reference, not an execute proxy.
      // This tool does not consume Pi's extra ExtensionContext argument.
      tools: [tool as unknown as AgentTool],
    },
    streamFn: (_model, context) => {
      const results = new Map<string, { isError: boolean; text: string }>();
      for (const message of context.messages) {
        if (message.role !== 'toolResult') continue;
        results.set(message.toolCallId, {
          isError: message.isError,
          text: message.content
            .filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join('\n'),
        });
      }
      const content = reply(results, ++requests);
      const stopReason = content.some((item) => item.type === 'toolCall') ? 'toolUse' : 'stop';
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content,
        stopReason,
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: stopReason, message });
      return stream;
    },
  });
  return { agent, requests: () => requests };
}

test('actual Agent loop accepts all-fields null status/start and polls only the returned taskId', async () => {
  const f = fixture();
  const preparation = new MobilePreparation(f.maat, f.dependencies);
  const tool = createMobilePreparationTool(preparation);
  const taskIdSchema = tool.parameters.properties.taskId;
  assert.equal(taskIdSchema.anyOf[0].minLength, 1);
  assert.equal(taskIdSchema.anyOf[0].pattern, '\\S');
  assert.equal(taskIdSchema.anyOf[1].type, 'null');
  for (const parameter of Object.values(tool.parameters.properties)) {
    assert.ok(parameter && typeof parameter === 'object' && 'description' in parameter);
    assert.equal(typeof parameter.description, 'string');
  }
  let returnedTaskId: string | undefined;
  const calls: Record<string, unknown>[] = [];
  const run = preparationAgent(tool, (results, request) => {
    let arguments_: Extract<AssistantMessage['content'][number], { type: 'toolCall' }>['arguments'];
    if (request === 1) {
      arguments_ = { action: 'status', taskId: null, waitSeconds: 0, signingAuthorized: false };
    } else if (request === 2) {
      const read = results.get('read')!;
      assert.equal(read.isError, false);
      assert.equal(JSON.parse(read.text).serviceResponding, false);
      assert.equal(f.counts().spawns, 0);
      arguments_ = {
        action: 'start-appium',
        taskId: null,
        waitSeconds: 0.01,
        signingAuthorized: false,
      };
    } else if (request === 3) {
      const start = results.get('start')!;
      assert.equal(start.isError, false);
      const task = JSON.parse(start.text);
      assert.equal(task.state, 'running');
      assert.equal(task.owned, true);
      returnedTaskId = task.taskId;
      assert.equal(typeof returnedTaskId, 'string');
      assert.ok(returnedTaskId);
      f.healthy(true);
      arguments_ = {
        action: 'status',
        taskId: returnedTaskId,
        waitSeconds: 1,
        signingAuthorized: false,
      };
    } else {
      const status = results.get('poll')!;
      assert.equal(status.isError, false);
      const task = JSON.parse(status.text);
      assert.equal(task.taskId, returnedTaskId);
      assert.equal(task.state, 'ready');
      assert.equal(task.serviceResponding, true);
      assert.match(task.summary, /not deviceReady/);
      assert.equal(f.counts().spawns, 1);
      assert.doesNotMatch(status.text, /private-device|private-sdk|pid/);
      return [{ type: 'text', text: 'Service responds; phone readiness is not established.' }];
    }
    calls.push(arguments_);
    return [
      {
        type: 'toolCall',
        id: ['read', 'start', 'poll'][request - 1]!,
        name: tool.name,
        arguments: arguments_,
      },
    ];
  });
  try {
    await run.agent.prompt('Prepare the selected local phone endpoint without another terminal.');
    assert.equal(run.requests(), 4);
    assert.equal(run.agent.state.errorMessage, undefined);
    assert.equal(calls.length, 3);
    for (const args of calls)
      assert.deepEqual(Object.keys(args), ['action', 'taskId', 'waitSeconds', 'signingAuthorized']);
  } finally {
    await preparation.close();
  }
});

test('actual Agent loop rejects empty/blank taskIds at schema and invented IDs at manager without normalization', async () => {
  const f = fixture();
  const preparation = new MobilePreparation(f.maat, f.dependencies);
  const tool = createMobilePreparationTool(preparation);
  const invalid = [
    '',
    '   ',
    false,
    0,
    'current',
    'new',
    'reuse-wda',
    '00000000-0000-4000-8000-000000000000',
  ];
  const run = preparationAgent(tool, (results, request) => {
    if (request > 1) {
      const result = results.get(`invalid-${request - 2}`)!;
      assert.equal(result.isError, true);
      const previous = invalid[request - 2];
      const schemaInvalid = typeof previous !== 'string' || !/\S/.test(previous);
      assert.match(
        result.text,
        schemaInvalid
          ? /Validation failed for tool "prepare_mobile"/
          : /Unknown mobile preparation taskId/,
      );
      assert.equal(f.counts().spawns, 0);
    }
    if (request > invalid.length)
      return [{ type: 'text', text: 'Invalid task IDs were not treated as current/new work.' }];
    return [
      {
        type: 'toolCall',
        id: `invalid-${request - 1}`,
        name: tool.name,
        arguments: {
          action: 'status',
          taskId: invalid[request - 1],
          waitSeconds: 0,
          signingAuthorized: false,
        },
      },
    ];
  });
  try {
    await run.agent.prompt('Verify invalid task identifiers without starting any service.');
    assert.equal(run.agent.state.errorMessage, undefined);
    assert.equal(run.requests(), invalid.length + 1);
    assert.deepEqual(f.counts(), { spawns: 0, stops: 0 });
  } finally {
    await preparation.close();
  }
});
