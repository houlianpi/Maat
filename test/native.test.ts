import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createServer as createNetServer, connect, type Socket } from 'node:net';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { channel } from 'node:diagnostics_channel';
import { spawn } from 'node:child_process';
import {
  startNativeSession,
  NativeSessionCreationUncertainError,
} from '../packages/core/src/platforms/appium/runtime/session.ts';
import {
  capabilities,
  connection,
  splitCapabilities,
  type ResolvedNativeSession,
} from '../packages/core/src/platforms/appium/schema.ts';
import {
  matchDevices,
  parseAndroidDevices,
  parseIosDevices,
} from '../packages/core/src/setup/devices.ts';
import { MaatApi } from '../packages/core/src/api/maat-api.ts';
import { AppiumPlatformAdapter } from '../packages/core/src/platforms/appium/appium-adapter.ts';
import { resolveAndroidReadinessSession } from '../packages/core/src/platforms/appium/session-resolver.ts';
import { resolveIosReadinessSession } from '../packages/core/src/platforms/appium/session-resolver.ts';
import { createDefaultPlatformRegistry } from '../packages/core/src/platforms/default-registry.ts';
import { takeAppiumScreenshot } from '../packages/core/src/platforms/appium/screenshot.ts';
import { NativeManager } from '../packages/core/src/platforms/appium/runtime/manager.ts';
import { PlatformRegistry } from '../packages/core/src/core/platforms/registry.ts';
import type { PlatformAdapter } from '../packages/core/src/core/platforms/contracts.ts';
import { aggregateSetup } from '../packages/core/src/setup-assistant/model.ts';
import {
  ExplorationExecutionError,
  WorkerTerminatedError,
} from '../packages/core/src/core/exploration/runtime.ts';
import type { JavaScriptObservation } from '../packages/core/src/core/exploration/protocol.ts';
import type {
  SetupReadiness,
  SetupReadinessSuccess,
} from '../packages/core/src/setup-assistant/types.ts';
import {
  deviceLockReleaseCallCountsForTests,
  resetDeviceLockFaultTestState,
  setDeviceLockCloseFailureForTests,
  setDeviceLockStateDirectoryForTests,
} from '../packages/core/src/mobile/devices/device-lock.ts';
let workerCreations = 0;
channel('maat.exploration-worker.creation').subscribe(() => workerCreations++);

let nativeDeviceLockRoot = '';
test.beforeEach(async () => {
  nativeDeviceLockRoot = await mkdtemp(path.join(tmpdir(), 'maat-native-device-lock-'));
  setDeviceLockStateDirectoryForTests(nativeDeviceLockRoot);
});
test.afterEach(async () => {
  setDeviceLockStateDirectoryForTests(undefined);
  resetDeviceLockFaultTestState();
  await rm(nativeDeviceLockRoot, { recursive: true, force: true });
});

async function deviceLockChild(
  routingId: string,
  behavior = 'release',
): Promise<Record<string, unknown>> {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(import.meta.dirname, 'fixtures', 'device-lock-child.ts'),
      nativeDeviceLockRoot,
      routingId,
      behavior,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const deadline = setTimeout(() => {
    if (child.pid === undefined) return;
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }, 3_000);
  try {
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      },
    );
    assert.equal(signal, null);
    assert.equal(code, 0, stderr);
    const firstLine = stdout.split('\n').find(Boolean);
    assert.ok(firstLine, 'Device-lock contender returned no result.');
    return JSON.parse(firstLine) as Record<string, unknown>;
  } finally {
    clearTimeout(deadline);
  }
}

function publicErrorReachableText(value: unknown, seen = new Set<unknown>()): string {
  if (value === null || value === undefined || seen.has(value)) return '';
  if (typeof value !== 'object') return String(value);
  seen.add(value);
  return Reflect.ownKeys(value)
    .map((key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      return descriptor && 'value' in descriptor
        ? `${String(key)}:${publicErrorReachableText(descriptor.value, seen)}`
        : String(key);
    })
    .join('\n');
}

async function successfulReadiness(
  api: MaatApi,
  initial: SetupReadiness,
): Promise<SetupReadinessSuccess> {
  if ('jobId' in initial) {
    const result = await api.setup.ready({ jobId: initial.jobId, waitSeconds: 20 });
    if (!('jobId' in result)) assert.fail('Expected connection job readiness result.');
    assert.equal(result.jobId, initial.jobId);
    assert.equal(result.state, 'succeeded');
    assert.equal(result.ready, true);
    if (result.state !== 'succeeded' || result.ready !== true)
      assert.fail('Expected succeeded connection job readiness.');
    assert.ok(result.platform === 'android' || result.platform === 'ios');
    if (result.platform !== 'android' && result.platform !== 'ios')
      assert.fail('Succeeded readiness job requires a mobile platform.');
    assert.ok(result.proof);
    if (!result.proof) assert.fail('Succeeded readiness job requires proof.');
    assert.equal(result.proof.phoneUnlocked, true);
    assert.equal(result.proof.sessionUsable, true);
    assert.equal(result.proof.sourceReadable, true);
    assert.equal(result.proof.viewportReadable, true);
    assert.equal(typeof result.proof.screenshotReadable, 'boolean');
    assert.ok(Array.isArray(result.observations));
    if (!result.observations) assert.fail('Succeeded readiness job requires observations.');
    assert.doesNotMatch(
      JSON.stringify(result),
      /"(?:token|recoveryToken|readinessRecoveryToken)":/,
    );
    return {
      platform: result.platform,
      ready: true,
      ...(result.targetSelection ? { targetSelection: result.targetSelection } : {}),
      proof: result.proof,
      observations: result.observations,
    };
  }
  const result = initial;
  assert.equal(result.ready, true);
  if (result.ready !== true) assert.fail('Expected readiness success, not target selection.');
  assert.doesNotMatch(JSON.stringify(result), /"(?:token|recoveryToken|readinessRecoveryToken)":/);
  return result;
}

async function selectTestTarget(api: MaatApi) {
  const adapter = api.registry.current;
  assert.ok(adapter instanceof AppiumPlatformAdapter);
  const result = await adapter.selectReadinessTarget();
  assert.ok(result?.status === 'target-selected' || result?.status === 'selected');
}

let mockServerId = 0;
type ReadinessAdbOptions = {
  devices?: string;
  power?: string;
  policy?: string;
  shellExitCode?: number;
  stall?: boolean;
  onRequest?: (request: string) => void;
};

async function mockReadinessAdb(options: ReadinessAdbOptions = {}) {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = Number.parseInt(buffer.toString('ascii', 0, 4), 16);
        if (buffer.length < length + 4) return;
        const request = buffer.toString('utf8', 4, length + 4);
        buffer = buffer.subarray(length + 4);
        requests.push(request);
        options.onRequest?.(request);
        if (request === 'host:devices-l') {
          const devices = options.devices ?? 'MOCK_LOCAL_DEVICE\tdevice model:mock\n';
          socket.end('OKAY' + Buffer.byteLength(devices).toString(16).padStart(4, '0') + devices);
        } else if (request === 'host:transport:MOCK_LOCAL_DEVICE') socket.write('OKAY');
        else if (request.startsWith('shell,v2,raw:dumpsys ')) {
          socket.write('OKAY');
          if (options.stall) continue;
          const output =
            request === 'shell,v2,raw:dumpsys power'
              ? (options.power ?? 'mWakefulness=Awake\n')
              : (options.policy ?? 'KeyguardServiceDelegate\n  showing=false\n');
          const payload = Buffer.from(output);
          const frame = Buffer.alloc(5);
          frame[0] = 1;
          frame.writeUInt32LE(payload.length, 1);
          const exit = Buffer.from([3, 1, 0, 0, 0, options.shellExitCode ?? 0]);
          // Deliberately fragment both status/frame data to exercise the real daemon parser.
          socket.write(frame.subarray(0, 2));
          socket.end(Buffer.concat([frame.subarray(2), payload, exit]));
        } else socket.end('FAIL');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No mock ADB address');
  let closePromise: Promise<void> | undefined;
  return {
    options,
    requests,
    connect: () => connect({ host: '127.0.0.1', port: address.port }),
    close: () =>
      (closePromise ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      })()),
  };
}

async function mockAppium(
  options: {
    sessionDelayMs?: number;
    onSessionRequest?: () => void;
    afterSession?: () => void;
    deleteFailure?: boolean;
    isLocked?: () => unknown;
    readinessAdb?: ReadinessAdbOptions;
    sourceBarrier?: () => Promise<void>;
    screenshotFailure?: () => boolean;
    sourceFailure?: () =>
      | { error: string; message: string; code?: string; data?: Record<string, unknown> }
      | undefined;
    statusFailure?: boolean;
    sessionFailure?: string;
    sessionResponse?: 'invalid-json' | 'missing-id' | 'socket-loss';
  } = {},
) {
  const serverId = ++mockServerId;
  let deletes = 0;
  let creations = 0;
  let cancelledResponses = 0;
  let lockQueries = 0;
  const requests: string[] = [];
  const sessionCapabilities: Record<string, unknown>[] = [];
  const adb = options.readinessAdb ? await mockReadinessAdb(options.readinessAdb) : undefined;
  const sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    let value: unknown = null;
    if (req.url === '/session' && req.method === 'POST') {
      creations++;
      sessionCapabilities.push(body.capabilities.alwaysMatch);
      options.onSessionRequest?.();
      if (options.sessionResponse === 'socket-loss') {
        req.socket.destroy();
        return;
      }
      if (options.sessionResponse === 'invalid-json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"value":');
        return;
      }
      if (options.sessionResponse === 'missing-id') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ value: { capabilities: body.capabilities.alwaysMatch } }));
        return;
      }
      if (options.sessionFailure) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            value: { error: 'session not created', message: options.sessionFailure },
          }),
        );
        return;
      }
      res.on('close', () => {
        if (!res.writableFinished) cancelledResponses++;
      });
      if (options.sessionDelayMs)
        await new Promise((resolve) => setTimeout(resolve, options.sessionDelayMs));
      value = {
        sessionId: `owned-${serverId}-${creations}`,
        capabilities: body.capabilities.alwaysMatch,
      };
    } else if (req.method === 'DELETE') {
      deletes++;
      if (options.deleteFailure) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ value: { error: 'unknown error', message: 'delete Session failed' } }),
        );
        return;
      }
    } else if (req.url === '/status') {
      if (options.statusFailure) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ value: { ready: false } }));
        return;
      }
      value = { ready: true };
    } else if (
      req.url?.endsWith('/appium/device/is_locked') ||
      (req.url?.endsWith('/execute/sync') && body.script === 'mobile: isLocked')
    ) {
      lockQueries++;
      try {
        value = options.isLocked ? options.isLocked() : false;
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            value: {
              error: 'unknown error',
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
        return;
      }
    } else if (req.url?.endsWith('/element'))
      value = { 'element-6066-11e4-a52e-4f735466cecf': 'button-1' };
    else if (req.url?.endsWith('/text')) value = 'Welcome';
    else if (req.url?.endsWith('/displayed')) value = true;
    else if (req.url?.endsWith('/screenshot')) {
      if (options.screenshotFailure?.()) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            value: { error: 'unknown error', message: 'screenshot command failed' },
          }),
        );
        return;
      }
      value = 'iVBORw0KGgo=';
    } else if (req.url?.endsWith('/source')) {
      await options.sourceBarrier?.();
      const failure = options.sourceFailure?.();
      if (failure) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ value: failure }));
        return;
      }
      value = '<Application name="Demo" />';
    } else if (req.url?.endsWith('/window/rect')) value = { x: 0, y: 0, width: 360, height: 800 };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value }));
    if (req.url === '/session' && req.method === 'POST') options.afterSession?.();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  let closePromise: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}/`,
    server,
    deleted: () => deletes,
    created: () => creations,
    cancelledResponses: () => cancelledResponses,
    lockQueries: () => lockQueries,
    sessionCapabilities,
    requests,
    adb,
    close: () =>
      (closePromise ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await adb?.close();
      })()),
  };
}

function androidReadinessApi(root: string, connectAdb: () => Socket) {
  class ReadinessAdapter extends AppiumPlatformAdapter {
    protected override async discoverSelectionDevices() {
      return [{ id: 'MOCK_LOCAL_DEVICE', name: 'mock', kind: 'device' as const }];
    }
    protected override resolveReadiness(
      signal?: AbortSignal,
      identity?: Parameters<typeof resolveAndroidReadinessSession>[3],
      environment = this.sessionHints!,
    ) {
      return resolveAndroidReadinessSession(environment, signal, connectAdb, identity);
    }
    override async selectReadinessTarget(
      selection?: Parameters<AppiumPlatformAdapter['selectReadinessTarget']>[0],
      signal?: AbortSignal,
    ) {
      const result = await super.selectReadinessTarget(selection, signal);
      return result?.status === 'target-selected'
        ? super.selectReadinessTarget(undefined, signal)
        : result;
    }
  }
  return new MaatApi(
    new PlatformRegistry(
      [
        new ReadinessAdapter({
          id: 'android',
          label: 'Android',
          platformName: 'Android',
          automationName: 'UiAutomator2',
        }),
      ],
      'android',
    ),
    root,
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
          technicalDetails: { serverScope: 'remote' },
        }),
    },
  );
}

test('native codeContext advertises app only when the runtime can bind a configured App ID', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-native-context-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  try {
    for (const platform of ['android', 'ios'] as const) {
      const adapter = new AppiumPlatformAdapter({
        id: platform,
        label: platform,
        platformName: platform === 'android' ? 'Android' : 'iOS',
        automationName: platform === 'android' ? 'UiAutomator2' : 'XCUITest',
      });
      assert.equal(
        adapter.codeContext.globals.some((global) => global.name === 'app'),
        false,
      );
      assert.doesNotMatch(adapter.codeContext.guidelines.join('\n'), /app\.resourceId/);
      await adapter.configureSession({
        capabilities: {
          [platform === 'android' ? 'appium:appPackage' : 'appium:bundleId']: 'com.example.target',
        },
      });
      assert.equal(
        adapter.codeContext.globals.some((global) => global.name === 'app'),
        true,
      );
      assert.match(
        adapter.codeContext.globals.find((global) => global.name === 'app')!.description,
        /not the current foreground App/,
      );
      await adapter.configureSession({ clearAppTarget: true });
      assert.equal(
        adapter.codeContext.globals.some((global) => global.name === 'app'),
        false,
      );
      await adapter.close();
    }
  } finally {
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await rm(root, { recursive: true, force: true });
  }
});

test('native defaults preserve data and device discovery excludes offline devices', () => {
  assert.equal(capabilities({ platform: 'ios', capabilities: {} })['appium:noReset'], true);
  assert.equal(
    capabilities({ platform: 'macos', capabilities: {} })['appium:automationName'],
    'Mac2',
  );
  assert.equal(connection('http://localhost:4723/wd/hub').path, '/wd/hub');
  assert.equal(
    'appium:skipUnlock' in capabilities({ platform: 'android', capabilities: {} }),
    false,
  );
  assert.equal(
    parseAndroidDevices('List of devices attached\na device model:Pixel\nb unauthorized\nc offline')
      .length,
    1,
  );
});

test('Android ready reuses its unlock-safe Session and guards a locked new Session after becoming idle', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ready-skip-unlock-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  let locked = false;
  const mock = await mockAppium({ isLocked: () => locked, readinessAdb: {} });
  const api = androidReadinessApi(root, mock.adb!.connect);
  const hints = { 'appium:deviceName': 'mock' };
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock' },
      capabilities: hints,
    });
    const result = await successfulReadiness(api, await api.setup.ready());
    assert.deepEqual(result.proof, {
      phoneUnlocked: true,
      sessionUsable: true,
      sourceReadable: true,
      viewportReadable: true,
      screenshotReadable: false,
    });
    const observation = result.observations.find((item) => item.type === 'text');
    assert.ok(observation && observation.type === 'text');
    assert.equal(JSON.parse(observation.text).phoneUnlocked, true);
    assert.equal(mock.sessionCapabilities[0]?.['appium:skipUnlock'], true);
    assert.equal('appium:skipDeviceInitialization' in mock.sessionCapabilities[0]!, false);
    assert.equal('appium:skipServerInstallation' in mock.sessionCapabilities[0]!, false);
    const adapter = api.registry.current as AppiumPlatformAdapter;
    assert.deepEqual(adapter.sessionHints?.capabilities, hints);
    assert.equal(
      (await successfulReadiness(api, await api.setup.ready())).proof.phoneUnlocked,
      true,
    );
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 0);
    assert.equal(mock.lockQueries(), 4);
    assert.equal(
      mock.requests.some((request) => /\/(unlock|lock|press_keycode|keyevent)$/.test(request)),
      false,
    );
    await api.platforms.configureSession({ capabilities: hints });
    assert.equal(api.platforms.status().session, 'idle');
    locked = true;
    mock.adb!.options.power = 'mWakefulness=Asleep\n';
    const beforeRecheck = mock.requests.length;
    await assert.rejects(api.setup.ready({ screenshot: true }), /ANDROID_DEVICE_LOCKED/);
    assert.equal(mock.created(), 1);
    assert.equal(mock.lockQueries(), 4);
    assert.equal(
      mock.requests
        .slice(beforeRecheck)
        .some((request) =>
          /\/(source|screenshot|unlock|lock|press_keycode|keyevent)$/.test(request),
        ),
      false,
    );
    assert.deepEqual(adapter.sessionHints?.capabilities, hints);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Android ready refuses conflicting unlock hints before POST and never overwrites explicit intent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ready-unlock-conflict-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium({ readinessAdb: {} });
  const api = androidReadinessApi(root, mock.adb!.connect);
  try {
    for (const skipUnlock of [false, 'false', null]) {
      await api.platforms.configureSession({
        serverUrl: mock.url,
        device: { kind: 'device', name: 'mock' },
        capabilities: { 'appium:deviceName': 'mock', 'appium:skipUnlock': skipUnlock },
      });
      await assert.rejects(api.setup.ready(), /ANDROID_READINESS_UNLOCK_UNSAFE/);
      const adapter = api.registry.current as AppiumPlatformAdapter;
      assert.equal(adapter.sessionHints?.capabilities['appium:skipUnlock'], skipUnlock);
      assert.equal(api.platforms.status().session, 'idle');
      assert.equal(mock.created(), 0);
      assert.equal(mock.deleted(), 0);
    }
    for (const options of [
      { skipUnlock: false },
      { skipUnlock: 'false' },
      { skipUnlock: null },
      { 'appium:skipUnlock': false },
    ]) {
      await api.platforms.configureSession({
        capabilities: { 'appium:skipUnlock': true, 'appium:options': options },
      });
      await assert.rejects(api.setup.ready(), /ANDROID_READINESS_UNLOCK_UNSAFE/);
      const adapter = api.registry.current as AppiumPlatformAdapter;
      assert.deepEqual(adapter.sessionHints?.capabilities['appium:options'], options);
      assert.equal(mock.created(), 0);
    }
    await api.platforms.configureSession({
      capabilities: {
        'appium:skipUnlock': true,
        'appium:options': { skipUnlock: true },
      },
    });
    assert.equal((await api.setup.ready()).ready, true);
    assert.equal(mock.created(), 1);
    assert.equal(mock.sessionCapabilities[0]?.['appium:skipUnlock'], true);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Android ready locked/unknown states cross the Worker boundary visibly without source/image or replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ready-locked-worker-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  let locked: unknown = true;
  const mock = await mockAppium({ isLocked: () => locked, readinessAdb: {} });
  const api = androidReadinessApi(root, mock.adb!.connect);
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock' },
      capabilities: { 'appium:deviceName': 'mock' },
    });
    for (const state of [true, null, undefined, 'false']) {
      locked = state;
      await assert.rejects(api.setup.ready({ screenshot: true }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          state === true ? /ANDROID_DEVICE_LOCKED/ : /ANDROID_DEVICE_LOCK_STATE_UNKNOWN/,
        );
        assert.match(error.message, /No JavaScript was replayed/);
        assert.ok(error.cause instanceof ExplorationExecutionError);
        return true;
      });
    }
    assert.equal(mock.created(), 1);
    assert.equal(mock.sessionCapabilities[0]?.['appium:skipUnlock'], true);
    assert.equal(mock.lockQueries(), 4);
    assert.equal(
      mock.requests.some((request) => /\/(source|screenshot)$/.test(request)),
      false,
    );
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Android ready lock command failure exposes a bounded redacted driver reason across real Worker IPC without retry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ready-lock-query-error-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const serial = 'SYNTHETIC_LOCK_QUERY_SERIAL';
  const privatePath = '/Users/synthetic-private/lock-query';
  const token = 'synthetic-lock-query-token';
  const endpoint = 'https://synthetic.example/private-lock-query';
  const failure = new Error(
    `ELOCK_QUERY: read-only driver query failed\nserial=${serial} ${privatePath} token=${token} ${endpoint}\n${'bounded reason '.repeat(200)}END_OF_OVERSIZED_REASON`,
  );
  const mock = await mockAppium({
    readinessAdb: {},
    isLocked: () => {
      throw failure;
    },
  });
  const api = androidReadinessApi(root, mock.adb!.connect);
  const adapter = api.registry.current as AppiumPlatformAdapter;
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock' },
      capabilities: { 'appium:deviceName': 'mock' },
    });
    await assert.rejects(api.setup.ready({ screenshot: true }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /ANDROID_DEVICE_LOCK_STATE_UNKNOWN/);
      assert.ok(error.cause instanceof ExplorationExecutionError);
      assert.equal(error.cause.details.category, 'runtime-error');
      assert.equal(error.cause.details.phase, 'execute');
      assert.equal(error.cause.details.actionState, 'uncertain');
      assert.match(error.message, /No JavaScript was replayed/);
      assert.match(error.message, /setup\.ready/);
      const reachable = publicErrorReachableText(error);
      for (const sensitive of [serial, privatePath, token, endpoint])
        assert.equal(reachable.includes(sensitive), false);
      assert.equal(reachable.includes('ELOCK_QUERY'), false);
      assert.equal(reachable.includes('END_OF_OVERSIZED_REASON'), false);
      return true;
    });
    assert.equal(mock.created(), 1);
    assert.equal(mock.lockQueries(), 1);
    assert.equal(
      mock.requests.some((request) =>
        /\/(source|screenshot|unlock|lock|press_keycode|keyevent)$/.test(request),
      ),
      false,
    );
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'readiness cancellation and timeout expose only safe errors without raw execution causes',
  { timeout: 25_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'maat-ready-safe-errors-'));
    const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
    process.env.MAAT_SESSION_HINTS_DIR = root;
    const adapter = new AppiumPlatformAdapter({
      id: 'android',
      label: 'Android',
      platformName: 'Android',
      automationName: 'UiAutomator2',
    });
    const api = new MaatApi(new PlatformRegistry([adapter], 'android'), root, {
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
          technicalDetails: { serverScope: 'remote' },
        }),
    });
    const secrets = [
      'PRIVATE_READINESS_SESSION',
      'owner=PRIVATE_OWNER',
      'udid=PRIVATE_UDID',
      'serial=PRIVATE_SERIAL',
      'https://private.example/session/path',
      '/private/readiness/path',
      'credential=PRIVATE_CREDENTIAL',
    ];
    adapter.executeReadiness = async (_code, signal) => {
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      throw new ExplorationExecutionError(secrets.join(' '), {
        name: 'PrivateTransportError',
        message: secrets.join(' '),
        category: 'runtime-error',
        phase: 'execute',
        actionState: 'uncertain',
      });
    };
    const assertSafe = (expected: RegExp) => (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, expected);
      assert.ok(error.cause instanceof ExplorationExecutionError);
      assert.equal(error.cause.details.category, 'runtime-error');
      assert.equal(error.cause.details.phase, 'execute');
      assert.equal(error.cause.details.actionState, 'uncertain');
      const reachable = publicErrorReachableText(error);
      for (const secret of secrets) assert.equal(reachable.includes(secret), false);
      return true;
    };
    try {
      await api.platforms.configureSession({
        serverUrl: 'https://remote.example/',
        capabilities: {},
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error(secrets.join(' '))), 10);
      await assert.rejects(
        api.setup.ready({ signal: controller.signal }),
        assertSafe(/readiness cancelled/i),
      );
      await assert.rejects(api.setup.ready(), assertSafe(/readiness timed out/i));
    } finally {
      await api.close();
      if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
      else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('cold Android ready blocks locked/off/unknown device states before POST, helper or UI reads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ready-cold-state-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  let helperStarts = 0;
  const mock = await mockAppium({
    readinessAdb: {},
    onSessionRequest: () => helperStarts++,
  });
  const api = androidReadinessApi(root, mock.adb!.connect);
  const adapter = api.registry.current as AppiumPlatformAdapter;
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock' },
      capabilities: {},
    });
    for (const state of [
      { power: 'mWakefulness=Asleep\n', code: 'ANDROID_DEVICE_LOCKED' },
      { power: 'mWakefulness=Dozing\n', code: 'ANDROID_DEVICE_LOCKED' },
      { power: 'mWakefulness=Dreaming\n', code: 'ANDROID_DEVICE_LOCKED' },
      { policy: 'KeyguardServiceDelegate\n  showing=true\n', code: 'ANDROID_DEVICE_LOCKED' },
      {
        policy: 'KeyguardServiceDelegate\n  showing=false\n  screenState=SCREEN_STATE_OFF\n',
        code: 'ANDROID_DEVICE_LOCKED',
      },
      { power: '', code: 'ANDROID_DEVICE_LOCK_STATE_UNKNOWN' },
      { power: 'mWakefulness=Unknown\n', code: 'ANDROID_DEVICE_LOCK_STATE_UNKNOWN' },
      { policy: '', code: 'ANDROID_DEVICE_LOCK_STATE_UNKNOWN' },
      { policy: 'showing=false\n', code: 'ANDROID_DEVICE_LOCK_STATE_UNKNOWN' },
      {
        policy: 'KeyguardServiceDelegate\n  showing=false\n  showing=false\n',
        code: 'ANDROID_DEVICE_LOCK_STATE_UNKNOWN',
      },
      { shellExitCode: 1, code: 'ANDROID_DEVICE_LOCK_STATE_UNKNOWN' },
      {
        devices: 'OTHER_PRIVATE_DEVICE\tdevice model:other\n',
        code: 'ANDROID_DEVICE_LOCK_STATE_UNKNOWN',
      },
    ]) {
      Object.assign(mock.adb!.options, {
        power: 'mWakefulness=Awake\n',
        policy: 'KeyguardServiceDelegate\n  showing=false\n',
        shellExitCode: 0,
        devices: 'MOCK_LOCAL_DEVICE\tdevice model:mock\n',
        ...state,
      });
      await assert.rejects(api.setup.ready({ screenshot: true }), new RegExp(state.code));
      assert.equal(api.platforms.status().session, 'idle');
      assert.equal(mock.created(), 0);
      assert.equal(mock.lockQueries(), 0);
      assert.equal(helperStarts, 0);
    }
    assert.equal(
      mock.requests.some((request) => /\/(source|screenshot)$/.test(request)),
      false,
    );
    assert.ok(
      mock.adb!.requests.every((request) =>
        [
          'host:devices-l',
          'host:transport:MOCK_LOCAL_DEVICE',
          'shell,v2,raw:dumpsys power',
          'shell,v2,raw:dumpsys window policy',
        ].includes(request),
      ),
    );
    assert.equal(
      mock.adb!.requests.some((request) => /OTHER_PRIVATE_DEVICE/.test(request)),
      false,
    );
    assert.deepEqual(
      (api.registry.current as AppiumPlatformAdapter).sessionHints?.capabilities,
      {},
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'cold Android ready timeout/Abort stay fail-closed before POST without replay or helper initialization',
  { timeout: 40_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'maat-ready-cold-timeout-'));
    const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
    process.env.MAAT_SESSION_HINTS_DIR = root;
    const mock = await mockAppium({ readinessAdb: { stall: true } });
    const api = androidReadinessApi(root, mock.adb!.connect);
    try {
      await api.platforms.configureSession({
        serverUrl: mock.url,
        device: { kind: 'device', name: 'mock' },
        capabilities: {},
      });
      const deadlineStarted = await api.setup.ready({ waitSeconds: 0 });
      assert.ok('jobId' in deadlineStarted);
      assert.equal(deadlineStarted.state, 'running');
      const deadlineTerminal = await api.setup.ready({
        jobId: deadlineStarted.jobId,
        waitSeconds: 20,
      });
      assert.ok('jobId' in deadlineTerminal);
      assert.equal(deadlineTerminal.state, 'failed');
      assert.equal(deadlineTerminal.category, 'readiness-failed');
      assert.equal(mock.created(), 0);
      const controller = new AbortController();
      mock.adb!.options.onRequest = (request) => {
        if (request.startsWith('shell,v2,raw:')) controller.abort(new Error('cancelled preflight'));
      };
      const callerStarted = await api.setup.ready({ waitSeconds: 0 });
      assert.ok('jobId' in callerStarted);
      const callerWait = api.setup.ready({
        jobId: callerStarted.jobId,
        waitSeconds: 20,
        signal: controller.signal,
      });
      await assert.rejects(callerWait, /cancelled preflight/);
      const stillRunning = await api.setup.ready({
        jobId: callerStarted.jobId,
        waitSeconds: 0,
      });
      assert.ok('jobId' in stillRunning);
      assert.equal(stillRunning.state, 'running');
      const callerTerminal = await api.setup.ready({
        jobId: callerStarted.jobId,
        waitSeconds: 5,
      });
      assert.ok('jobId' in callerTerminal);
      assert.equal(callerTerminal.state, 'failed');
      assert.equal(callerTerminal.category, 'readiness-failed');
      assert.equal(mock.created(), 0);
      assert.equal(mock.lockQueries(), 0);
      assert.equal(
        mock.adb!.requests.filter((request) => request === 'shell,v2,raw:dumpsys power').length,
        2,
      );
      assert.equal(
        mock.adb!.requests.some((request) => request === 'shell,v2,raw:dumpsys window policy'),
        false,
      );
    } finally {
      await api.close();
      if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
      else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('cold Android ready refuses remote or ambiguous routing without local probes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ready-cold-routing-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium({ readinessAdb: {} });
  const apis: MaatApi[] = [];
  try {
    for (const route of [
      { serverUrl: 'https://remote.example/' },
      { capabilities: { 'appium:remoteAdbHost': 'remote.example' } },
      { capabilities: { 'appium:adbPort': 5038 } },
      { capabilities: { 'appium:avd': 'OTHER_EMULATOR' } },
      { capabilities: { 'appium:options': { remoteAdbHost: 'remote.example' } } },
      { capabilities: { 'appium:options': { udid: 'OTHER_PRIVATE_DEVICE' } } },
    ]) {
      const api = androidReadinessApi(root, mock.adb!.connect);
      apis.push(api);
      await api.platforms.configureSession({
        serverUrl: mock.url,
        device: { kind: 'device', name: 'mock' },
        capabilities: {},
        ...route,
      });
      await assert.rejects(api.setup.ready(), /ANDROID_READINESS_COLD_UNSUPPORTED/);
      await assert.rejects(
        api.exploration.executeJavaScript("await driver.$('~send').click();"),
        /ANDROID_READINESS_COLD_UNSUPPORTED/,
      );
      assert.equal(mock.created(), 0);
      assert.equal(
        mock.adb!.requests.some((request) => request.startsWith('shell,')),
        false,
      );
      await api.close();
      apis.pop();
    }
  } finally {
    for (const api of apis) await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cold Android ready never falls back from an unavailable configured endpoint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ready-no-server-fallback-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium({ readinessAdb: {}, statusFailure: true });
  const api = androidReadinessApi(root, mock.adb!.connect);
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock' },
      capabilities: {},
    });

    await assert.rejects(api.setup.ready(), /APPIUM_SERVICE_UNAVAILABLE/);
    assert.deepEqual(mock.requests, ['GET /status', 'GET /status']);
    assert.deepEqual(mock.adb!.requests, []);
    assert.equal(mock.created(), 0);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary Android cold execution preserves App intent, exact phone/endpoint and blocks locked/off/unknown before POST', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-execute-cold-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium({ readinessAdb: {} });
  const api = androidReadinessApi(root, mock.adb!.connect);
  const adapter = api.registry.current as AppiumPlatformAdapter;
  assert.equal('commitReadinessRecovery' in adapter, false);
  assert.equal(Object.isFrozen(adapter.runtime), true);
  assert.equal(Object.getOwnPropertyDescriptor(adapter, 'runtime')?.writable, false);
  assert.equal(
    Reflect.defineProperty(adapter, 'runtime', {
      value: new NativeManager(),
    }),
    false,
  );
  assert.equal('executeReadinessTransaction' in adapter.runtime, false);
  assert.equal('session' in adapter.runtime, false);
  assert.equal('lease' in adapter.runtime, false);
  assert.equal('recoveryRequired' in adapter.runtime, false);
  for (const surface of [
    adapter,
    Object.getPrototypeOf(adapter),
    adapter.runtime,
    Object.getPrototypeOf(adapter.runtime),
  ])
    assert.equal(
      Reflect.ownKeys(surface).some((key) =>
        /readinessRecovery|commitReadiness|cancelReadiness|pendingReadiness/i.test(String(key)),
      ),
      false,
    );
  const target = { 'appium:appPackage': 'com.example.target', 'appium:appActivity': '.Main' };
  const code = "await driver.$('~send').click();";
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock' },
      capabilities: target,
    });
    await selectTestTarget(api);
    for (const state of [
      { power: 'mWakefulness=Asleep\n', code: 'ANDROID_DEVICE_LOCKED' },
      { policy: 'KeyguardServiceDelegate\n  showing=true\n', code: 'ANDROID_DEVICE_LOCKED' },
      { power: '', code: 'ANDROID_DEVICE_LOCK_STATE_UNKNOWN' },
      { policy: '', code: 'ANDROID_DEVICE_LOCK_STATE_UNKNOWN' },
    ]) {
      Object.assign(mock.adb!.options, {
        power: 'mWakefulness=Awake\n',
        policy: 'KeyguardServiceDelegate\n  showing=false\n',
        ...state,
      });
      await assert.rejects(api.exploration.executeJavaScript(code), new RegExp(state.code));
      assert.equal(mock.created(), 0);
      assert.deepEqual(adapter.appTarget, target);
    }
    Object.assign(mock.adb!.options, {
      power: 'mWakefulness=Awake\n',
      policy: 'KeyguardServiceDelegate\n  showing=false\n',
    });
    const transportsBefore = mock.adb!.requests.filter((item) =>
      item.startsWith('host:transport:'),
    ).length;
    mock.adb!.options.devices = 'OTHER_LOCAL_DEVICE\tdevice model:other\n';
    await assert.rejects(api.exploration.executeJavaScript(code), /no other device was selected/);
    assert.equal(mock.created(), 0);
    assert.equal(
      mock.adb!.requests.filter((item) => item.startsWith('host:transport:')).length,
      transportsBefore,
    );
    mock.adb!.options.devices = 'MOCK_LOCAL_DEVICE\tdevice model:mock\n';
    const readsBefore = mock.adb!.requests.length;
    await assert.rejects(
      api.platforms.configureSession({ serverUrl: 'http://127.0.0.1:1/' }),
      /pins its Appium endpoint/,
    );
    assert.equal(mock.adb!.requests.length, readsBefore);
    assert.equal(mock.created(), 0);
    assert.equal(
      mock.requests.some((request) => /\/(element|click|activate_app)$/.test(request)),
      false,
    );
    assert.deepEqual(await adapter.execute('console.log(app.id);'), [
      { type: 'text', text: 'com.example.target' },
    ]);
    assert.equal(mock.created(), 1);
    assert.equal(mock.sessionCapabilities[0]?.['appium:skipUnlock'], true);
    assert.equal(mock.sessionCapabilities[0]?.['appium:appActivity'], '.Main');
    assert.deepEqual(adapter.appTarget, target);
    assert.equal(
      mock.requests.some((request) => /\/(unlock|lock|press_keycode)$/.test(request)),
      false,
    );
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary healthy Android guards every Core execution; locked/unknown/Abort never dispatch or replay user actions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-execute-guard-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  let locked: unknown = false;
  const controller = new AbortController();
  let abortAtGuard = false;
  const mock = await mockAppium({
    readinessAdb: {},
    isLocked: () => {
      if (abortAtGuard) controller.abort(new Error('cancelled lock guard'));
      return locked;
    },
  });
  const api = androidReadinessApi(root, mock.adb!.connect);
  const adapter = api.registry.current as AppiumPlatformAdapter;
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock' },
      capabilities: { 'appium:appPackage': 'com.example.target' },
    });
    await selectTestTarget(api);
    await adapter.execute("console.log('healthy');");
    const code = "await driver.$('~send').click();";
    for (const state of [true, undefined, 'false']) {
      locked = state;
      await assert.rejects(adapter.execute(code), /ANDROID_DEVICE_LOCK/);
      assert.equal(mock.created(), 1);
      assert.equal(mock.deleted(), 0);
    }
    assert.equal(mock.lockQueries(), 4);
    assert.equal(
      mock.requests.some((request) => /\/(element|click)$/.test(request)),
      false,
    );
    locked = false;
    await assert.rejects(
      adapter.execute("throw new Error('app activity failure');"),
      /app activity failure/,
    );
    assert.equal(adapter.runtime.isRunning, true);
    assert.equal(mock.created(), 1);
    abortAtGuard = true;
    await assert.rejects(adapter.execute(code, controller.signal), (error: unknown) => {
      assert.ok(error instanceof ExplorationExecutionError);
      assert.equal(error.details.category, 'runtime-error');
      assert.equal(error.details.phase, 'execute');
      assert.equal(error.details.actionState, 'uncertain');
      assert.match(error.message, /terminated after dispatch/);
      assert.match(error.message, /setup\.ready/);
      return true;
    });
    assert.equal(adapter.runtime.isRunning, false);
    assert.equal(mock.deleted(), 1);
    assert.equal(mock.created(), 1);
    assert.equal(
      mock.requests.some((request) => /\/(element|click)$/.test(request)),
      false,
    );
    assert.deepEqual(adapter.appTarget, { 'appium:appPackage': 'com.example.target' });
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('native bootstrap cancels the actual slow POST without retry and reports unknown remote ownership', async () => {
  const reason = new Error('cancelled during POST');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const mock = await mockAppium({
    sessionDelayMs: 300,
    onSessionRequest: () => {
      timer = setTimeout(() => controller.abort(reason), 100);
    },
  });
  const workersBefore = workerCreations;
  const started = Date.now();
  try {
    await assert.rejects(
      startNativeSession(
        {
          environment: { platform: 'android', serverUrl: mock.url, capabilities: {} },
          capabilities: {},
        },
        5_000,
        { signal: controller.signal },
      ),
      (error: unknown) => {
        assert.ok(error instanceof NativeSessionCreationUncertainError);
        assert.match(error.message, /POST \/session may have dispatched/);
        assert.equal(error.abortReason, reason);
        assert.equal(error.facts.dispatchPossible, true);
        assert.equal(error.facts.responseReceived, false);
        assert.equal(error.facts.trustedSessionId, false);
        assert.equal(error.facts.causeCategory, 'abort');
        assert.ok(error.internalCause instanceof Error);
        return true;
      },
    );
    assert.ok(Date.now() - started < 2_000);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(mock.created(), 1);
    assert.equal(mock.cancelledResponses(), 1);
    assert.equal(mock.deleted(), 0); // Never delete a guessed/foreign Session ID.
    assert.equal(workerCreations - workersBefore, 0);
    assert.equal(
      mock.requests.some((request) => request.endsWith('/source')),
      false,
    );
  } finally {
    clearTimeout(timer);
    await mock.close();
  }
});

test('native bootstrap deadline bounds slow HTTP even without a caller AbortSignal', async () => {
  const mock = await mockAppium({ sessionDelayMs: 250 });
  const workersBefore = workerCreations;
  const started = Date.now();
  try {
    await assert.rejects(
      startNativeSession(
        {
          environment: { platform: 'ios', serverUrl: mock.url, capabilities: {} },
          capabilities: {},
        },
        5_000,
        { initializationTimeoutMs: 100 },
      ),
      (error: unknown) => {
        assert.ok(error instanceof NativeSessionCreationUncertainError);
        assert.equal(error.facts.causeCategory, 'timeout');
        return true;
      },
    );
    assert.ok(Date.now() - started < 2_000);
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 0);
    assert.equal(workerCreations - workersBefore, 0);
  } finally {
    await mock.close();
  }
});

test('native bootstrap classifies response loss, invalid JSON and missing Session ID without DELETE', async () => {
  for (const response of ['socket-loss', 'invalid-json', 'missing-id'] as const) {
    const mock = await mockAppium({ sessionResponse: response });
    const workersBefore = workerCreations;
    try {
      await assert.rejects(
        startNativeSession({
          environment: { platform: 'android', serverUrl: mock.url, capabilities: {} },
          capabilities: {},
        }),
        (error: unknown) => {
          assert.ok(error instanceof NativeSessionCreationUncertainError);
          assert.equal(error.facts.dispatchPossible, true);
          assert.equal(error.facts.trustedSessionId, false);
          assert.equal(error.facts.responseReceived, response !== 'socket-loss');
          assert.equal(
            error.facts.causeCategory,
            response === 'missing-id'
              ? 'missing-session-id'
              : response === 'invalid-json'
                ? 'invalid-response'
                : 'transport',
          );
          return true;
        },
      );
      assert.equal(mock.created(), 1);
      assert.equal(mock.deleted(), 0);
      assert.equal(workerCreations - workersBefore, 0);
    } finally {
      await mock.close();
    }
  }
});

test('pre-aborted bootstrap does not prepare POST; explicit session-not-created remains retryable', async () => {
  const preAborted = await mockAppium();
  const controller = new AbortController();
  controller.abort(new Error('cancel before bootstrap'));
  try {
    await assert.rejects(
      startNativeSession(
        {
          environment: { platform: 'android', serverUrl: preAborted.url, capabilities: {} },
          capabilities: {},
        },
        5_000,
        { signal: controller.signal },
      ),
      /cancel before bootstrap/,
    );
    assert.equal(preAborted.created(), 0);
  } finally {
    await preAborted.close();
  }

  const explicit = await mockAppium({ sessionFailure: 'complete rejected capabilities' });
  try {
    for (let attempt = 0; attempt < 2; attempt++)
      await assert.rejects(
        startNativeSession({
          environment: { platform: 'ios', serverUrl: explicit.url, capabilities: {} },
          capabilities: {},
        }),
        (error: unknown) => {
          assert.ok(!(error instanceof NativeSessionCreationUncertainError));
          assert.match(String(error), /complete rejected capabilities/);
          return true;
        },
      );
    assert.equal(explicit.created(), 2);
    assert.equal(explicit.deleted(), 0);
  } finally {
    await explicit.close();
  }
});

test('Abort between entry validation and transport acceptance does not latch possible dispatch', async () => {
  const mock = await mockAppium();
  const controller = new AbortController();
  const workersBefore = workerCreations;
  try {
    const first = startNativeSession(
      {
        environment: { platform: 'android', serverUrl: mock.url, capabilities: {} },
        capabilities: {},
      },
      5_000,
      { signal: controller.signal },
    );
    queueMicrotask(() => controller.abort(new Error('cancel before transport acceptance')));
    await assert.rejects(first, /cancel before transport acceptance|abort/i);
    assert.equal(mock.created(), 0);
    assert.equal(mock.deleted(), 0);
    assert.equal(workerCreations - workersBefore, 0);

    const retry = await startNativeSession(
      {
        environment: { platform: 'android', serverUrl: mock.url, capabilities: {} },
        capabilities: {},
      },
      5_000,
    );
    assert.equal(mock.created(), 1);
    assert.equal(workerCreations - workersBefore, 1);
    await retry.close();
    assert.equal(mock.deleted(), 1);
  } finally {
    await mock.close();
  }
});

test('a Session result obtained before cancellation is deleted after safe Worker initialization abort', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled after POST result');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const mock = await mockAppium({
    afterSession: () => {
      timer = setTimeout(() => controller.abort(reason), 50);
    },
  });
  const workersBefore = workerCreations;
  try {
    await assert.rejects(
      startNativeSession(
        {
          environment: { platform: 'android', serverUrl: mock.url, capabilities: {} },
          capabilities: {},
        },
        5_000,
        { signal: controller.signal },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ExplorationExecutionError);
        assert.equal(error.details.name, 'NativeSessionInitializationError');
        assert.equal(error.details.category, 'runtime-error');
        assert.equal(error.details.phase, 'validate');
        assert.equal(error.details.actionState, 'not-started');
        assert.match(error.message, /Worker initialization failed/);
        assert.match(error.message, /setup\.ready/);
        assert.equal(error.cause, undefined);
        assert.equal(error.message.includes(reason.message), false);
        return true;
      },
    );
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 1);
    assert.equal(workerCreations - workersBefore, 1);
    assert.equal(
      mock.requests.some((request) => request.endsWith('/source')),
      false,
    );
    assert.equal(mock.server.listening, true);
  } finally {
    clearTimeout(timer);
    await mock.close();
  }
});

test('Worker initialization and DELETE failures expose only safe primary and cleanup errors', async () => {
  const controller = new AbortController();
  const secrets = [
    'PRIVATE_INIT_TOKEN',
    'PRIVATE_DEVICE_SERIAL',
    '/private/worker/bootstrap/path',
    'credential=private-password',
  ];
  const reason = new Error(`cancelled Worker initialization ${secrets.join(' ')}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const mock = await mockAppium({
    deleteFailure: true,
    afterSession: () => {
      timer = setTimeout(() => controller.abort(reason), 50);
    },
  });
  try {
    await assert.rejects(
      startNativeSession(
        {
          environment: { platform: 'android', serverUrl: mock.url, capabilities: {} },
          capabilities: {},
        },
        5_000,
        { signal: controller.signal },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.ok(error.cause instanceof ExplorationExecutionError);
        assert.equal(error.cause.details.category, 'runtime-error');
        assert.equal(error.cause.details.phase, 'validate');
        assert.equal(error.cause.details.actionState, 'not-started');
        assert.match(error.message, /Worker initialization failed/);
        assert.match(error.message, /cleanup also failed/i);
        assert.equal(error.errors[0], error.cause);
        const publicError = publicErrorReachableText(error);
        for (const secret of [...secrets, mock.url, 'owned-1-1'])
          assert.equal(publicError.includes(secret), false);
        return true;
      },
    );
    assert.equal(mock.deleted(), 1);
    assert.equal(mock.created(), 1);
  } finally {
    clearTimeout(timer);
    await mock.close();
  }
});

test('Native API timeout/Worker exit invalidate Sessions without replay; ordinary script errors retain reuse', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-native-recovery-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium({ readinessAdb: {} });
  class Adapter extends AppiumPlatformAdapter {
    protected override async discoverSelectionDevices() {
      return [{ id: 'MOCK_LOCAL_DEVICE', name: 'mock', kind: 'device' as const }];
    }
    protected override resolveReadiness(signal?: AbortSignal) {
      return resolveAndroidReadinessSession(this.sessionHints!, signal, mock.adb!.connect);
    }
  }
  const adapter = new Adapter({
    id: 'android',
    label: 'Android',
    platformName: 'Android',
    automationName: 'UiAutomator2',
  });
  const api = new MaatApi(new PlatformRegistry([adapter], 'android'), root, {
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
        technicalDetails: { serverScope: 'remote' },
      }),
  });
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock' },
      capabilities: { 'appium:deviceName': 'mock' },
    });
    await selectTestTarget(api);
    await api.exploration.executeJavaScript("console.log('first');");
    await assert.rejects(
      api.exploration.executeJavaScript(
        "throw new Error('Exploration execution exceeded 1ms; Exploration Worker exited; session closed');",
      ),
      /exceeded 1ms/,
    );
    assert.equal(api.platforms.status().session, 'ready');
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 0);
    await assert.rejects(
      api.exploration.executeJavaScript('await driver.getPageSource(); while (true) {}'),
      (error: unknown) => {
        assert.ok(error instanceof ExplorationExecutionError);
        assert.equal(error.details.category, 'runtime-error');
        assert.equal(error.details.phase, 'execute');
        assert.equal(error.details.actionState, 'uncertain');
        assert.match(error.message, /terminated after dispatch/);
        return true;
      },
    );
    assert.equal(api.platforms.status().session, 'idle');
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 1);
    await assert.rejects(
      api.exploration.executeJavaScript("console.log('must await readiness');"),
      /recovery-required|setup\.ready/i,
    );
    await successfulReadiness(api, await api.setup.ready());
    assert.deepEqual(await api.exploration.executeJavaScript("console.log('fresh');"), [
      { type: 'text', text: 'fresh' },
    ]);
    assert.equal(mock.created(), 2);
    assert.equal(mock.requests.filter((request) => request.endsWith('/source')).length, 2);
    await assert.rejects(
      api.exploration.executeJavaScript("Buffer.constructor('return process')().exit(23);"),
      (error: unknown) => {
        assert.ok(error instanceof ExplorationExecutionError);
        assert.equal(error.details.category, 'runtime-error');
        assert.equal(error.details.phase, 'execute');
        assert.equal(error.details.actionState, 'uncertain');
        assert.match(error.message, /terminated after dispatch/);
        return true;
      },
    );
    assert.equal(api.platforms.status().session, 'idle');
    assert.equal(mock.deleted(), 2);
    await successfulReadiness(api, await api.setup.ready());
    await api.exploration.executeJavaScript("console.log('next explicit request');");
    assert.equal(mock.created(), 3);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Native manager cancellation cleanup failure preserves the exact primary execution error', async () => {
  let entered!: () => void;
  let release!: () => void;
  const sourceEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const sourceRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = await mockAppium({
    deleteFailure: true,
    sourceBarrier: async () => {
      entered();
      await sourceRelease;
    },
  });
  const manager = new NativeManager();
  await manager.configureResolved({
    environment: { platform: 'ios', serverUrl: mock.url, capabilities: {} },
    capabilities: {},
  });
  const controller = new AbortController();
  const primary = new Error('primary execution cancelled');
  try {
    const running = manager.execute('await driver.getPageSource();', controller.signal);
    await sourceEntered;
    controller.abort(primary);
    release();
    await assert.rejects(running, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, error.errors[0]);
      assert.ok(error.errors[0] instanceof WorkerTerminatedError);
      assert.equal(((error.errors[0] as Error).cause as Error | undefined)?.cause, primary);
      assert.match(error.message, /Exploration execution aborted.*cleanup also failed/s);
      return true;
    });
    assert.equal(mock.deleted(), 1);
    assert.equal(manager.isRunning, false);
  } finally {
    release();
    await mock.close();
  }
});

test('native timeout plus remote DELETE failure blocks all lifecycle entry points without replay or retry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-native-double-failure-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const options = { deleteFailure: true, readinessAdb: {} };
  const mock = await mockAppium(options);
  class Adapter extends AppiumPlatformAdapter {
    protected override async discoverSelectionDevices() {
      return [{ id: 'MOCK_LOCAL_DEVICE', name: 'mock', kind: 'device' as const }];
    }
    protected override resolveReadiness(signal?: AbortSignal) {
      return resolveAndroidReadinessSession(this.sessionHints!, signal, mock.adb!.connect);
    }
  }
  const adapter = new Adapter({
    id: 'android',
    label: 'Android',
    platformName: 'Android',
    automationName: 'UiAutomator2',
  });
  const fallback: PlatformAdapter = {
    id: 'web',
    label: 'Web',
    codeContext: { language: 'javascript', globals: [], guidelines: [] },
    async initialize() {},
    async execute() {
      return [];
    },
    status() {
      return { id: 'web', label: 'Web', session: 'idle' };
    },
    async close() {},
  };
  const api = new MaatApi(new PlatformRegistry([adapter, fallback], 'android'), root);
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock' },
      capabilities: { 'appium:deviceName': 'mock', 'appium:appPackage': 'com.example.target' },
    });
    await selectTestTarget(api);
    let executionFailure: unknown;
    await assert.rejects(api.exploration.executeJavaScript('while (true) {}'), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.cause instanceof ExplorationExecutionError);
      assert.equal(error.cause.details.category, 'runtime-error');
      assert.equal(error.cause.details.phase, 'execute');
      assert.equal(error.cause.details.actionState, 'uncertain');
      assert.match(error.message, /terminated after dispatch/);
      assert.match(error.message, /Owned Session cleanup.*failed/i);
      executionFailure = error;
      return true;
    });
    assert.equal(api.platforms.status().session, 'idle');
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 1);
    assert.deepEqual(adapter.appTarget, { 'appium:appPackage': 'com.example.target' });
    options.deleteFailure = false;
    const requestsAfterFailure = [...mock.requests];
    const blocked = (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /ownership is uncertain|PHONE_CLOSE_UNCERTAIN/);
      return true;
    };
    await assert.rejects(api.setup.ready(), blocked);
    await assert.rejects(
      api.exploration.executeJavaScript("console.log('explicit recovery');"),
      blocked,
    );
    await assert.rejects(api.platforms.configureSession({ capabilities: {} }), blocked);
    await assert.rejects(api.platforms.select('web'), blocked);
    assert.equal(api.registry.current, adapter);
    assert.ok(executionFailure instanceof AggregateError);
    const cleanupFailure = executionFailure.errors[1];
    const firstRelease = api.mobile.releaseCurrentSession();
    const secondRelease = api.mobile.releaseCurrentSession();
    assert.equal(firstRelease, secondRelease);
    await assert.rejects(firstRelease, (error: unknown) => error === cleanupFailure);
    await assert.rejects(api.close(), (error: unknown) => error === cleanupFailure);
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 1);
    assert.deepEqual(mock.requests, requestsAfterFailure);
  } finally {
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('uncertain user release blocks ready, execute and configure without a second Session POST', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-close-uncertain-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium({ deleteFailure: true, readinessAdb: {} });
  class Adapter extends AppiumPlatformAdapter {
    protected override async discoverSelectionDevices() {
      return [{ id: 'MOCK_LOCAL_DEVICE', name: 'mock', kind: 'device' as const }];
    }
    protected override resolveReadiness(
      signal?: AbortSignal,
      identity?: Parameters<typeof resolveAndroidReadinessSession>[3],
      environment = this.sessionHints!,
    ) {
      return resolveAndroidReadinessSession(environment, signal, mock.adb!.connect, identity);
    }
  }
  const adapter = new Adapter({
    id: 'android',
    label: 'Android',
    platformName: 'Android',
    automationName: 'UiAutomator2',
  });
  const api = new MaatApi(new PlatformRegistry([adapter], 'android'), root, {
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
  });
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock' },
    });
    await selectTestTarget(api);
    await api.exploration.executeJavaScript("console.log('first dispatch');");
    assert.equal(mock.created(), 1);
    let primary: unknown;
    await assert.rejects(api.mobile.releaseCurrentSession(), (error: unknown) => {
      primary = error;
      assert.ok(error instanceof Error);
      assert.match(error.message, /Owned Session cleanup.*failed/i);
      assert.equal(error.message.includes(mock.url), false);
      assert.equal(error.message.includes('owned-1-1'), false);
      assert.notEqual((error as Error & { code?: string }).code, 'phone-close-uncertain');
      return true;
    });
    assert.equal(adapter.runtime.hasUncertainOwnedSession, true);
    assert.equal(adapter.runtime.isRunning, false);
    assert.deepEqual(deviceLockReleaseCallCountsForTests(), { unlock: 0, close: 0 });
    assert.deepEqual(await deviceLockChild('MOCK_LOCAL_DEVICE'), {
      status: 'error',
      name: 'MobileBusyError',
      code: 'mobile-busy',
      message: 'Another mobile operation is already in progress.',
    });
    const requestsAfterClose = mock.requests.length;
    const blocked = (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, 'phone-close-uncertain');
      assert.notEqual(error, primary);
      return true;
    };
    await assert.rejects(api.setup.ready(), blocked);
    await assert.rejects(adapter.selectReadinessTarget(), blocked);
    await assert.rejects(
      api.exploration.executeJavaScript("console.log('must not dispatch');"),
      blocked,
    );
    await assert.rejects(api.platforms.configureSession({ device: { name: 'other' } }), blocked);
    await assert.rejects(api.mobile.releaseCurrentSession(), (error: unknown) => {
      assert.equal(error, primary);
      return true;
    });
    assert.equal('execute' in adapter.runtime, false);
    assert.equal('executeLeased' in adapter.runtime, false);
    assert.equal(adapter.runtime.hasUncertainOwnedSession, true);
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 1);
    assert.equal(mock.requests.length, requestsAfterClose);
  } finally {
    await mock.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await rm(root, { recursive: true, force: true });
  }
});

test('released lock with handle close failure forgets the target without retrying unlock', async () => {
  class CloseFailureAdapter extends AppiumPlatformAdapter {
    protected override async discoverSelectionDevices() {
      return [{ id: 'MOCK_CLOSE_DEVICE', name: 'mock close phone', kind: 'device' as const }];
    }
  }
  const adapter = new CloseFailureAdapter({
    id: 'android',
    label: 'Android',
    platformName: 'Android',
    automationName: 'UiAutomator2',
  });
  assert.equal((await adapter.selectReadinessTarget())?.status, 'target-selected');
  setDeviceLockCloseFailureForTests(new Error('private injected close failure'));
  await assert.rejects(adapter.close(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code?: string }).code, 'device-lock-handle-cleanup');
    assert.equal(error.message.includes('private injected'), false);
    return true;
  });
  assert.equal(adapter.isMigratedLocalPhysicalRoute(), false);
  assert.equal(adapter.hasLifecycleUncertainty(), false);
  assert.deepEqual(deviceLockReleaseCallCountsForTests(), { unlock: 1, close: 1 });
  assert.deepEqual(await deviceLockChild('MOCK_CLOSE_DEVICE'), { status: 'acquired' });
  await adapter.close();
  assert.deepEqual(deviceLockReleaseCallCountsForTests(), { unlock: 1, close: 1 });
  await assert.rejects(adapter.execute('return 1;'), /PHONE_TARGET_SELECTION_REQUIRED/);
});

test('device unlock failure retains the target and blocks later mobile entries', async () => {
  const result = await deviceLockChild('MOCK_UNLOCK_DEVICE', 'barrier-active');
  assert.deepEqual(result, {
    status: 'barrier-confirmed',
    behavior: 'barrier-active',
    code: 'lock-release-uncertain',
    unlock: 1,
    close: 0,
    current: 'macos',
    deviceInspections: 0,
    applicationInspections: 0,
  });
  assert.doesNotMatch(JSON.stringify(result), /MOCK_|private|path|pid|digest|[a-f0-9]{64}/i);
});

test('G3 discovery Abort propagates before lock acquisition without retaining a target', async () => {
  const controller = new AbortController();
  const primary = new Error('primary close-failure abort');
  class AbortCloseFailureAdapter extends AppiumPlatformAdapter {
    protected override async discoverSelectionDevices() {
      controller.abort(primary);
      return [{ id: 'MOCK_ABORT_CLOSE_DEVICE', name: 'mock abort phone', kind: 'device' as const }];
    }
  }
  const adapter = new AbortCloseFailureAdapter({
    id: 'android',
    label: 'Android',
    platformName: 'Android',
    automationName: 'UiAutomator2',
  });
  setDeviceLockCloseFailureForTests(new Error('private injected close failure'));
  await assert.rejects(
    adapter.selectReadinessTarget(undefined, controller.signal),
    (error: unknown) => error === primary,
  );
  assert.equal(adapter.isMigratedLocalPhysicalRoute(), false);
  assert.equal(adapter.hasLifecycleUncertainty(), false);
  assert.deepEqual(deviceLockReleaseCallCountsForTests(), { unlock: 0, close: 0 });
  assert.deepEqual(await deviceLockChild('MOCK_ABORT_CLOSE_DEVICE'), {
    status: 'acquired',
  });
  await adapter.close();
  assert.deepEqual(deviceLockReleaseCallCountsForTests(), { unlock: 0, close: 0 });
  await assert.rejects(adapter.execute('return 1;'), /PHONE_TARGET_SELECTION_REQUIRED/);
});

test('G3 discovery Abort precedes a separately proven device unlock barrier', async () => {
  const result = await deviceLockChild('MOCK_ABORT_UNLOCK_DEVICE', 'barrier-abort');
  assert.deepEqual(result, {
    status: 'barrier-confirmed',
    behavior: 'barrier-abort',
    code: 'lock-release-uncertain',
    unlock: 1,
    close: 0,
    current: 'macos',
    deviceInspections: 0,
    applicationInspections: 0,
  });
  assert.doesNotMatch(JSON.stringify(result), /MOCK_|private|path|pid|digest|[a-f0-9]{64}/i);
});

test(
  'Android ready 15-second observation budget returns a retained creation-uncertain job',
  { timeout: 50_000 },
  async () => {
    if (process.env.MAAT_CREATION_BARRIER_TEST_CHILD !== '1') {
      const { NODE_TEST_CONTEXT: _testContext, ...childEnvironment } = process.env;
      const child = spawn(
        process.execPath,
        [
          '--experimental-strip-types',
          '--test',
          '--test-name-pattern=Android ready 15-second observation budget',
          new URL(import.meta.url).pathname,
        ],
        {
          env: { ...childEnvironment, MAAT_CREATION_BARRIER_TEST_CHILD: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      const capture = (chunk: Buffer) => {
        output = `${output}${chunk.toString()}`.slice(-8_000);
      };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let watchdogExpired = false;
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          const cleanup = () => {
            if (watchdog) clearTimeout(watchdog);
            child.stdout.removeListener('data', capture);
            child.stderr.removeListener('data', capture);
          };
          child.once('error', (error) => {
            cleanup();
            reject(error);
          });
          child.once('close', (code, signal) => {
            cleanup();
            resolve({ code, signal });
          });
          watchdog = setTimeout(() => {
            watchdogExpired = true;
            child.kill('SIGTERM');
          }, 40_000);
          watchdog.unref?.();
        },
      );
      assert.equal(
        watchdogExpired,
        false,
        `isolated creation-barrier contract exceeded 40 seconds and was terminated:\n${output}`,
      );
      assert.equal(
        result.code,
        0,
        `isolated creation-barrier contract failed (${result.signal ?? 'no signal'}):\n${output}`,
      );
      assert.match(
        output,
        /MAAT_CREATION_BARRIER_CHILD_ACTIVE/,
        `isolated creation-barrier contract did not execute:\n${output}`,
      );
      return;
    }
    process.stdout.write('MAAT_CREATION_BARRIER_CHILD_ACTIVE\n');
    const root = await mkdtemp(path.join(tmpdir(), 'maat-ready-bootstrap-'));
    const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
    process.env.MAAT_SESSION_HINTS_DIR = root;
    const mock = await mockAppium({ sessionDelayMs: 15_200, readinessAdb: {} });
    const api = androidReadinessApi(root, mock.adb!.connect);
    const adapter = api.registry.current as AppiumPlatformAdapter;
    const workersBefore = workerCreations;
    try {
      await api.platforms.configureSession({
        serverUrl: mock.url,
        device: { kind: 'device', name: 'mock' },
        capabilities: { 'appium:deviceName': 'mock' },
      });
      const started = Date.now();
      const uncertain = await api.setup.ready();
      assert.ok('jobId' in uncertain);
      assert.equal(uncertain.state, 'creation-uncertain');
      assert.equal(uncertain.category, 'phone-session-creation-uncertain');
      const publicSnapshot = JSON.stringify(uncertain);
      assert.doesNotMatch(
        publicSnapshot,
        /127\.0\.0\.1|MOCK_LOCAL_DEVICE|owned-|sessionId|udid|sessionDelay|fetch failed/i,
      );
      assert.ok(Date.now() - started < 20_000);
      assert.equal(api.platforms.status().session, 'idle');
      assert.equal(mock.created(), 1);
      assert.equal(mock.sessionCapabilities[0]?.['appium:skipUnlock'], true);
      assert.equal(mock.deleted(), 0);
      assert.equal(workerCreations - workersBefore, 0);
      assert.equal(
        mock.requests.some((request) => request.endsWith('/source')),
        false,
      );
      const mobileBusy = (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'mobile-busy');
        assert.equal('jobId' in error, false);
        return true;
      };
      assert.deepEqual(
        await api.setup.ready({ jobId: uncertain.jobId, waitSeconds: 0 }),
        uncertain,
      );
      assert.deepEqual(
        await api.setup.ready({
          jobId: uncertain.jobId,
          jobAction: 'cancel',
          waitSeconds: 0,
        }),
        uncertain,
      );
      await assert.rejects(api.setup.ready(), mobileBusy);
      await assert.rejects(
        api.exploration.executeJavaScript("console.log('must not enter Worker');"),
        mobileBusy,
      );
      await assert.rejects(api.platforms.configureSession({ clearAppTarget: true }), mobileBusy);
      await assert.rejects(api.mobile.releaseCurrentSession(), mobileBusy);

      class OtherPhysicalAdapter extends AppiumPlatformAdapter {
        protected override async discoverSelectionDevices() {
          return [{ id: 'OTHER_LOCAL_PHONE', name: 'other', kind: 'device' as const }];
        }
      }
      const otherAdapter = new OtherPhysicalAdapter({
        id: 'android',
        label: 'other Android',
        platformName: 'Android',
        automationName: 'UiAutomator2',
      });
      const other = new MaatApi(new PlatformRegistry([otherAdapter], 'android'), root);
      await assert.rejects(
        other.platforms.configureSession({
          serverUrl: mock.url,
          device: { kind: 'device', name: 'other' },
        }),
        mobileBusy,
      );

      for (const definition of [
        {
          id: 'android' as const,
          label: 'remote Android',
          platformName: 'Android',
          automationName: 'UiAutomator2',
          setup: {
            serverUrl: 'https://remote-android.invalid/wd/hub',
            device: { kind: 'device' as const, name: 'remote' },
          },
        },
        {
          id: 'ios' as const,
          label: 'remote iOS',
          platformName: 'iOS',
          automationName: 'XCUITest',
          setup: {
            serverUrl: 'https://remote-ios.invalid/wd/hub',
            device: { kind: 'device' as const, name: 'remote' },
          },
        },
        {
          id: 'android' as const,
          label: 'Android emulator',
          platformName: 'Android',
          automationName: 'UiAutomator2',
          setup: {
            serverUrl: mock.url,
            device: { kind: 'emulator' as const, name: 'legacy emulator' },
          },
        },
        {
          id: 'ios' as const,
          label: 'iOS simulator',
          platformName: 'iOS',
          automationName: 'XCUITest',
          setup: {
            serverUrl: mock.url,
            device: { kind: 'simulator' as const, name: 'legacy simulator' },
          },
        },
      ]) {
        const legacyAdapter = new AppiumPlatformAdapter(definition);
        const legacy = new MaatApi(new PlatformRegistry([legacyAdapter], definition.id), root);
        await assert.rejects(legacy.platforms.configureSession(definition.setup), mobileBusy);
      }

      const web = operationApi(operationAdapter('web'));
      const macos = operationApi(operationAdapter('macos'));
      assert.deepEqual(await web.exploration.executeJavaScript('independent web'), []);
      assert.deepEqual(await macos.exploration.executeJavaScript('independent macOS'), []);
      await web.close();
      await macos.close();

      assert.equal(Reflect.ownKeys(adapter).includes('target'), false);
      assert.equal(Reflect.ownKeys(adapter).includes('lifecycleToken'), false);
      assert.equal(adapter.runtime.hasUncertainCreation, true);
      assert.equal(mock.created(), 1);
      assert.equal(mock.deleted(), 0);
      assert.equal(workerCreations - workersBefore, 0);
    } finally {
      await assert.rejects(api.close(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'mobile-busy');
        return true;
      });
      if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
      else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('native target persists stable environment and resolves changing device UUIDs', () => {
  const split = splitCapabilities({
    'appium:udid': 'old-uuid',
    'appium:bundleId': 'com.example.old',
    'appium:xcodeOrgId': 'TEAM',
    platformName: 'Mac',
    automationName: 'Mac2',
    'appium:automationName': 'Mac2',
  });
  assert.equal(split.environment['appium:udid'], undefined);
  assert.equal(split.environment.platformName, undefined);
  assert.equal(split.environment.automationName, undefined);
  assert.equal(split.environment['appium:automationName'], undefined);
  assert.equal(split.app['appium:bundleId'], 'com.example.old');
  assert.equal(split.environment['appium:xcodeOrgId'], 'TEAM');
  assert.equal(
    matchDevices([{ id: 'new-uuid', name: 'iPhone 17', kind: 'simulator' }], {
      kind: 'simulator',
      name: 'iPhone 17',
    })[0]?.id,
    'new-uuid',
  );
});

test('derived native capabilities never leak unprefixed WebDriver fields', () => {
  const result = capabilities({
    environment: { platform: 'macos', capabilities: {} },
    capabilities: { platformName: 'Mac', automationName: 'Mac2' },
  });
  assert.equal(result.platformName, 'Mac');
  assert.equal('automationName' in result, false);
  assert.equal(result['appium:automationName'], 'Mac2');
  assert.throws(
    () =>
      capabilities({
        environment: { platform: 'macos', capabilities: {} },
        capabilities: { automationName: 'XCUITest' },
      }),
    /automationName conflicts/,
  );
});

test('legacy App capability names normalize and invalid configuration is recoverable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-native-config-'));
  const adapter = new AppiumPlatformAdapter({
    id: 'macos',
    label: 'macOS',
    platformName: 'Mac',
    automationName: 'Mac2',
  });
  try {
    await adapter.configureSession({ capabilities: { bundleId: 'com.example.old' } });
    assert.deepEqual(adapter.appTarget, { 'appium:bundleId': 'com.example.old' });
    assert.deepEqual(adapter.sessionHints?.capabilities, {});
    await assert.rejects(
      adapter.configureSession({ capabilities: { unknownCapability: true } }),
      /Unsupported unprefixed Appium capabilities: unknownCapability/,
    );
    assert.deepEqual(adapter.appTarget, { 'appium:bundleId': 'com.example.old' });
    assert.deepEqual(adapter.sessionHints?.capabilities, {});
    await adapter.configureSession({
      capabilities: { 'appium:bundleId': 'com.apple.calculator' },
    });
    assert.deepEqual(adapter.appTarget, { 'appium:bundleId': 'com.apple.calculator' });
    assert.deepEqual(adapter.sessionHints?.capabilities, {});
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('iOS discovery keeps simulators listed after offline devices', () => {
  const devices = parseIosDevices(
    `== Devices ==\nPhone (26.7) (00000000-0000000000000001)\n== Devices Offline ==\nOld Phone (26.6) (00000000-0000000000000002)\n== Simulators ==\niPhone 17 Simulator (27.0) (00000000-0000-0000-0000-000000000003)`,
  );
  assert.deepEqual(
    devices.map(({ name, kind }) => ({ name, kind })),
    [
      { name: 'Phone', kind: 'device' },
      { name: 'iPhone 17', kind: 'simulator' },
    ],
  );
});

test('runtime Android App target drives lifecycle and resource-id namespace', async () => {
  const mock = await mockAppium();
  const session = await startNativeSession({
    environment: { platform: 'android', serverUrl: mock.url, capabilities: {} },
    capabilities: {},
    app: { 'appium:appPackage': 'com.microsoft.emmx.canary' },
  });
  try {
    assert.deepEqual(
      await session.execute(
        "console.log(app.id); console.log(app.resourceId('edge_ntp_scrollview'));",
      ),
      [
        { type: 'text', text: 'com.microsoft.emmx.canary' },
        { type: 'text', text: 'id=com.microsoft.emmx.canary:id/edge_ntp_scrollview' },
      ],
    );
  } finally {
    await session.close();
    await mock.close();
  }
  assert.equal(mock.sessionCapabilities[0]?.['appium:appPackage'], 'com.microsoft.emmx.canary');
  assert.equal(
    mock.requests.some((request) => request.includes('terminate_app')),
    false,
  );
  assert.equal(mock.sessionCapabilities[0]?.['appium:shouldTerminateApp'], false);
  assert.equal(mock.deleted(), 1);
});

test('macOS App target relies on Session capabilities instead of unsupported app lifecycle APIs', async () => {
  const mock = await mockAppium();
  const session = await startNativeSession({
    environment: { platform: 'macos', serverUrl: mock.url, capabilities: {} },
    capabilities: {},
    app: { 'appium:bundleId': 'com.apple.calculator' },
  });
  try {
    assert.deepEqual(await session.execute('console.log(app.id);'), [
      { type: 'text', text: 'com.apple.calculator' },
    ]);
  } finally {
    await session.close();
    await mock.close();
  }
  assert.equal(mock.sessionCapabilities[0]?.['appium:bundleId'], 'com.apple.calculator');
  assert.equal(
    mock.requests.some((request) => request.includes('activate_app')),
    false,
  );
  assert.equal(
    mock.requests.some((request) => request.includes('terminate_app')),
    false,
  );
  assert.equal(mock.deleted(), 1);
});

test('macOS screenshots use the Mac2 display extension and reject empty results', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const calls: Array<[string, unknown]> = [];
  const driver = {
    async execute(name: string, input: unknown) {
      calls.push([name, input]);
      return { '42': { id: 42, isMain: true, payload: png } };
    },
  } as never;
  assert.deepEqual(await takeAppiumScreenshot(driver, 'macos'), {
    data: png,
    mimeType: 'image/png',
  });
  assert.deepEqual(calls, [['macos: screenshots', {}]]);
  await assert.rejects(
    takeAppiumScreenshot({ execute: async () => ({}) } as never, 'macos'),
    /MACOS_SCREEN_CAPTURE_PERMISSION_REQUIRED/,
  );
});

test('WDIO worker executes TypeScript and assertions, owns only its remote session', async () => {
  const mock = await mockAppium();
  const session = await startNativeSession({
    environment: { platform: 'android', serverUrl: mock.url, capabilities: {} },
    capabilities: {},
  });
  try {
    const result = await session.execute(
      `const label: string = await driver.$('~welcome').getText(); expect(label).toBe('Welcome'); console.log(label);`,
    );
    assert.deepEqual(result, [{ type: 'text', text: 'Welcome' }]);
    const second = await session.execute(
      `await expect(driver.$('~welcome')).toBeDisplayed(); display(await driver.takeScreenshot());`,
    );
    assert.equal(second[0].type, 'image');
    assert.equal((await session.execute("await evidence.screenshot('result');"))[0].type, 'image');
    await assert.rejects(session.execute("expect('Welcome').toBe('Wrong');"), /Wrong/);
    assert.deepEqual(await session.execute("console.log(await driver.$('~welcome').getText());"), [
      { type: 'text', text: 'Welcome' },
    ]);
    assert.equal(mock.created(), 1);
  } finally {
    await session.close();
  }
  assert.equal(mock.deleted(), 1);
  assert.equal(mock.server.listening, true);
  await mock.close();
});

test('native synchronous runaway is killed and remote session deleted', async () => {
  const mock = await mockAppium();
  const session = await startNativeSession(
    {
      environment: { platform: 'android', serverUrl: mock.url, capabilities: {} },
      capabilities: {},
    },
    5000,
  );
  const abort = new AbortController();
  try {
    const executing = session.execute('while (true) {}', abort.signal);
    const timer = setTimeout(() => abort.abort(), 100);
    try {
      await assert.rejects(executing, /aborted/);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await session.close();
    await mock.close();
  }
  assert.equal(mock.deleted(), 1);
});

test('native execution enforces code/output limits and a parent deadline', async () => {
  const mock = await mockAppium();
  const session = await startNativeSession(
    { environment: { platform: 'ios', serverUrl: mock.url, capabilities: {} }, capabilities: {} },
    1500,
  );
  try {
    await assert.rejects(session.execute('x'.repeat(65537)), /64 KiB/);
    await assert.rejects(session.execute("console.log('x'.repeat(13 * 1024 * 1024))"), /12 MiB/);
    await assert.rejects(
      session.execute('await Promise.resolve(); while (true) {}'),
      /exceeded 1500ms/,
    );
  } finally {
    await session.close();
    await mock.close();
  }
  assert.equal(mock.deleted(), 1);
});

test('native API reuses its Session after execution failure and retains the external server', async () => {
  const mock = await mockAppium({ readinessAdb: {} });
  const base = await mkdtemp(path.join(tmpdir(), 'maat-native-api-'));
  const hints = await mkdtemp(path.join(tmpdir(), 'maat-native-hints-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  const projects = androidReadinessApi(base, mock.adb!.connect);
  try {
    process.env.MAAT_SESSION_HINTS_DIR = hints;
    await projects.platforms.select('android');
    const persistedCapabilityInput = {
      'appium:routingId': 'MOCK_LOCAL_DEVICE',
      'appium:canonicalKey': 'canonical-MOCK_LOCAL_DEVICE',
      'appium:discoveryId': 'private-discovery',
      'appium:candidateReference': 'private-candidate',
      'appium:selectedBy': 'single-candidate',
      'appium:consent': true,
      'appium:lifecyclePin': 'private-pin',
      'appium:sessionId': 'private-session',
      'appium:localConfigPath': '/Users/private/mobile.json',
      'sauce:options': {
        username: 'private-sauce-user',
        accessKey: 'private-sauce-key',
        build: 'safe-build',
      },
      'bstack:options': {
        userName: 'private-bstack-user',
        accessKey: 'private-bstack-key',
        projectName: 'safe-project',
      },
      'vendor:options': {
        clientSecret: 'private-client-secret',
        securityToken: 'private-security-token',
        privateKey: 'private-key',
        nested: {
          apiKey: 'private-api-key',
          authorization: 'private-authorization',
          ordinarySetting: 'safe-setting',
        },
      },
      'example:userInfoEndpoint': 'https://private-user:private-password@example.test/wd/hub',
      'example:queryEndpoint': 'https://example.test/wd/hub?accessKey=private-query-key',
      'example:apiQueryEndpoint': 'https://example.test/wd/hub?api_key=private-api-query',
      'example:accessQueryEndpoint': 'https://example.test/wd/hub?access_key=private-access-query',
      'appium:options': {
        remoteAdbHost: 'private-host',
        'appium:adbPort': 7000,
        systemPort: 8201,
        'appium:wdaLocalPort': 8101,
        udid: 'MOCK_LOCAL_DEVICE',
        serial: 'PRIVATE_SERIAL',
        deviceName: 'PRIVATE_DEVICE_ROUTE',
        sessionId: 'nested-private-session',
        discoveryId: 'nested-private-discovery',
        appPackage: 'example.nested',
        appActivity: '.Main',
        bundleId: 'example.bundle',
        automationName: 'UiAutomator2',
        xcodeOrgId: 'SAFE_TEAM',
        xcodeSigningId: 'Apple Development',
        updatedWDABundleId: 'example.wda',
      },
    };
    const originalCapabilities = structuredClone(persistedCapabilityInput);
    await projects.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock' },
      capabilities: { 'appium:deviceName': 'mock', 'appium:appPackage': 'example.welcome' },
    });
    await projects.platforms.configureSession({
      capabilities: { 'appium:newCommandTimeout': 180 },
    });
    await selectTestTarget(projects);
    assert.ok(projects.platforms.current() instanceof AppiumPlatformAdapter);
    const adapter = projects.platforms.current() as AppiumPlatformAdapter;
    assert.equal(adapter.sessionHints?.serverUrl, mock.url);
    assert.equal(adapter.sessionHints?.capabilities['appium:deviceName'], 'mock');
    const code = `await expect(driver.$('~welcome')).toHaveText('Welcome');`;
    await projects.exploration.executeJavaScript(code);
    Object.assign(adapter.sessionHints!.capabilities, structuredClone(persistedCapabilityInput));
    await assert.rejects(projects.exploration.executeJavaScript('expect(1).toBe(2);'), /2/);
    assert.equal(adapter.runtime.isRunning, true);
    assert.equal(mock.deleted(), 0);
    await projects.exploration.executeJavaScript(code);
    assert.equal(mock.created(), 1);
    assert.deepEqual(await readdir(base), []);
    assert.deepEqual(await readdir(hints), ['android.json']);
    const persistedHints = await readFile(path.join(hints, 'android.json'), 'utf8');
    assert.deepEqual(persistedCapabilityInput, originalCapabilities);
    assert.doesNotMatch(
      persistedHints,
      /MOCK_LOCAL_DEVICE|PRIVATE_SERIAL|PRIVATE_DEVICE_ROUTE|private-host|canonical|discovery|candidate|selectedBy|consent|lifecycle|sessionId|remoteAdbHost|adbPort|systemPort|wdaLocalPort|\/Users\/private|private-sauce|private-bstack|private-api-key|private-authorization|private-client-secret|private-security-token|private-key|private-user|private-password|private-query-key|private-api-query|private-access-query/,
    );
    const persisted = JSON.parse(persistedHints) as {
      capabilities: { 'appium:options': Record<string, unknown> };
    };
    assert.deepEqual(persisted.capabilities['appium:options'], {
      appPackage: 'example.nested',
      appActivity: '.Main',
      bundleId: 'example.bundle',
      automationName: 'UiAutomator2',
      xcodeOrgId: 'SAFE_TEAM',
      xcodeSigningId: 'Apple Development',
      updatedWDABundleId: 'example.wda',
    });
    assert.deepEqual((persisted.capabilities as Record<string, unknown>)['sauce:options'], {
      build: 'safe-build',
    });
    assert.deepEqual((persisted.capabilities as Record<string, unknown>)['bstack:options'], {
      projectName: 'safe-project',
    });
    assert.deepEqual((persisted.capabilities as Record<string, unknown>)['vendor:options'], {
      nested: { ordinarySetting: 'safe-setting' },
    });
    const firstRelease = projects.mobile.releaseCurrentSession();
    const secondRelease = projects.mobile.releaseCurrentSession();
    assert.equal(firstRelease, secondRelease);
    assert.deepEqual(await Promise.all([firstRelease, secondRelease]), [
      { released: true, platform: 'android' },
      { released: true, platform: 'android' },
    ]);
    assert.equal(mock.deleted(), 1);
    await projects.mobile.releaseCurrentSession();
    assert.equal(mock.deleted(), 1);
    assert.equal(adapter.runtime.isRunning, false);
    assert.equal(adapter.runtime.hasUncertainOwnedSession, false);
    assert.equal(mock.server.listening, true);
    class RestartAdapter extends AppiumPlatformAdapter {
      protected override async discoverSelectionDevices() {
        return [{ id: 'MOCK_LOCAL_DEVICE', name: 'mock', kind: 'device' as const }];
      }
    }
    const restored = new RestartAdapter({
      id: 'android',
      label: 'Android',
      platformName: 'Android',
      automationName: 'UiAutomator2',
    });
    await restored.initialize();
    assert.equal(restored.runtime.isRunning, false);
    assert.equal((await restored.selectReadinessTarget())?.status, 'target-selected');
    await restored.close();
  } finally {
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await projects.close();
    await mock.close();
    await rm(base, { recursive: true, force: true });
    await rm(hints, { recursive: true, force: true });
  }
});

function iosReadinessApi(
  root: string,
  coldCheck: () => Promise<void> = async () => {},
  devicesCheck: () => Promise<void> = async () => {},
  wdaCheck: (allowInstallation: boolean) => Promise<Record<string, unknown>> = async () => ({}),
) {
  class IosReadinessAdapter extends AppiumPlatformAdapter {
    protected override async discoverSelectionDevices() {
      return [
        {
          id: 'MOCK_IPHONE',
          name: 'mock iPhone',
          kind: 'device' as const,
          connected: true,
          paired: true,
          developerMode: 'enabled' as const,
        },
      ];
    }
    protected override resolveIosReadiness(
      signal?: AbortSignal,
      currentTarget?: ResolvedNativeSession,
      allowWdaInstallation = false,
      identity?: Parameters<typeof resolveIosReadinessSession>[5],
      environment = this.sessionHints!,
    ) {
      return resolveIosReadinessSession(
        environment,
        signal,
        {
          serverReady: async () => true,
          devices: async () => {
            await devicesCheck();
            return [
              {
                id: 'MOCK_IPHONE',
                name: 'mock iPhone',
                kind: 'device',
                connected: true,
                paired: true,
                developerMode: 'enabled',
              },
            ];
          },
          checkColdLock: () => coldCheck(),
          prepareWda: (_environment, allowed) => wdaCheck(allowed),
        },
        currentTarget,
        allowWdaInstallation,
        identity,
      );
    }
    override async selectReadinessTarget(
      selection?: Parameters<AppiumPlatformAdapter['selectReadinessTarget']>[0],
      signal?: AbortSignal,
    ) {
      const result = await super.selectReadinessTarget(selection, signal);
      return result?.status === 'target-selected'
        ? super.selectReadinessTarget(undefined, signal)
        : result;
    }
  }
  return new MaatApi(
    new PlatformRegistry(
      [
        new IosReadinessAdapter({
          id: 'ios',
          label: 'iOS',
          platformName: 'iOS',
          automationName: 'XCUITest',
        }),
      ],
      'ios',
    ),
    root,
    {
      iosDetector: async () =>
        aggregateSetup({
          platform: 'ios',
          capabilities: [
            {
              id: 'appiumServer',
              required: true,
              status: 'ready',
              messageKey: 'capability.appium.ready',
            },
          ],
        }),
    },
  );
}

test('mock iOS readiness uses the real Worker, observations and healthy Session reuse', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ios-ready-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium();
  let preflights = 0;
  const api = iosReadinessApi(root, async () => {
    preflights++;
  });
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock iPhone' },
    });
    const result = await successfulReadiness(api, await api.setup.ready({ screenshot: true }));
    assert.equal(result.platform, 'ios');
    assert.equal(result.proof.phoneUnlocked, true);
    assert.equal(result.proof.screenshotReadable, true);
    assert.ok(result.observations.some((item) => item.type === 'image'));
    assert.ok(
      result.observations.some(
        (item) => item.type === 'text' && /Application name/.test(item.text),
      ),
    );
    assert.equal(preflights, 1);
    assert.equal(mock.created(), 1);
    assert.equal(mock.sessionCapabilities[0]?.['appium:udid'], 'MOCK_IPHONE');
    assert.equal(mock.sessionCapabilities[0]?.['appium:automationName'], 'XCUITest');
    assert.equal(mock.sessionCapabilities[0]?.['appium:noReset'], true);
    assert.equal((await api.setup.ready()).platform, 'ios');
    assert.equal(preflights, 1);
    assert.equal(mock.created(), 1);
  } finally {
    await api.close();
    assert.equal(mock.deleted(), 1);
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('warm iOS readiness never reinitializes a Session closed during identity checking', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ios-warm-close-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium();
  let pause = false;
  let entered!: () => void;
  let release!: () => void;
  const checking = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api = iosReadinessApi(root, undefined, async () => {
    if (!pause) return;
    entered();
    await resumed;
  });
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock iPhone' },
    });
    await api.setup.ready();
    assert.equal(mock.created(), 1);
    const reads = mock.requests.filter((request) => /\/source|\/screenshot/.test(request)).length;
    pause = true;
    const pending = api.setup.ready();
    await checking;
    await api.registry.current.close();
    release();
    await assert.rejects(pending, /NATIVE_SESSION_CHANGED/);
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 1);
    assert.equal(
      mock.requests.filter((request) => /\/source|\/screenshot/.test(request)).length,
      reads,
    );
  } finally {
    release();
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('iOS normal connection needs no extra grant; first installation permission is transient', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ios-initialization-consent-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  let installed = false;
  const mock = await mockAppium({
    onSessionRequest: () => {
      installed = true;
    },
  });
  const api = iosReadinessApi(root, undefined, undefined, async (allowed) => {
    if (!installed && !allowed)
      throw new Error(
        'IOS_WDA_INSTALLATION_AUTHORIZATION_REQUIRED: first installation not authorized.',
      );
    return {};
  });
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock iPhone' },
    });
    await assert.rejects(api.setup.ready(), /IOS_WDA_INSTALLATION_AUTHORIZATION_REQUIRED/);
    assert.equal(mock.created(), 0);
    assert.equal(
      (await successfulReadiness(api, await api.setup.ready({ allowWdaInstallation: true }))).proof
        .phoneUnlocked,
      true,
    );
    assert.equal(mock.created(), 1);
    assert.equal(mock.sessionCapabilities[0]?.allowWdaInstallation, undefined);
    assert.doesNotMatch(
      await readFile(path.join(root, 'ios.json'), 'utf8'),
      /allowWdaInstallation/,
    );
    await api.registry.current.close();
    assert.equal(
      (await successfulReadiness(api, await api.setup.ready())).proof.phoneUnlocked,
      true,
    );
    assert.equal(mock.created(), 2);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
  const lockedRoot = await mkdtemp(path.join(tmpdir(), 'maat-ios-consent-locked-'));
  process.env.MAAT_SESSION_HINTS_DIR = lockedRoot;
  const lockedMock = await mockAppium({ isLocked: () => true });
  const lockedApi = iosReadinessApi(lockedRoot);
  try {
    await lockedApi.platforms.configureSession({
      serverUrl: lockedMock.url,
      device: { kind: 'device', name: 'mock iPhone' },
    });
    await assert.rejects(lockedApi.setup.ready(), /IOS_DEVICE_LOCKED/);
    assert.equal(lockedMock.requests.filter((request) => request.endsWith('/source')).length, 0);
  } finally {
    await lockedApi.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await lockedMock.close();
    await rm(lockedRoot, { recursive: true, force: true });
  }
});

test('explicit legacy existing-Session-only mode does not create an iOS Session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ios-existing-only-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium();
  const api = iosReadinessApi(root);
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock iPhone' },
    });
    await assert.rejects(
      api.setup.ready({ allowWdaInitialization: false }),
      /IOS_CONNECTION_INITIALIZATION_DISABLED/,
    );
    assert.equal(mock.created(), 0);
    assert.equal((await api.setup.ready()).ready, true);
    assert.equal((await api.setup.ready({ allowWdaInitialization: false })).ready, true);
    assert.equal(mock.created(), 1);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary local iOS execution with absent or name-only selectors cannot bypass cold checks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ios-implicit-selection-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium();
  try {
    for (const device of [undefined, { name: 'mock iPhone' }]) {
      for (const failure of [
        'IOS_DEVICE_LOCK_STATE_UNKNOWN',
        'IOS_WDA_INSTALLATION_AUTHORIZATION_REQUIRED',
      ]) {
        const api = iosReadinessApi(
          root,
          async () => {
            if (failure === 'IOS_DEVICE_LOCK_STATE_UNKNOWN') throw new Error(failure);
          },
          undefined,
          async () => {
            throw new Error(failure);
          },
        );
        try {
          await api.platforms.configureSession({ serverUrl: mock.url, device });
          await selectTestTarget(api);
          await assert.rejects(
            api.exploration.executeJavaScript("await driver.$('~send').click();"),
            new RegExp(failure),
          );
          assert.equal(mock.created(), 0);
          assert.equal(
            mock.requests.filter((request) => /\/element|\/source|\/screenshot/.test(request))
              .length,
            0,
          );
        } finally {
          await api.close();
        }
      }
    }
  } finally {
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('unsafe iOS connection hints fail before POST through readiness and ordinary execution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ios-unsafe-startup-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium();
  const unsafe: Record<string, unknown>[] = [
    { browserName: 'Safari' },
    ...[
      'prebuildWDA',
      'useSimpleBuildTest',
      'useXctestrunFile',
      'allowProvisioningUpdates',
      'allowProvisioningDeviceRegistration',
    ].map((key) => ({ [`appium:${key}`]: true })),
    { 'appium:prebuildWDA': 'true' },
    { 'appium:wdaBindingIP': '192.0.2.1' },
    { 'appium:initialDeeplinkUrl': 'example://start' },
    { 'appium:agentPath': '/unverified/project' },
    { 'appium:bootstrapPath': '/unverified/project' },
  ];
  try {
    for (const caps of unsafe) {
      for (const nested of [false, true]) {
        const api = iosReadinessApi(root);
        try {
          await api.platforms.configureSession({
            serverUrl: mock.url,
            device: { name: 'mock iPhone' },
            capabilities: nested
              ? {
                  'appium:options': Object.fromEntries(
                    Object.entries(caps).map(([key, value]) => [
                      key.replace(/^appium:/, ''),
                      value,
                    ]),
                  ),
                }
              : caps,
          });
          await assert.rejects(
            api.setup.ready({ allowWdaInstallation: true }),
            /IOS_READINESS_UNSUPPORTED/,
          );
          await assert.rejects(
            api.exploration.executeJavaScript("await driver.$('~send').click();"),
            /IOS_READINESS_UNSUPPORTED/,
          );
          assert.equal(mock.created(), 0);
        } finally {
          await api.close();
        }
      }
    }
    const api = iosReadinessApi(root);
    try {
      const target = { 'appium:bundleId': 'com.example.target' };
      await api.platforms.configureSession({
        serverUrl: mock.url,
        device: { name: 'mock iPhone' },
        capabilities: target,
      });
      await selectTestTarget(api);
      await assert.rejects(
        api.exploration.executeJavaScript("await driver.$('~send').click();"),
        /IOS_READINESS_BASE_SESSION_REQUIRED/,
      );
      const adapter = api.registry.current;
      assert.ok(adapter instanceof AppiumPlatformAdapter);
      assert.deepEqual(adapter.appTarget, target);
      assert.equal(mock.created(), 0);
    } finally {
      await api.close();
    }
  } finally {
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('remote iOS failure cannot route provider deviceName/options to local POST or dispatch', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ios-remote-fallback-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const api = iosReadinessApi(root);
  const adapter = api.registry.current;
  assert.ok(adapter instanceof AppiumPlatformAdapter);
  const probes: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    probes.push(url);
    return new Response('{}', { status: url.startsWith('https://remote.example/') ? 503 : 200 });
  });
  try {
    await api.platforms.configureSession({
      serverUrl: 'https://remote.example/',
      capabilities: {
        'appium:deviceName': 'mock iPhone',
        'appium:options': { udid: 'MOCK_IPHONE', prebuildWDA: true },
      },
    });
    await assert.rejects(
      api.exploration.executeJavaScript("await driver.$('~send').click();"),
      /No Appium server responded/,
    );
    assert.deepEqual(probes, ['https://remote.example/status']);
    assert.equal(adapter.runtime.isRunning, false);
  } finally {
    await api.close();
    t.mock.restoreAll();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await rm(root, { recursive: true, force: true });
  }
});

test('installation permission cannot bypass signing or inspection failures before iOS POST', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ios-startup-boundary-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium();
  let code = 'IOS_WDA_SIGNING_REQUIRED';
  const api = iosReadinessApi(root, undefined, undefined, async () => {
    throw new Error(`${code}: startup was not permitted.`);
  });
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock iPhone' },
    });
    for (code of [
      'IOS_WDA_SIGNING_REQUIRED',
      'IOS_WDA_INSPECTION_FAILED',
      'IOS_WDA_CONFIGURATION_CONFLICT',
    ]) {
      await assert.rejects(api.setup.ready({ allowWdaInstallation: true }), new RegExp(code));
      assert.equal(mock.created(), 0);
      assert.equal(
        mock.requests.filter((request) => /\/source|\/screenshot|\/element/.test(request)).length,
        0,
      );
    }
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('iOS WDA security rejection retains uncertainty, next step and redacted failure without replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ios-signature-rejection-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const privateUdid = '00008140-0011223344556677';
  const mock = await mockAppium({
    sessionFailure: `Unable to launch WebDriverAgent for --device "${privateUdid}": invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user.`,
  });
  const api = iosReadinessApi(root);
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock iPhone' },
    });
    await assert.rejects(api.setup.ready({ allowWdaInitialization: true }), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /IOS_WDA_SECURITY_REJECTED/);
      assert.match(error.message, /signature, entitlements or developer-profile trust/);
      assert.match(error.message, /if already trusted, inspect signing/);
      assert.ok(error.cause instanceof ExplorationExecutionError);
      assert.equal(error.cause.details.category, 'runtime-error');
      assert.equal(error.cause.details.actionState, 'uncertain');
      const reachable = publicErrorReachableText(error);
      for (const sensitive of [
        privateUdid,
        mock.url,
        'Unable to launch WebDriverAgent',
        'explicitly trusted by the user',
      ])
        assert.equal(reachable.includes(sensitive), false);
      return true;
    });
    assert.equal(mock.created(), 1);
    assert.equal(
      mock.requests.filter((request) => /\/source|\/screenshot/.test(request)).length,
      0,
    );
    assert.equal(api.platforms.status().session, 'idle');
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('readiness does not publish unknown prefixed error codes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ready-private-code-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium({ readinessAdb: {} });
  const api = androidReadinessApi(root, mock.adb!.connect);
  const adapter = api.registry.current as AppiumPlatformAdapter;
  const originalReadiness = adapter.executeReadiness.bind(adapter);
  try {
    await api.platforms.configureSession({ serverUrl: mock.url, capabilities: {} });
    for (const privateCode of [
      'ANDROID_PRIVATE_SERIAL_1234',
      'IOS_OWNER_TOKEN_SECRET',
      'PHONE_CANONICAL_KEY_ABC',
      'ANDROID_DEVICE_LOCKED_SUFFIX',
      'prefix ANDROID_DEVICE_LOCKED',
      'android_device_locked',
    ]) {
      adapter.executeReadiness = async () => {
        throw new Error(`${privateCode}: private routing diagnostic`);
      };
      await assert.rejects(api.setup.ready(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.cause instanceof ExplorationExecutionError);
        assert.equal(error.cause.details.category, 'runtime-error');
        assert.equal(error.cause.details.phase, 'execute');
        assert.equal(error.cause.details.actionState, 'uncertain');
        const reachable = publicErrorReachableText(error);
        assert.equal(reachable.includes(privateCode), false);
        assert.equal(reachable.includes('private routing diagnostic'), false);
        return true;
      });
    }
    for (const lookalike of [
      new Error('wrapper', {
        cause: new Error('ANDROID_DEVICE_LOCKED: nested private diagnostic'),
      }),
      new AggregateError(
        [new Error('ANDROID_DEVICE_LOCKED: aggregate private diagnostic')],
        'wrapper',
      ),
      new Error('xANDROID_DEVICE_LOCKED: embedded private diagnostic'),
    ]) {
      adapter.executeReadiness = async () => {
        throw lookalike;
      };
      await assert.rejects(api.setup.ready(), (error: unknown) => {
        const reachable = publicErrorReachableText(error);
        assert.equal(reachable.includes('ANDROID_DEVICE_LOCKED'), false);
        assert.equal(reachable.includes('private diagnostic'), false);
        return true;
      });
    }
  } finally {
    adapter.executeReadiness = originalReadiness;
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('iOS readiness stops unknown cold lock proof and cancellation before POST', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ios-ready-cold-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium();
  const api = iosReadinessApi(root, async () => {
    throw new Error('IOS_DEVICE_LOCK_STATE_UNKNOWN: current state unproved.');
  });
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock iPhone' },
    });
    await assert.rejects(api.setup.ready(), /IOS_DEVICE_LOCK_STATE_UNKNOWN/);
    assert.equal(mock.created(), 0);
    assert.equal(mock.lockQueries(), 0);
    assert.equal(api.platforms.status().session, 'idle');
    const requestsBeforeCancellation = [...mock.requests];
    const controller = new AbortController();
    controller.abort(new Error('cancelled before bootstrap'));
    await assert.rejects(api.setup.ready({ signal: controller.signal }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /readiness cancelled/i);
      assert.match(error.message, /setup\.ready/);
      assert.ok(error.cause instanceof ExplorationExecutionError);
      assert.equal(error.cause.details.category, 'runtime-error');
      assert.equal(error.cause.details.phase, 'execute');
      assert.equal(error.cause.details.actionState, 'uncertain');
      assert.equal(publicErrorReachableText(error).includes('cancelled before bootstrap'), false);
      return true;
    });
    assert.equal(mock.created(), 0);
    assert.deepEqual(mock.requests, requestsBeforeCancellation);
    assert.equal(
      mock.requests.some((request) =>
        /POST \/session|\/source|\/screenshot|\/element/.test(request),
      ),
      false,
    );
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('iOS locked and unknown live WDA queries do not read UI or replay actions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ios-ready-lock-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  let locked: unknown = true;
  const mock = await mockAppium({ isLocked: () => locked });
  const api = iosReadinessApi(root);
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock iPhone' },
    });
    await assert.rejects(api.setup.ready({ screenshot: true }), /IOS_DEVICE_LOCKED/);
    assert.equal(mock.created(), 1);
    assert.equal(
      mock.requests.filter((request) => /\/source|\/screenshot/.test(request)).length,
      0,
    );
    locked = 'unknown';
    await assert.rejects(api.setup.ready(), /IOS_DEVICE_LOCK_STATE_UNKNOWN/);
    assert.equal(mock.created(), 1);
    locked = false;
    assert.equal((await api.setup.ready()).platform, 'ios');
    locked = true;
    await assert.rejects(
      api.exploration.executeJavaScript('console.log(await driver.getPageSource());'),
      /IOS_DEVICE_LOCKED/,
    );
    assert.equal(mock.requests.filter((request) => request.endsWith('/source')).length, 1);
    assert.equal(mock.created(), 1);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('iOS readiness rejects App targets and explicit simulator routing before initialization', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ios-ready-target-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium();
  const api = iosReadinessApi(root);
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock iPhone' },
      capabilities: { 'appium:bundleId': 'com.example.target' },
    });
    await assert.rejects(api.setup.ready(), /base Session/);
    assert.equal(mock.created(), 0);
    assert.deepEqual((api.registry.current as AppiumPlatformAdapter).appTarget, {
      'appium:bundleId': 'com.example.target',
    });
    await api.registry.current.close();
    await api.platforms.configureSession({
      clearAppTarget: true,
      device: { kind: 'simulator', name: 'mock iPhone' },
    });
    await assert.rejects(api.setup.ready(), /IOS_READINESS_UNSUPPORTED/);
    assert.equal(mock.created(), 0);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('platform IDs are selected through the registry without formal platform roots', async () => {
  const projects = new MaatApi(createDefaultPlatformRegistry(), process.cwd());
  await assert.rejects(projects.platforms.select('iphone-calculator'), /Unknown platform/);
  assert.equal(projects.platforms.current().id, 'web');
  assert.deepEqual(
    projects.platforms.list().map((adapter) => adapter.id),
    ['web', 'android', 'ios', 'macos'],
  );
  for (const adapter of projects.platforms.list()) assert.equal('root' in adapter, false);
  await projects.close();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function operationAdapter(
  id: 'android' | 'ios' | 'web' | 'macos',
  hooks: Partial<{
    initialize: () => Promise<void>;
    configureSession: () => Promise<void>;
    execute: (signal?: AbortSignal) => Promise<JavaScriptObservation[]>;
    executeReadiness: () => Promise<JavaScriptObservation[]>;
    close: () => Promise<void>;
  }> = {},
): PlatformAdapter {
  return {
    id,
    label: id,
    codeContext: { language: 'javascript', globals: [], guidelines: [] },
    initialize: hooks.initialize ?? (async () => {}),
    configureSession: hooks.configureSession ?? (async () => {}),
    execute: (_code, signal) => hooks.execute?.(signal) ?? Promise.resolve([]),
    executeReadiness: hooks.executeReadiness ? () => hooks.executeReadiness!() : undefined,
    status: () => ({ id, label: id, session: 'idle' }),
    close: hooks.close ?? (async () => {}),
  };
}

function operationApi(adapter: PlatformAdapter, setupChecks?: () => void) {
  const detector = async () => {
    setupChecks?.();
    return aggregateSetup({
      platform: adapter.id,
      capabilities: [
        {
          id: 'uiInteraction',
          status: 'ready',
          required: true,
          messageKey: 'capability.interaction.ready',
        },
      ],
    });
  };
  return new MaatApi(new PlatformRegistry([adapter], adapter.id), process.cwd(), {
    detector,
    androidDetector: detector,
    iosDetector: detector,
  });
}

function assertMobileBusy(error: unknown) {
  assert.ok(error instanceof Error);
  assert.equal((error as Error & { code?: string }).code, 'mobile-busy');
  assert.doesNotMatch(error.message, /endpoint|session|device|javascript/i);
  return true;
}

test('one process-wide mobile execute blocks other instances before configure, ready, or close side effects', async () => {
  const execution = deferred<JavaScriptObservation[]>();
  let configures = 0;
  let initializes = 0;
  let setupChecks = 0;
  let closes = 0;
  const owner = operationApi(operationAdapter('android', { execute: () => execution.promise }));
  const contender = operationApi(
    operationAdapter('ios', {
      initialize: async () => {
        initializes++;
      },
      configureSession: async () => {
        configures++;
      },
      close: async () => {
        closes++;
      },
    }),
    () => {
      setupChecks++;
    },
  );

  const running = owner.exploration.executeJavaScript('owner');
  await assert.rejects(contender.platforms.configureSession({}), assertMobileBusy);
  await assert.rejects(contender.setup.ready(), assertMobileBusy);
  await assert.rejects(contender.mobile.releaseCurrentSession(), assertMobileBusy);
  await assert.rejects(contender.close(), assertMobileBusy);
  assert.deepEqual(
    { configures, initializes, setupChecks, closes },
    {
      configures: 0,
      initializes: 0,
      setupChecks: 0,
      closes: 0,
    },
  );

  let entered = false;
  const rejected = contender.exploration.executeJavaScript('no queue').then(
    () => {
      entered = true;
    },
    (error) => {
      assertMobileBusy(error);
    },
  );
  await rejected;
  execution.resolve([]);
  await running;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entered, false);
  assert.equal(closes, 0);
  await contender.platforms.configureSession({});
  assert.equal(configures, 1);
});

test('platform selection shares the mobile slot while non-mobile selection remains independent', async () => {
  const execution = deferred<JavaScriptObservation[]>();
  let webInitializes = 0;
  let iosInitializes = 0;
  const android = operationAdapter('android', { execute: () => execution.promise });
  const web = operationAdapter('web', {
    initialize: async () => {
      webInitializes++;
    },
  });
  const ios = operationAdapter('ios', {
    initialize: async () => {
      iosInitializes++;
    },
  });
  const api = new MaatApi(new PlatformRegistry([android, web, ios], 'android'), process.cwd());
  const running = api.exploration.executeJavaScript('long mobile execution');
  await assert.rejects(api.platforms.select('web'), assertMobileBusy);
  await assert.rejects(api.platforms.select('ios'), assertMobileBusy);
  assert.equal(api.registry.current, android);
  assert.deepEqual({ webInitializes, iosInitializes }, { webInitializes: 0, iosInitializes: 0 });

  let nonMobileInitializes = 0;
  const macos = operationAdapter('macos', {
    initialize: async () => {
      nonMobileInitializes++;
    },
  });
  const independent = new MaatApi(
    new PlatformRegistry([operationAdapter('web'), macos], 'web'),
    process.cwd(),
    {
      detector: async () => aggregateSetup({ platform: 'macos', capabilities: [] }),
    },
  );
  await independent.platforms.select('macos');
  await independent.platforms.select('web');
  assert.equal(nonMobileInitializes, 1);

  execution.resolve([]);
  await running;
  await api.platforms.select('web');
  await api.platforms.select('ios');
  assert.equal(api.registry.current, ios);
  assert.deepEqual({ webInitializes, iosInitializes }, { webInitializes: 1, iosInitializes: 1 });

  const release = deferred<void>();
  let releaseTargetInitializes = 0;
  const releaseAndroid = operationAdapter('android', { close: () => release.promise });
  const releaseWeb = operationAdapter('web', {
    initialize: async () => {
      releaseTargetInitializes++;
    },
  });
  const releaseApi = new MaatApi(
    new PlatformRegistry([releaseAndroid, releaseWeb], 'android'),
    process.cwd(),
  );
  const releasing = releaseApi.mobile.releaseCurrentSession();
  await assert.rejects(releaseApi.platforms.select('web'), assertMobileBusy);
  assert.equal(releaseApi.registry.current, releaseAndroid);
  assert.equal(releaseTargetInitializes, 0);
  release.resolve();
  await releasing;
  await releaseApi.platforms.select('web');
  assert.equal(releaseTargetInitializes, 1);
});

test('mobile readiness is a reverse holder and leases survive error or Abort until execution settles', async () => {
  const readiness = deferred<JavaScriptObservation[]>();
  const readyOwner = operationApi(
    operationAdapter('ios', { executeReadiness: () => readiness.promise }),
  );
  let dispatches = 0;
  const contender = operationApi(
    operationAdapter('android', {
      execute: async () => {
        dispatches++;
        return [];
      },
    }),
  );
  const runningReady = readyOwner.setup.ready();
  await assert.rejects(contender.exploration.executeJavaScript('blocked'), assertMobileBusy);
  assert.equal(dispatches, 0);
  readiness.resolve([
    {
      type: 'text',
      text: JSON.stringify({
        maatSetupReadiness: 1,
        phoneUnlocked: true,
        sessionUsable: true,
        sourceReadable: true,
        viewportReadable: true,
        source: '<App />',
        viewport: { width: 1, height: 1 },
      }),
    },
  ]);
  await runningReady;

  for (const outcome of ['error', 'abort'] as const) {
    const execution = deferred<JavaScriptObservation[]>();
    const controller = new AbortController();
    const owner = operationApi(operationAdapter('android', { execute: () => execution.promise }));
    const running = owner.exploration.executeJavaScript('owner', controller.signal);
    if (outcome === 'abort') controller.abort();
    await assert.rejects(
      contender.exploration.executeJavaScript('still blocked'),
      assertMobileBusy,
    );
    assert.equal(dispatches, 0);
    execution.reject(new Error(`${outcome} settled`));
    await assert.rejects(running, new RegExp(`${outcome} settled`));
    await contender.exploration.executeJavaScript('new explicit request');
    assert.equal(dispatches, 1);
    dispatches = 0;
  }
});

test('idle close is one mobile lease, waits for every adapter, and aggregates cleanup failures', async () => {
  const slowWeb = deferred<void>();
  const slowIos = deferred<void>();
  const first = new Error('web close failed');
  const second = new Error('ios close failed');
  let androidCloses = 0;
  const api = new MaatApi(
    new PlatformRegistry(
      [
        operationAdapter('android', {
          close: async () => {
            androidCloses++;
          },
        }),
        operationAdapter('web', {
          close: async () => {
            await slowWeb.promise;
            throw first;
          },
        }),
        operationAdapter('ios', {
          close: async () => {
            await slowIos.promise;
            throw second;
          },
        }),
      ],
      'web',
    ),
    process.cwd(),
  );
  const contender = operationApi(operationAdapter('android'));
  let selectInitializes = 0;
  const selectWeb = operationAdapter('web');
  const selectIos = operationAdapter('ios', {
    initialize: async () => {
      selectInitializes++;
    },
  });
  const selecting = new MaatApi(new PlatformRegistry([selectWeb, selectIos], 'web'), process.cwd());
  let closeSettled = false;
  const closing = api.close().finally(() => {
    closeSettled = true;
  });
  await assert.rejects(
    contender.exploration.executeJavaScript('blocked by close'),
    assertMobileBusy,
  );
  await assert.rejects(selecting.platforms.select('ios'), assertMobileBusy);
  assert.equal(selecting.registry.current, selectWeb);
  assert.equal(selectInitializes, 0);
  assert.equal(androidCloses, 1);
  slowWeb.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);
  slowIos.resolve();
  await assert.rejects(closing, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [first, second]);
    return true;
  });
  await contender.exploration.executeJavaScript('after all cleanup settled');
  await selecting.platforms.select('ios');
  assert.equal(selectInitializes, 1);

  const singleFailure = new Error('single close failure');
  const single = new PlatformRegistry([
    operationAdapter('web', {
      close: async () => {
        throw singleFailure;
      },
    }),
    operationAdapter('macos'),
  ]);
  await assert.rejects(single.close(), (error: unknown) => error === singleFailure);
});

test('web and macOS operations never participate in the mobile slot', async () => {
  const mobileExecution = deferred<JavaScriptObservation[]>();
  const mobile = operationApi(
    operationAdapter('android', { execute: () => mobileExecution.promise }),
  );
  let macExecutions = 0;
  let macCloses = 0;
  const mac = operationApi(
    operationAdapter('macos', {
      execute: async () => {
        macExecutions++;
        return [];
      },
      close: async () => {
        macCloses++;
      },
    }),
  );
  const running = mobile.exploration.executeJavaScript('owner');
  await mac.exploration.executeJavaScript('independent');
  await mac.close();
  assert.deepEqual({ macExecutions, macCloses }, { macExecutions: 1, macCloses: 1 });
  mobileExecution.resolve([]);
  await running;
});

test('macOS App-target fallback never re-dispatches JavaScript after a possible dispatch', async () => {
  const mock = await mockAppium({
    sourceFailure: () => ({ error: 'unknown error', message: 'App action failed' }),
  });
  const adapter = new AppiumPlatformAdapter({
    id: 'macos',
    label: 'macOS',
    platformName: 'Mac',
    automationName: 'Mac2',
  });
  try {
    await adapter.configureSession({
      serverUrl: mock.url,
      capabilities: {
        'appium:bundleId': 'com.example.target',
      },
    });
    await assert.rejects(adapter.execute('await driver.getPageSource();'), /App action failed/);
    assert.equal(mock.requests.filter((request) => request.endsWith('/source')).length, 1);
    assert.equal(mock.created(), 1);
    assert.deepEqual(adapter.appTarget, { 'appium:bundleId': 'com.example.target' });
  } finally {
    await adapter.close();
    await mock.close();
  }
});

test('pinned lifecycle rejects endpoint replacement without exposing or dispatching the old lease', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-native-lease-mismatch-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium({ readinessAdb: {} });
  const api = androidReadinessApi(root, mock.adb!.connect);
  const adapter = api.registry.current as AppiumPlatformAdapter;
  try {
    await api.platforms.configureSession({ serverUrl: mock.url, capabilities: {} });
    await successfulReadiness(api, await api.setup.ready());
    const beforeMismatch = [...mock.requests];
    await assert.rejects(
      api.platforms.configureSession({ serverUrl: 'http://127.0.0.1:1/' }),
      /pins its Appium endpoint/,
    );
    assert.deepEqual(mock.requests, beforeMismatch);
    assert.equal(Reflect.ownKeys(adapter).includes('target'), false);
    assert.equal(Reflect.ownKeys(adapter).includes('lifecycleToken'), false);
    assert.equal('leaseContext' in adapter, false);
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 0);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('release revokes the native lease and same-target selection creates a new Worker generation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-native-lease-release-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium({ readinessAdb: {} });
  const api = androidReadinessApi(root, mock.adb!.connect);
  const adapter = api.registry.current as AppiumPlatformAdapter;
  const workersBefore = workerCreations;
  try {
    await api.platforms.configureSession({ serverUrl: mock.url, capabilities: {} });
    await successfulReadiness(api, await api.setup.ready());
    const firstGeneration = adapter.runtime.currentSessionGeneration;
    await api.exploration.executeJavaScript("console.log('same lease');");
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 0);

    await api.mobile.releaseCurrentSession();
    assert.equal(mock.deleted(), 1);
    await successfulReadiness(api, await api.setup.ready());
    assert.equal(mock.created(), 2);
    assert.equal(workerCreations - workersBefore, 2);
    assert.ok(adapter.runtime.currentSessionGeneration! > firstGeneration!);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('structured invalid Session is redacted, not replayed, and requires explicit ready recovery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-native-invalid-session-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const secrets = {
    session: 'owned-private-session-id',
    owner: 'private-owner-token',
    canonical: 'private-canonical-key',
    serial: 'PRIVATE_DEVICE_SERIAL',
    endpoint: 'https://user:password@private.example/private-path',
  };
  let failSource = false;
  const mock = await mockAppium({
    readinessAdb: {},
    sourceFailure: () =>
      failSource
        ? {
            error: 'invalid session id',
            message: `invalid route sessionId=${secrets.session} ownerToken=${secrets.owner} canonicalKey=${secrets.canonical} udid=${secrets.serial} endpoint=${secrets.endpoint}`,
            data: { sessionId: secrets.session, authorization: secrets.owner },
          }
        : undefined,
  });
  const api = androidReadinessApi(root, mock.adb!.connect);
  const adapter = api.registry.current as AppiumPlatformAdapter;
  try {
    await api.platforms.configureSession({ serverUrl: mock.url, capabilities: {} });
    await successfulReadiness(api, await api.setup.ready());
    const sourcesBefore = mock.requests.filter((request) => request.endsWith('/source')).length;
    failSource = true;
    await assert.rejects(
      api.exploration.executeJavaScript('await driver.getPageSource();'),
      (error: unknown) => {
        assert.ok(error instanceof ExplorationExecutionError);
        assert.equal(error.details.category, 'runtime-error');
        assert.equal(error.details.phase, 'execute');
        assert.equal(error.details.actionState, 'uncertain');
        assert.match(error.message, /Session.*invalid|invalid.*Session/i);
        assert.match(error.message, /setup\.ready|readiness/i);
        for (const secret of Object.values(secrets))
          assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
    assert.equal(
      mock.requests.filter((request) => request.endsWith('/source')).length,
      sourcesBefore + 1,
    );
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 1);

    const requestsAfterFailure = [...mock.requests];
    const deletesAfterFailure = mock.deleted();
    const generationAfterFailure = adapter.runtime.currentSessionGeneration;
    const forbidden = new Set([
      'target',
      'lifecycleToken',
      'leaseContext',
      'executeLeased',
      'executeExisting',
      'executeReadinessTransaction',
      'executePrepared',
      'prepare',
      'prepareAndroidExecution',
      'finishObservations',
      'configureResolved',
      'assertExecutionLease',
    ]);
    for (const surface of [
      adapter,
      Object.getPrototypeOf(adapter),
      adapter.runtime,
      Object.getPrototypeOf(adapter.runtime),
    ]) {
      for (const key of Reflect.ownKeys(surface)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(surface, key);
        assert.ok(descriptor);
        if (surface === adapter.runtime && typeof descriptor.value === 'function')
          assert.fail(`Runtime facade exposed function ${String(key)}`);
        assert.equal(
          forbidden.has(String(key)),
          false,
          `Sensitive recovery surface exposed as ${String(key)}`,
        );
      }
    }
    Object.defineProperties(adapter, {
      target: {
        value: { endpoint: 'http://127.0.0.1:1/', identity: { routingId: 'forged' } },
        configurable: true,
      },
      lifecycleToken: { value: Object.freeze({}), configurable: true },
      leaseContext: {
        value: () => ({
          endpoint: 'http://127.0.0.1:1/',
          lifecycleToken: Object.freeze({}),
        }),
        configurable: true,
      },
    });
    assert.equal('executeLeased' in adapter.runtime, false);
    assert.equal('executeExisting' in adapter.runtime, false);
    assert.equal('configureResolved' in adapter.runtime, false);
    assert.equal('assertExecutionLease' in adapter.runtime, false);
    await assert.rejects(
      api.exploration.executeJavaScript("console.log('must not auto recover');"),
      /recovery-required|setup\.ready/i,
    );
    assert.deepEqual(mock.requests, requestsAfterFailure);
    assert.equal(mock.deleted(), deletesAfterFailure);
    assert.equal(adapter.runtime.currentSessionGeneration, generationAfterFailure);
    assert.equal(mock.created(), 1);

    failSource = false;
    await successfulReadiness(api, await api.setup.ready());
    assert.equal(mock.created(), 2);
    assert.deepEqual(await api.exploration.executeJavaScript("console.log('new action');"), [
      { type: 'text', text: 'new action' },
    ]);
    assert.equal(mock.created(), 2);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery commits only after hints, proof, screenshot and final Abort checks succeed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-native-recovery-commit-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  let failSource = false;
  let failScreenshot = false;
  let sourceBarrier: (() => Promise<void>) | undefined;
  const mock = await mockAppium({
    readinessAdb: {},
    screenshotFailure: () => failScreenshot,
    sourceBarrier: () => sourceBarrier?.() ?? Promise.resolve(),
    sourceFailure: () =>
      failSource
        ? {
            error: 'invalid session id',
            message: 'transport invalidated the Session',
          }
        : undefined,
  });
  const api = androidReadinessApi(root, mock.adb!.connect);
  const adapter = api.registry.current as AppiumPlatformAdapter;
  const originalReadiness = adapter.executeReadiness.bind(adapter);
  const assertRecoveryGate = async () => {
    const requests = [...mock.requests];
    await assert.rejects(
      api.exploration.executeJavaScript("console.log('ordinary JS must remain gated');"),
      /recovery-required|setup\.ready/i,
    );
    assert.deepEqual(mock.requests, requests);
  };
  try {
    await api.platforms.configureSession({ serverUrl: mock.url, capabilities: {} });
    await successfulReadiness(api, await api.setup.ready());
    failSource = true;
    await assert.rejects(
      api.exploration.executeJavaScript('await driver.getPageSource();'),
      ExplorationExecutionError,
    );
    failSource = false;
    assert.equal(mock.deleted(), 1);
    await assertRecoveryGate();

    const blockedHints = path.join(root, 'not-a-directory');
    await writeFile(blockedHints, 'block hints mkdir');
    process.env.MAAT_SESSION_HINTS_DIR = blockedHints;
    await assert.rejects(api.setup.ready({ waitSeconds: 20 }), /readiness observation failed/i);
    process.env.MAAT_SESSION_HINTS_DIR = root;
    assert.equal(mock.deleted(), 1);
    await assertRecoveryGate();

    failScreenshot = true;
    await assert.rejects(
      api.setup.ready({ waitSeconds: 20, screenshot: true }),
      /READINESS_SCREENSHOT_FAILED/,
    );
    failScreenshot = false;
    assert.equal(mock.deleted(), 1);
    await assertRecoveryGate();

    let entered!: () => void;
    let release!: () => void;
    const afterObservation = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const allowReturn = new Promise<void>((resolve) => {
      release = resolve;
    });
    sourceBarrier = async () => {
      entered();
      await allowReturn;
    };
    const started = await api.setup.ready();
    assert.ok('jobId' in started);
    await afterObservation;
    const cancelled = api.setup.ready({
      jobId: started.jobId,
      jobAction: 'cancel',
      waitSeconds: 20,
    });
    release();
    const cancelledResult = await cancelled;
    assert.ok('state' in cancelledResult);
    assert.equal(cancelledResult.state, 'cancelled');
    sourceBarrier = undefined;
    assert.equal(mock.deleted(), 2);
    await assertRecoveryGate();

    await successfulReadiness(api, await api.setup.ready());
    adapter.executeReadiness = originalReadiness;
    assert.deepEqual(
      await api.exploration.executeJavaScript("console.log('committed recovery');"),
      [{ type: 'text', text: 'committed recovery' }],
    );
  } finally {
    adapter.executeReadiness = originalReadiness;
    process.env.MAAT_SESSION_HINTS_DIR = root;
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an arbitrary invalid Session message without structured facts does not revoke the lease', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-native-invalid-message-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  let failSource = false;
  const mock = await mockAppium({
    readinessAdb: {},
    sourceFailure: () =>
      failSource
        ? {
            error: 'unknown error',
            message: 'application text happened to contain invalid session id',
          }
        : undefined,
  });
  const api = androidReadinessApi(root, mock.adb!.connect);
  try {
    await api.platforms.configureSession({ serverUrl: mock.url, capabilities: {} });
    await successfulReadiness(api, await api.setup.ready());
    failSource = true;
    await assert.rejects(
      api.exploration.executeJavaScript('await driver.getPageSource();'),
      (error: unknown) => {
        assert.ok(error instanceof ExplorationExecutionError);
        assert.notEqual(error.details.name, 'InvalidSessionError');
        return true;
      },
    );
    failSource = false;
    assert.deepEqual(await api.exploration.executeJavaScript("console.log('still leased');"), [
      { type: 'text', text: 'still leased' },
    ]);
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 0);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('model-thrown invalid Session names, codes, data and causes cannot spoof transport provenance', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-native-invalid-spoof-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium({ readinessAdb: {} });
  const api = androidReadinessApi(root, mock.adb!.connect);
  const adapter = api.registry.current as AppiumPlatformAdapter;
  try {
    await api.platforms.configureSession({ serverUrl: mock.url, capabilities: {} });
    await successfulReadiness(api, await api.setup.ready());
    const generation = adapter.runtime.currentSessionGeneration;
    const facts = [
      'invalid session id',
      'InvalidSessionIdError',
      'NoSuchSessionError',
      'no such session',
      'no_such_session',
    ];
    const expressions = (fact: string) => [
      `({ name: ${JSON.stringify(fact)}, message: "model spoof" })`,
      `({ code: ${JSON.stringify(fact)}, message: "model spoof" })`,
      `({ data: { error: ${JSON.stringify(fact)} }, message: "model spoof" })`,
      `({ cause: { name: ${JSON.stringify(fact)} }, message: "model spoof" })`,
      `({ stack: ${JSON.stringify(fact)}, message: "model spoof" })`,
    ];
    for (const fact of facts)
      for (const expression of expressions(fact)) {
        await assert.rejects(
          api.exploration.executeJavaScript(`throw ${expression};`),
          (error: unknown) => {
            assert.ok(error instanceof ExplorationExecutionError);
            assert.notEqual(error.details.name, 'InvalidSessionError');
            assert.equal(error.details.category, 'runtime-error');
            assert.equal(error.details.phase, 'execute');
            assert.equal(error.details.actionState, 'uncertain');
            return true;
          },
        );
        assert.equal(adapter.runtime.currentSessionGeneration, generation);
        assert.equal(mock.created(), 1);
        assert.equal(mock.deleted(), 0);
      }
    await assert.rejects(
      api.exploration.executeJavaScript(
        `const error = new Error("model spoof"); error.name = "InvalidSessionError"; throw error;`,
      ),
      (error: unknown) => {
        assert.ok(error instanceof ExplorationExecutionError);
        assert.notEqual(error.details.name, 'InvalidSessionError');
        return true;
      },
    );
    for (const callbackCommand of [
      `await driver.call(async () => {
        throw {name: "NoSuchSessionError", data: {error: "invalid session id"}};
      });`,
      `await driver.waitUntil(async () => {
        throw {name: "InvalidSessionIdError", code: "no such session"};
      }, {timeout: 10, interval: 1});`,
      `await driver.call(() => ({
        then(_resolve, reject) {
          reject({name: "NoSuchSessionError", data: {error: "invalid session id"}});
        }
      }));`,
      `try {
        await driver.call(async () => { throw new Error("ordinary local rejection"); });
      } catch {
        throw {name: "InvalidSessionIdError", code: "no such session"};
      }`,
      `const forged = new Proxy({}, {
        get(_target, key) {
          if (key === "name") return "NoSuchSessionError";
          if (key === "data") return {error: "invalid session id"};
          return undefined;
        }
      });
      throw forged;`,
    ]) {
      await assert.rejects(api.exploration.executeJavaScript(callbackCommand), (error: unknown) => {
        assert.ok(error instanceof ExplorationExecutionError);
        assert.notEqual(error.details.name, 'InvalidSessionError');
        return true;
      });
      assert.equal(adapter.runtime.currentSessionGeneration, generation);
      assert.equal(mock.created(), 1);
      assert.equal(mock.deleted(), 0);
    }
    assert.deepEqual(
      await api.exploration.executeJavaScript(`
        const blocked = ["addCommand", "overwriteCommand", "__propertiesObject__"];
        if (!Object.hasOwn(driver, "getPageSource") || !Object.hasOwn(driver, "call")) {
          throw new Error("WDIO 9.32.0 command descriptor layout changed");
        }
        const exposed = (value) => blocked.some((key) =>
          value?.[key] !== undefined ||
          key in (value ?? {}) ||
          Reflect.has(value ?? {}, key) ||
          Reflect.ownKeys(value ?? {}).includes(key) ||
          Object.getOwnPropertyNames(value ?? {}).includes(key) ||
          Object.getOwnPropertyDescriptor(value ?? {}, key) !== undefined ||
          Object.getOwnPropertyDescriptors(value ?? {})[key] !== undefined
        );
        if (exposed(driver)) throw new Error("driver mutation surface exposed");
        let prototype = Reflect.getPrototypeOf(driver);
        for (let depth = 0; prototype && depth < 8; depth++) {
          if (exposed(prototype)) throw new Error("prototype mutation surface exposed");
          prototype = Reflect.getPrototypeOf(prototype);
        }
        const internal = driver.__propertiesObject__;
        if (internal !== undefined || exposed(internal)) {
          throw new Error("internal properties object exposed");
        }
        if (Reflect.defineProperty(driver, "spoofCommand", {
          value: async () => { throw { name: "NoSuchSessionError", message: "spoof" }; }
        })) throw new Error("custom command registration succeeded");
        console.log("mutation surface blocked");
      `),
      [{ type: 'text', text: 'mutation surface blocked' }],
    );
    assert.deepEqual(await api.exploration.executeJavaScript("console.log('lease reused');"), [
      { type: 'text', text: 'lease reused' },
    ]);
    assert.equal(adapter.runtime.currentSessionGeneration, generation);
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 0);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});
