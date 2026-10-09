import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMaat } from '../packages/core/src/api/create-maat.ts';
import { MaatApi } from '../packages/core/src/api/maat-api.ts';
import type { PlatformAdapter } from '../packages/core/src/core/platforms/contracts.ts';
import { PlatformRegistry } from '../packages/core/src/core/platforms/registry.ts';
import { aggregateSetup } from '../packages/core/src/setup-assistant/model.ts';

test('MaatApi owns platform, Case, and lifecycle boundaries without a Pi session', async () => {
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

    const draft = maat.cases.begin({
      id: 'api-boundary',
      name: 'API boundary',
      description: 'Host-neutral Case creation',
      objectives: ['The API owns the Case draft.'],
    });
    assert.equal(draft.rootDirectory, path.join(root, 'maat-tests', 'web'));
    assert.equal(maat.cases.status().active, true);
  } finally {
    await maat.close();
  }
});

test('Setup recheck closes only the stale macOS Session after process identity changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-api-setup-'));
  let closes = 0;
  const macos: PlatformAdapter = {
    id: 'macos',
    label: 'macOS',
    root,
    codeContext: { language: 'javascript', globals: [], guidelines: [] },
    async initialize() {},
    async execute() {
      return [];
    },
    runtimeRequirement() {
      return { adapterId: 'macos' };
    },
    async createTestSession() {
      throw new Error('unused');
    },
    status() {
      return { id: 'macos', label: 'macOS', root, session: 'ready' };
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
        capabilities: [{ id: 'uiInteraction', status: 'ready', required: true, summary: 'ready' }],
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
