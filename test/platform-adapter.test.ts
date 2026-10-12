import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlatformAdapter } from '../packages/core/src/core/platforms/contracts.ts';
import { PlatformRegistry } from '../packages/core/src/core/platforms/registry.ts';
import {
  resolveAppiumSession,
  SessionSetupError,
  type SessionResolverDependencies,
} from '../packages/core/src/platforms/appium/session-resolver.ts';

function adapter(id: string, events: string[]): PlatformAdapter {
  return {
    id,
    label: id,
    codeContext: { language: 'javascript', globals: [], guidelines: [] },
    async initialize() {
      events.push(`init:${id}`);
    },
    async execute() {
      events.push(`execute:${id}`);
      return [{ type: 'text', text: id }];
    },
    status() {
      return { id, label: id, session: 'idle' };
    },
    async close() {
      events.push(`close:${id}`);
    },
  };
}

test('PlatformRegistry switches adapters without platform conditionals', async () => {
  const events: string[] = [];
  const registry = new PlatformRegistry([adapter('web', events), adapter('future', events)]);
  await registry.select('future');
  assert.equal(registry.current.id, 'future');
  assert.deepEqual(events, ['init:future']);
  await assert.rejects(registry.select('missing'), /Unknown platform/);
});

function resolver(
  servers: string[],
  devices: SessionResolverDependencies['discoverDevices'] extends (
    ...args: never[]
  ) => Promise<infer T>
    ? T
    : never,
): SessionResolverDependencies {
  return {
    serverReady: async (url) => servers.includes(url),
    discoverDevices: async () => devices,
  };
}

test('Appium resolver falls back from stale server and stale device hints', async () => {
  const result = await resolveAppiumSession(
    {
      platform: 'ios',
      serverUrl: 'http://127.0.0.1:9999/',
      device: { kind: 'simulator', name: 'Old iPhone' },
      capabilities: {},
    },
    resolver(['http://127.0.0.1:4723/'], [{ id: 'new-id', name: 'iPhone 17', kind: 'simulator' }]),
  );
  assert.equal(result.environment.serverUrl, 'http://127.0.0.1:4723/');
  assert.equal(result.capabilities['appium:udid'], 'new-id');
  assert.equal(result.app, undefined);
  assert.equal(result.notices?.length, 2);
});

test('Appium resolver requires user selection when multiple devices remain', async () => {
  const dependencies = resolver(
    ['http://127.0.0.1:4723/'],
    [
      { id: 'one', name: 'One', kind: 'device' },
      { id: 'two', name: 'Two', kind: 'device' },
    ],
  );
  await assert.rejects(
    resolveAppiumSession({ platform: 'android', capabilities: {} }, dependencies),
    (error: unknown) => error instanceof SessionSetupError && error.code === 'multiple-devices',
  );
});

test('remote iOS deviceName and nested physical routing cannot fall back to a local server', async () => {
  const remote = 'https://remote.example/';
  const probes: string[] = [];
  const dependencies: SessionResolverDependencies = {
    serverReady: async (url) => {
      probes.push(url);
      return url === 'http://127.0.0.1:4723/';
    },
    discoverDevices: async () => {
      throw new Error('The remote endpoint must not discover or select a local phone.');
    },
  };
  const capabilities = {
    'appium:deviceName': 'iPhone',
    'appium:options': { udid: 'MOCK_IPHONE', prebuildWDA: true },
  };
  await assert.rejects(
    resolveAppiumSession({ platform: 'ios', serverUrl: remote, capabilities }, dependencies),
    (error: unknown) => error instanceof SessionSetupError && error.code === 'server-unavailable',
  );
  assert.deepEqual(probes, [remote]);
  const healthy = await resolveAppiumSession(
    { platform: 'ios', serverUrl: remote, capabilities },
    { ...dependencies, serverReady: async () => true },
  );
  assert.equal(healthy.environment.serverUrl, remote);
  assert.deepEqual(healthy.capabilities, capabilities);
});

test('platform switching routes execution without closing other adapter Sessions', async () => {
  const events: string[] = [];
  const web = adapter('web', events);
  const macos = adapter('macos', events);
  const registry = new PlatformRegistry([web, macos]);
  assert.deepEqual(await registry.current.execute('console.log("web");'), [
    { type: 'text', text: 'web' },
  ]);
  await registry.select('macos');
  assert.deepEqual(await registry.current.execute('console.log("macos");'), [
    { type: 'text', text: 'macos' },
  ]);
  await registry.select('web');
  assert.deepEqual(await registry.current.execute('console.log("web");'), [
    { type: 'text', text: 'web' },
  ]);
  assert.deepEqual(events, [
    'execute:web',
    'init:macos',
    'execute:macos',
    'init:web',
    'execute:web',
  ]);
  await registry.close();
  assert.deepEqual(events.slice(-2), ['close:web', 'close:macos']);
});

test('Appium resolution forwards cancellation to the actual readiness probe and does not fall back or discover devices', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel resolver');
  let probes = 0;
  let discoveries = 0;
  await assert.rejects(
    resolveAppiumSession(
      { platform: 'android', serverUrl: 'http://127.0.0.1:9999/', capabilities: {} },
      {
        async serverReady(_url, signal) {
          assert.equal(signal, controller.signal);
          probes++;
          controller.abort(reason);
          return false;
        },
        async discoverDevices() {
          discoveries++;
          return [];
        },
      },
      controller.signal,
    ),
    (error: unknown) => error === reason,
  );
  assert.equal(probes, 1);
  assert.equal(discoveries, 0);
});
