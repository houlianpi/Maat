import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlatformAdapter } from '../src/platforms/contracts.ts';
import { PlatformRegistry } from '../src/platforms/registry.ts';
import {
  resolveAppiumSession,
  SessionSetupError,
  type SessionResolverDependencies,
} from '../src/platforms/appium/session-resolver.ts';
import { renderSpec } from '../src/core/cases/spec-renderer.ts';
import { buildSpecModel } from '../src/core/cases/spec-model.ts';
import { CaseManager } from '../src/cases/case-manager.ts';

function adapter(id: string, events: string[]): PlatformAdapter {
  return {
    id,
    label: id,
    root: `/tmp/${id}`,
    codeContext: { language: 'javascript', globals: [], guidelines: [] },
    async initialize() {
      events.push(`init:${id}`);
    },
    async execute() {
      return [];
    },
    runtimeRequirement() {
      return { adapterId: id };
    },
    async createTestSession() {
      throw new Error('unused');
    },
    status() {
      return { id, label: id, root: `/tmp/${id}`, session: 'idle' };
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

test('spec metadata identifies every Adapter used by a mixed Case', () => {
  const draft = new CaseManager().begin({
    id: 'mixed',
    name: 'Mixed',
    description: 'Mixed',
    objectives: ['Done'],
  });
  draft.steps.push(
    { number: 1, adapterId: 'web', bindings: ['page'], code: 'void page;', observations: [] },
    { number: 2, adapterId: 'macos', bindings: ['driver'], code: 'void driver;', observations: [] },
  );
  assert.match(renderSpec(buildSpecModel(draft), './fixture.ts'), /@maat-adapters web macos/);
});
