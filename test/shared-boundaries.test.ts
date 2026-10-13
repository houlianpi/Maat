import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as core from '../packages/core/src/index.ts';
import type { PlatformAdapter } from '../packages/core/src/core/platforms/contracts.ts';
import { PlatformRegistry } from '../packages/core/src/core/platforms/registry.ts';
import { createDefaultPlatformRegistry } from '../packages/core/src/platforms/default-registry.ts';

test('Core public API and default platform order retain shared boundaries', async () => {
  assert.equal(typeof core.createMaat, 'function');
  assert.equal(typeof core.MaatApi, 'function');
  for (const removed of ['Case', 'CaseDraftManager', 'Runner', 'saveCase', 'runMaatTests']) {
    assert.equal(removed in core, false);
  }

  const registry = createDefaultPlatformRegistry();
  assert.deepEqual(
    registry.list().map((adapter) => adapter.id),
    ['web', 'android', 'ios', 'macos'],
  );
});

function fakeAdapter(id: string, events: string[]): PlatformAdapter {
  return {
    id,
    label: id,
    codeContext: { language: 'javascript', globals: [], guidelines: [] },
    async initialize() {
      events.push(`initialize:${id}`);
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

test('PlatformRegistry routes fake adapters without deleting or implicitly closing slots', async () => {
  const events: string[] = [];
  const web = fakeAdapter('web', events);
  const android = fakeAdapter('android', events);
  const registry = new PlatformRegistry([web, android]);

  assert.deepEqual(await registry.current.execute('web operation'), [
    { type: 'text', text: 'web' },
  ]);
  await registry.select('android');
  assert.deepEqual(await registry.current.execute('android operation'), [
    { type: 'text', text: 'android' },
  ]);
  await registry.select('web');

  assert.deepEqual(registry.list(), [web, android]);
  assert.equal(registry.get('web'), web);
  assert.equal(registry.get('android'), android);
  assert.deepEqual(events, [
    'execute:web',
    'initialize:android',
    'execute:android',
    'initialize:web',
  ]);

  await registry.close();
  assert.deepEqual(events.slice(-2), ['close:web', 'close:android']);
});

type PackageManifest = {
  exports?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

async function readManifest(packageName: 'core' | 'pi' | 'maat'): Promise<PackageManifest> {
  return JSON.parse(
    await readFile(new URL(`../packages/${packageName}/package.json`, import.meta.url), 'utf8'),
  ) as PackageManifest;
}

test('package manifests retain root exports and dependency direction', async () => {
  const [coreManifest, piManifest, standaloneManifest] = await Promise.all([
    readManifest('core'),
    readManifest('pi'),
    readManifest('maat'),
  ]);

  for (const manifest of [coreManifest, piManifest, standaloneManifest]) {
    assert.equal(manifest.exports?.['.'], './dist/index.js');
  }

  const corePackages = {
    ...coreManifest.dependencies,
    ...coreManifest.peerDependencies,
  };
  assert.equal(
    Object.keys(corePackages).some((name) => name.startsWith('@earendil-works/pi-')),
    false,
  );

  const hostSdkPackages = [
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-tui',
  ];
  assert.equal(piManifest.dependencies?.['@houlianpi/maat-core'], '0.3.2');
  for (const packageName of hostSdkPackages) {
    assert.equal(packageName in (piManifest.dependencies ?? {}), false);
    assert.equal(typeof piManifest.peerDependencies?.[packageName], 'string');
  }

  assert.deepEqual(Object.keys(standaloneManifest.dependencies ?? {}).sort(), [
    '@earendil-works/pi-coding-agent',
    '@houlianpi/maat-core',
    '@houlianpi/maat-pi',
  ]);
  assert.deepEqual(standaloneManifest.peerDependencies ?? {}, {});
});
