import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMaat } from '../src/api/create-maat.ts';

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
