import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createServer as createNetServer, connect, type Socket } from 'node:net';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  startNativeSession,
  NativeInitializationCancelledError,
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
import { aggregateSetup } from '../packages/core/src/setup-assistant/model.ts';
import {
  WorkerTerminatedError,
  type JavaScriptSession,
} from '../packages/core/src/core/exploration/runtime.ts';

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
  let closed = false;
  return {
    options,
    requests,
    connect: () => connect({ host: '127.0.0.1', port: address.port }),
    close: () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      server.close();
    },
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
    statusFailure?: boolean;
    sessionFailure?: string;
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
    else if (req.url?.endsWith('/screenshot')) value = 'iVBORw0KGgo=';
    else if (req.url?.endsWith('/source')) value = '<Application name="Demo" />';
    else if (req.url?.endsWith('/window/rect')) value = { x: 0, y: 0, width: 360, height: 800 };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value }));
    if (req.url === '/session' && req.method === 'POST') options.afterSession?.();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.on('close', () => adb?.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
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
  };
}

function androidReadinessApi(root: string, connectAdb: () => Socket) {
  class ReadinessAdapter extends AppiumPlatformAdapter {
    protected override resolveReadiness(signal?: AbortSignal) {
      return resolveAndroidReadinessSession(this.sessionHints!, signal, connectAdb);
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
    const result = await api.setup.ready();
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
    assert.deepEqual(adapter.runtime.currentTarget?.environment.capabilities, hints);
    assert.equal((await api.setup.ready()).proof.phoneUnlocked, true);
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 0);
    assert.equal(mock.lockQueries(), 4);
    assert.equal(
      mock.requests.some((request) => /\/(unlock|lock|press_keycode|keyevent)$/.test(request)),
      false,
    );
    await adapter.runtime.close();
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
    mock.server.close();
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
    mock.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Android ready reuses a healthy Session with explicit unlock hints but refuses new bootstrap after idle', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-ready-healthy-session-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium({ readinessAdb: {} });
  const api = androidReadinessApi(root, mock.adb!.connect);
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      capabilities: { 'appium:deviceName': 'mock', 'appium:skipUnlock': false },
    });
    const adapter = api.registry.current as AppiumPlatformAdapter;
    // Transport stand-in for an externally initialized, already healthy Session.
    await adapter.runtime.configureResolved({
      environment: adapter.sessionHints!,
      capabilities: { 'appium:deviceName': 'mock', 'appium:skipUnlock': false },
    });
    await adapter.runtime.execute("console.log('existing mock Session');");
    assert.equal(mock.sessionCapabilities[0]?.['appium:skipUnlock'], false);
    assert.equal((await api.setup.ready()).proof.phoneUnlocked, true);
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 0);
    assert.equal(adapter.sessionHints?.capabilities['appium:skipUnlock'], false);
    assert.equal(adapter.runtime.currentTarget?.capabilities['appium:skipUnlock'], false);
    await adapter.runtime.close();
    assert.equal(api.platforms.status().session, 'idle');
    const beforeRecheck = mock.requests.length;
    await assert.rejects(api.setup.ready(), /ANDROID_READINESS_UNLOCK_UNSAFE/);
    assert.equal(mock.created(), 1);
    assert.equal(mock.lockQueries(), 3);
    assert.equal(mock.requests.length, beforeRecheck);
    assert.equal(adapter.sessionHints?.capabilities['appium:skipUnlock'], false);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    mock.server.close();
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
      await assert.rejects(
        api.setup.ready({ screenshot: true }),
        state === true
          ? /ANDROID_DEVICE_LOCKED: phone locked or screen off; unlock\/wake yourself then recheck/
          : /ANDROID_DEVICE_LOCK_STATE_UNKNOWN/,
      );
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
    mock.server.close();
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
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock' },
      capabilities: { 'appium:deviceName': 'mock' },
    });
    await assert.rejects(api.setup.ready({ screenshot: true }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /ANDROID_DEVICE_LOCK_STATE_UNKNOWN/);
      assert.match(error.message, /ELOCK_QUERY: read-only driver query failed/);
      assert.match(error.message, /unlock\/wake yourself then recheck/);
      assert.match(error.message, /serial=\[redacted\]/);
      assert.match(error.message, /token=\[redacted\]/);
      assert.match(error.message, /\[path\]/);
      assert.match(error.message, /\[endpoint\]/);
      for (const sensitive of [serial, privatePath, token, endpoint])
        assert.equal(error.message.includes(sensitive), false);
      assert.equal(error.message.includes('END_OF_OVERSIZED_REASON'), false);
      assert.equal(error.message.includes('\n'), false);
      assert.ok(
        error.message.length <= 'Android setup readiness observation failed: '.length + 1_000,
      );
      // Worker IPC guarantees visible message content, not original Error/cause identity.
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
    mock.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
    mock.adb!.close();
    mock.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cold Android ready timeout/Abort stay fail-closed before POST without replay or helper initialization', async () => {
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
    await assert.rejects(api.setup.ready(), /ANDROID_DEVICE_LOCK_STATE_UNKNOWN.*timed out/);
    assert.equal(mock.created(), 0);
    const controller = new AbortController();
    mock.adb!.options.onRequest = (request) => {
      if (request.startsWith('shell,v2,raw:')) controller.abort(new Error('cancelled preflight'));
    };
    await assert.rejects(
      api.setup.ready({ signal: controller.signal }),
      /readiness cancelled: cancelled preflight/,
    );
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
    mock.adb!.close();
    await assert.rejects(api.setup.ready(), /ANDROID_DEVICE_LOCK_STATE_UNKNOWN.*unavailable/);
    assert.equal(mock.created(), 0);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    mock.adb!.close();
    mock.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cold Android ready refuses remote/ambiguous routing; a healthy remote Session uses only its driver', async () => {
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
    }
    const remote = apis[0]!;
    const adapter = remote.registry.current as AppiumPlatformAdapter;
    await adapter.runtime.configureResolved({
      environment: {
        platform: 'android',
        serverUrl: mock.url, // Transport stand-in for the healthy remote Session.
        capabilities: { 'appium:deviceName': 'mock' },
      },
      capabilities: { 'appium:deviceName': 'mock' },
    });
    await adapter.runtime.execute("console.log('healthy remote transport mock');");
    const priorAdbReads = mock.adb!.requests.length;
    assert.equal((await remote.setup.ready()).proof.phoneUnlocked, true);
    assert.equal(mock.adb!.requests.length, priorAdbReads);
    assert.equal(mock.lockQueries(), 3);
    assert.equal(mock.created(), 1);
    await adapter.runtime.close();
    await assert.rejects(remote.setup.ready(), /ANDROID_READINESS_COLD_UNSUPPORTED/);
    assert.equal(mock.created(), 1);
    assert.equal(mock.adb!.requests.length, priorAdbReads);
  } finally {
    for (const api of apis) await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    mock.adb!.close();
    mock.server.close();
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

    await assert.rejects(api.setup.ready(), /No Appium server responded/);
    assert.deepEqual(mock.requests, ['GET /status']);
    assert.deepEqual(mock.adb!.requests, []);
    assert.equal(mock.created(), 0);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    mock.adb!.close();
    mock.server.close();
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
  const target = { 'appium:appPackage': 'com.example.target', 'appium:appActivity': '.Main' };
  const code = "await driver.$('~send').click();";
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock' },
      capabilities: target,
    });
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
    await api.platforms.configureSession({ device: { kind: 'device', name: 'requestedPhone' } });
    await assert.rejects(api.exploration.executeJavaScript(code), /no other device was selected/);
    assert.equal(mock.created(), 0);
    assert.equal(
      mock.adb!.requests.filter((item) => item.startsWith('host:transport:')).length,
      transportsBefore,
    );
    await api.platforms.configureSession({ device: { kind: 'device', name: 'mock' } });
    const readsBefore = mock.adb!.requests.length;
    await api.platforms.configureSession({ serverUrl: 'http://127.0.0.1:1/' });
    await assert.rejects(api.exploration.executeJavaScript(code), /server.*responded/i);
    assert.equal(mock.adb!.requests.length, readsBefore);
    assert.equal(mock.created(), 0);
    assert.equal(
      mock.requests.some((request) => /\/(element|click|activate_app)$/.test(request)),
      false,
    );
    await api.platforms.configureSession({ serverUrl: mock.url });
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
    mock.server.close();
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
    await assert.rejects(adapter.execute(code, controller.signal), /abort|cancel/i);
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
    mock.server.close();
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
        assert.ok(error instanceof NativeInitializationCancelledError);
        assert.match(error.message, /POST \/session may have completed remotely/);
        assert.match(error.message, /cleanup cannot be confirmed/);
        assert.equal(error.abortReason, reason);
        assert.ok(error.cause instanceof Error);
        return true;
      },
    );
    assert.ok(Date.now() - started < 2_000);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(mock.created(), 1);
    assert.equal(mock.cancelledResponses(), 1);
    assert.equal(mock.deleted(), 0); // Never delete a guessed/foreign Session ID.
    assert.equal(
      mock.requests.some((request) => request.endsWith('/source')),
      false,
    );
  } finally {
    clearTimeout(timer);
    mock.server.close();
  }
});

test('native bootstrap deadline bounds slow HTTP even without a caller AbortSignal', async () => {
  const mock = await mockAppium({ sessionDelayMs: 250 });
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
      /cleanup cannot be confirmed/,
    );
    assert.ok(Date.now() - started < 2_000);
    assert.equal(mock.created(), 1);
  } finally {
    mock.server.close();
  }
});

test('a Session result obtained before cancellation is deleted after Worker initialization abort', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled after POST result');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const mock = await mockAppium({
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
        assert.ok(error instanceof WorkerTerminatedError);
        assert.match(error.message, /initialization aborted/);
        assert.equal((error.cause as Error).cause, reason);
        return true;
      },
    );
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 1);
    assert.equal(
      mock.requests.some((request) => request.endsWith('/source')),
      false,
    );
    assert.equal(mock.server.listening, true);
  } finally {
    clearTimeout(timer);
    mock.server.close();
  }
});

test('Worker initialization and DELETE failures retain the primary error/cause and surface cleanup failure', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled Worker initialization');
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
        assert.ok(error.cause instanceof WorkerTerminatedError);
        assert.equal((error.cause.cause as Error).cause, reason);
        assert.match(error.message, /initialization aborted/);
        assert.match(error.message, /cleanup also failed:.*delete Session failed/s);
        assert.equal(error.errors[0], error.cause);
        return true;
      },
    );
    assert.equal(mock.deleted(), 1);
    assert.equal(mock.created(), 1);
  } finally {
    clearTimeout(timer);
    mock.server.close();
  }
});

test('Native API timeout/Worker exit invalidate Sessions without replay; ordinary script errors retain reuse', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-native-recovery-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const mock = await mockAppium({ readinessAdb: {} });
  class Adapter extends AppiumPlatformAdapter {
    override readonly runtime = new NativeManager(1_000);
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
  const api = new MaatApi(new PlatformRegistry([adapter], 'android'), root);
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock' },
      capabilities: { 'appium:deviceName': 'mock', 'appium:appPackage': 'com.example.target' },
    });
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
      WorkerTerminatedError,
    );
    assert.equal(api.platforms.status().session, 'idle');
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 1);
    assert.deepEqual(adapter.appTarget, { 'appium:appPackage': 'com.example.target' });
    assert.deepEqual(await api.exploration.executeJavaScript("console.log('fresh');"), [
      { type: 'text', text: 'fresh' },
    ]);
    assert.equal(mock.created(), 2);
    assert.equal(mock.requests.filter((request) => request.endsWith('/source')).length, 1);
    await assert.rejects(
      api.exploration.executeJavaScript("Buffer.constructor('return process')().exit(23);"),
      /Worker exited.*code 23/,
    );
    assert.equal(api.platforms.status().session, 'idle');
    assert.equal(mock.deleted(), 2);
    await api.exploration.executeJavaScript("console.log('next explicit request');");
    assert.equal(mock.created(), 3);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    mock.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Native manager cancellation cleanup failure preserves the exact primary execution error', async () => {
  const manager = new NativeManager();
  await manager.configureResolved({
    environment: { platform: 'ios', serverUrl: 'http://127.0.0.1:1/', capabilities: {} },
    capabilities: {},
  });
  const controller = new AbortController();
  const originalCause = new Error('original cause');
  const primary = new Error('primary execution cancelled', { cause: originalCause });
  const cleanup = new Error('owned DELETE failed');
  const session: JavaScriptSession = {
    async execute() {
      controller.abort(primary);
      throw primary;
    },
    async close() {
      throw cleanup;
    },
  };
  // Inject only an owned session at the existing lifecycle boundary.
  (manager as unknown as { session: JavaScriptSession }).session = session;
  await assert.rejects(manager.execute('void 0;', controller.signal), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, primary);
    assert.equal(primary.cause, originalCause);
    assert.deepEqual(error.errors, [primary, cleanup]);
    assert.match(error.message, /primary execution cancelled.*owned DELETE failed/s);
    return true;
  });
  assert.equal(manager.isRunning, false);
});

test('native timeout plus remote DELETE failure is visible at API level and never triggers App fallback', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-native-double-failure-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  process.env.MAAT_SESSION_HINTS_DIR = root;
  const options = { deleteFailure: true, readinessAdb: {} };
  const mock = await mockAppium(options);
  class Adapter extends AppiumPlatformAdapter {
    override readonly runtime = new NativeManager(1_000);
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
  const api = new MaatApi(new PlatformRegistry([adapter], 'android'), root);
  try {
    await api.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock' },
      capabilities: { 'appium:deviceName': 'mock', 'appium:appPackage': 'com.example.target' },
    });
    await assert.rejects(api.exploration.executeJavaScript('while (true) {}'), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.cause instanceof WorkerTerminatedError);
      assert.match(error.message, /exceeded 1000ms/);
      assert.match(error.message, /delete Session failed/);
      return true;
    });
    assert.equal(api.platforms.status().session, 'idle');
    assert.equal(mock.created(), 1);
    assert.equal(mock.deleted(), 1);
    assert.deepEqual(adapter.appTarget, { 'appium:appPackage': 'com.example.target' });
    options.deleteFailure = false;
    await api.exploration.executeJavaScript("console.log('explicit recovery');");
    assert.equal(mock.created(), 2);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    mock.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'Android ready 15-second observation budget reaches the first POST and leaves status idle on cancellation',
  { timeout: 25_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'maat-ready-bootstrap-'));
    const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
    process.env.MAAT_SESSION_HINTS_DIR = root;
    const mock = await mockAppium({ sessionDelayMs: 15_200, readinessAdb: {} });
    const api = androidReadinessApi(root, mock.adb!.connect);
    try {
      await api.platforms.configureSession({
        serverUrl: mock.url,
        device: { kind: 'device', name: 'mock' },
        capabilities: { 'appium:deviceName': 'mock' },
      });
      const started = Date.now();
      await assert.rejects(api.setup.ready(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /readiness timed out/);
        assert.ok(error.cause instanceof Error);
        assert.match(error.cause.message, /cleanup cannot be confirmed/);
        return true;
      });
      assert.ok(Date.now() - started < 20_000);
      assert.equal(api.platforms.status().session, 'idle');
      assert.equal(mock.created(), 1);
      assert.equal(mock.sessionCapabilities[0]?.['appium:skipUnlock'], true);
      assert.equal(mock.deleted(), 0);
      assert.equal(
        mock.requests.some((request) => request.endsWith('/source')),
        false,
      );
    } finally {
      await api.close();
      if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
      else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
      mock.server.close();
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
    mock.server.close();
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
    mock.server.close();
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
  mock.server.close();
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
    mock.server.close();
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
    mock.server.close();
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
    await projects.platforms.configureSession({
      serverUrl: mock.url,
      device: { kind: 'device', name: 'mock' },
      capabilities: { 'appium:deviceName': 'mock', 'appium:appPackage': 'example.welcome' },
    });
    await projects.platforms.configureSession({
      capabilities: { 'appium:newCommandTimeout': 180 },
    });
    assert.ok(projects.platforms.current() instanceof AppiumPlatformAdapter);
    const adapter = projects.platforms.current() as AppiumPlatformAdapter;
    assert.equal(adapter.sessionHints?.serverUrl, mock.url);
    assert.equal(adapter.sessionHints?.capabilities['appium:deviceName'], 'mock');
    const code = `await expect(driver.$('~welcome')).toHaveText('Welcome');`;
    await projects.exploration.executeJavaScript(code);
    await assert.rejects(projects.exploration.executeJavaScript('expect(1).toBe(2);'), /2/);
    assert.equal(adapter.runtime.isRunning, true);
    assert.equal(mock.deleted(), 0);
    await projects.exploration.executeJavaScript(code);
    assert.equal(mock.created(), 1);
    assert.deepEqual(await readdir(base), []);
    assert.deepEqual(await readdir(hints), ['android.json']);
    await projects.close();
    assert.equal(mock.deleted(), 1);
    assert.equal(adapter.runtime.isRunning, false);
    assert.equal(mock.server.listening, true);
  } finally {
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await projects.close();
    mock.server.close();
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
    protected override resolveIosReadiness(
      signal?: AbortSignal,
      currentTarget?: ResolvedNativeSession,
      allowWdaInstallation = false,
    ) {
      return resolveIosReadinessSession(
        this.sessionHints!,
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
      );
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
    const result = await api.setup.ready({ screenshot: true });
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
    mock.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('warm iOS readiness rejects mismatched nested identity, external WDA and simulator routing without UI reads', async () => {
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  for (const options of [
    { capabilities: { 'appium:options': { udid: 'OTHER_PHONE' } }, kind: 'device' as const },
    {
      capabilities: { 'appium:webDriverAgentUrl': 'http://localhost:8100' },
      kind: 'device' as const,
    },
    { capabilities: {}, kind: 'simulator' as const },
  ]) {
    const root = await mkdtemp(path.join(tmpdir(), 'maat-ios-warm-routing-'));
    process.env.MAAT_SESSION_HINTS_DIR = root;
    const mock = await mockAppium();
    const api = iosReadinessApi(root, async () => {
      throw new Error('Warm validation must not run the cold check');
    });
    try {
      await api.platforms.configureSession({
        serverUrl: mock.url,
        device: { kind: 'device', name: 'mock iPhone' },
      });
      const adapter = api.registry.current;
      assert.ok(adapter instanceof AppiumPlatformAdapter);
      assert.ok(adapter.sessionHints);
      await adapter.runtime.configureResolved({
        environment: {
          ...adapter.sessionHints,
          device: { kind: options.kind, name: 'mock iPhone' },
        },
        capabilities: {
          'appium:udid': 'MOCK_IPHONE',
          'appium:deviceName': 'mock iPhone',
          ...options.capabilities,
        },
      });
      await adapter.runtime.execute("console.log('ordinary preexisting Session');");
      assert.equal(mock.created(), 1);
      await assert.rejects(api.setup.ready({ screenshot: true }), /IOS_READINESS_UNSUPPORTED/);
      assert.equal(mock.created(), 1);
      assert.equal(
        mock.requests.filter((request) => /\/source|\/screenshot/.test(request)).length,
        0,
      );
      assert.equal(mock.deleted(), 0);
    } finally {
      await api.close();
      mock.server.close();
      await rm(root, { recursive: true, force: true });
      if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
      else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    }
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
    mock.server.close();
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
    assert.equal((await api.setup.ready({ allowWdaInstallation: true })).proof.phoneUnlocked, true);
    assert.equal(mock.created(), 1);
    assert.equal(mock.sessionCapabilities[0]?.allowWdaInstallation, undefined);
    assert.doesNotMatch(
      await readFile(path.join(root, 'ios.json'), 'utf8'),
      /allowWdaInstallation/,
    );
    await api.registry.current.close();
    assert.equal((await api.setup.ready()).proof.phoneUnlocked, true);
    assert.equal(mock.created(), 2);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    mock.server.close();
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
    lockedMock.server.close();
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
    mock.server.close();
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
    mock.server.close();
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
    mock.server.close();
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
  const configure = t.mock.method(adapter.runtime, 'configureResolved', async () => {
    throw new Error('Unexpected fallback must not create any real local Session.');
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
    assert.equal(configure.mock.calls.length, 0);
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
    mock.server.close();
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
      assert.doesNotMatch(error.message, new RegExp(privateUdid));
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
    mock.server.close();
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
    const controller = new AbortController();
    controller.abort(new Error('cancelled before bootstrap'));
    await assert.rejects(
      api.setup.ready({ signal: controller.signal }),
      /cancelled before bootstrap/,
    );
    assert.equal(mock.created(), 0);
  } finally {
    await api.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    mock.server.close();
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
    mock.server.close();
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
    mock.server.close();
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
