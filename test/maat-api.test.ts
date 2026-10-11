import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMaat } from '../packages/core/src/api/create-maat.ts';
import { MaatApi } from '../packages/core/src/api/maat-api.ts';
import type { PlatformAdapter } from '../packages/core/src/core/platforms/contracts.ts';
import { PlatformRegistry } from '../packages/core/src/core/platforms/registry.ts';
import { aggregateSetup } from '../packages/core/src/setup-assistant/model.ts';
import { WebPlatformAdapter } from '../packages/core/src/platforms/web/web-adapter.ts';
import { findBrowserExecutable } from '../packages/core/src/setup/browser-discovery.ts';
import * as core from '../packages/core/src/index.ts';

test('Core public exports retain execution/setup but remove formal product APIs', () => {
  assert.equal(core.createMaat, createMaat);
  assert.equal(core.MaatApi, MaatApi);
  assert.equal(typeof core.detectAndroidSetup, 'function');
  assert.equal(typeof core.SetupAssistant, 'function');
  for (const removed of ['CaseDraftManager', 'saveCase', 'runMaatTests'])
    assert.equal(removed in core, false);
});

test('MaatApi owns UI execution and setup without a Case or Pi session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-api-'));
  const maat = createMaat({ workspaceRoot: root });

  try {
    assert.equal(maat.platforms.current().id, 'web');
    assert.deepEqual(
      maat.platforms.list().map((adapter) => adapter.id),
      ['web', 'android', 'ios', 'macos'],
    );
    await maat.platforms.configure({ browser: 'chrome', headless: true });
    assert.equal(maat.platforms.status().detail, 'chrome · headless');

    assert.deepEqual(Object.keys(maat.exploration).sort(), ['context', 'executeJavaScript']);
    for (const removed of ['drafts', 'cases', 'evidence', 'tests'])
      assert.equal(removed in maat, false);
    for (const adapter of maat.platforms.list()) {
      for (const removed of ['root', 'runtimeRequirement', 'createTestSession'])
        assert.equal(removed in adapter, false);
      assert.equal('root' in adapter.status(), false);
    }
    assert.ok(maat.platforms.current() instanceof WebPlatformAdapter);
    assert.equal(
      (maat.platforms.current() as WebPlatformAdapter).configRoot,
      path.join(root, 'maat-tests', 'web'),
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await maat.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Setup recheck closes only the stale macOS Session after process identity changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-api-setup-'));
  let closes = 0;
  const macos: PlatformAdapter = {
    id: 'macos',
    label: 'macOS',
    codeContext: { language: 'javascript', globals: [], guidelines: [] },
    async initialize() {},
    async execute() {
      return [];
    },
    status() {
      return { id: 'macos', label: 'macOS', session: 'ready' };
    },
    async close() {
      closes += 1;
    },
  };
  let wdaPid = 10;
  const maat = new MaatApi(new PlatformRegistry([macos], 'macos'), root, {
    preferencesFile: path.join(root, 'setup.json'),
    detector: async () =>
      aggregateSetup({
        platform: 'macos',
        fingerprint: { wdaPid, wdaStartedAt: String(wdaPid) },
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
    await maat.setup.check({ platform: 'macos' });
    assert.equal(closes, 0);
    await maat.setup.check({ platform: 'macos' });
    assert.equal(closes, 0);
    wdaPid = 11;
    await maat.setup.check({ platform: 'macos' });
    assert.equal(closes, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('setup skip and interruption retain permission recovery without Draft metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-api-skip-'));
  const maat = createMaat({
    workspaceRoot: root,
    setupAssistant: {
      preferencesFile: path.join(root, 'setup.json'),
      detector: async () =>
        aggregateSetup({
          platform: 'macos',
          fingerprint: { appiumPid: 10, appiumStartedAt: '10' },
          capabilities: [
            {
              id: 'screenCapture',
              status: 'action-required',
              required: false,
              messageKey: 'capability.screenshot.required',
            },
          ],
        }),
    },
  });
  try {
    await maat.setup.check({ platform: 'macos' });
    maat.setup.interrupt({ platform: 'macos', pendingAction: 'screenshot' });
    assert.equal(maat.setup.resume(), undefined);
    const snapshot = await maat.setup.skip('screenCapture');
    assert.equal(snapshot.capabilities[0]?.status, 'skipped');
    assert.equal(maat.setup.resume()?.pendingAction, 'screenshot');
    assert.equal(maat.setup.pendingInterruption(), undefined);
    assert.deepEqual(await readdir(root), ['setup.json']);
  } finally {
    await maat.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Web named profiles remain readable at their existing location without maintaining test roots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-api-profile-'));
  const configRoot = path.join(root, 'maat-tests', 'web');
  const configFile = path.join(configRoot, 'maat.config.json');
  const profile = JSON.stringify({
    profiles: { retained: { browser: 'chromium', userDataDir: path.join(root, 'browser-data') } },
  });
  const maat = createMaat({ workspaceRoot: root });
  try {
    await mkdir(configRoot, { recursive: true });
    await writeFile(configFile, profile);
    await maat.platforms.configure({
      profile: 'retained',
      executablePath: await findBrowserExecutable(),
      headless: true,
    });
    assert.deepEqual(
      await maat.exploration.executeJavaScript(
        "await page.setContent('<h1>Profile retained</h1>'); console.log(await page.locator('h1').textContent());",
      ),
      [{ type: 'text', text: 'Profile retained' }],
    );
    assert.equal(await readFile(configFile, 'utf8'), profile);
    assert.deepEqual(await readdir(configRoot), ['maat.config.json']);
  } finally {
    await maat.close();
    await rm(root, { recursive: true, force: true });
  }
});
