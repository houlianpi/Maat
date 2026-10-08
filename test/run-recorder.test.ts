import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { findBrowserExecutable } from '../packages/core/src/setup/browser-discovery.ts';
import { createRunRecorder } from '../packages/maat/src/agent/run-recorder.ts';

const execFileAsync = promisify(execFile);
const testArtifacts = path.resolve('artifacts/test-recordings');

async function createTestRoot(): Promise<string> {
  await mkdir(testArtifacts, { recursive: true });
  return mkdtemp(path.join(testArtifacts, 'run-'));
}

test('recorder writes steps, observations, manifest, and executable replay', async () => {
  const root = await createTestRoot();

  try {
    const recorder = await createRunRecorder('record this', root);
    await recorder.recordSuccessfulStep(
      `await page.setContent('<h1>Replay works</h1>');
await expect(page.getByRole('heading', { level: 1 })).toHaveText('Replay works');
console.log(await page.locator('h1').textContent());`,
      [{ type: 'text', text: 'Replay works' }],
    );
    await recorder.finalize('completed');

    const manifest = JSON.parse(
      await readFile(path.join(recorder.runDirectory, 'manifest.json'), 'utf8'),
    ) as { status: string; stepCount: number; prompt: string };
    assert.deepEqual(
      { status: manifest.status, stepCount: manifest.stepCount, prompt: manifest.prompt },
      { status: 'completed', stepCount: 1, prompt: 'record this' },
    );
    assert.match(
      await readFile(path.join(recorder.runDirectory, 'steps/001.js'), 'utf8'),
      /Replay works/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(recorder.runDirectory, 'observations/001.json'), 'utf8')),
      [{ type: 'text', text: 'Replay works' }],
    );

    const executablePath = await findBrowserExecutable();
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        recorder.replayPath,
        ...(executablePath ? ['--executable-path', executablePath] : []),
        '--headless',
      ],
      { cwd: process.cwd(), timeout: 15_000 },
    );
    assert.match(stdout, /\[replay\] step 001/);
    assert.match(stdout, /Replay works/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replay validates mutually exclusive browser options', async () => {
  const root = await createTestRoot();

  try {
    const recorder = await createRunRecorder('options', root);
    await recorder.finalize('completed');

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          '--experimental-strip-types',
          recorder.replayPath,
          '--browser',
          'chrome',
          '--executable-path',
          '/tmp/browser',
        ],
        { cwd: process.cwd() },
      ),
      /mutually exclusive/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('any failed step prevents replay generation', async () => {
  const root = await createTestRoot();

  try {
    const recorder = await createRunRecorder('recover after failure', root);
    await recorder.recordFailedStep('await broken();', new Error('broken'));
    await recorder.recordSuccessfulStep("console.log('recovered');", [
      { type: 'text', text: 'recovered' },
    ]);
    const replayPath = await recorder.finalize('completed');

    assert.equal(replayPath, undefined);
    await assert.rejects(readFile(recorder.replayPath, 'utf8'), /ENOENT/);
    const manifest = JSON.parse(
      await readFile(path.join(recorder.runDirectory, 'manifest.json'), 'utf8'),
    ) as {
      status: string;
      replayable: boolean;
      replay: string | null;
      failures: Array<{ error: string }>;
    };
    assert.deepEqual(
      {
        status: manifest.status,
        replayable: manifest.replayable,
        replay: manifest.replay,
        failure: manifest.failures[0]?.error,
      },
      {
        status: 'failed',
        replayable: false,
        replay: null,
        failure: 'broken',
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recorder preserves the Agent browser as the Replay default', async () => {
  const root = await createTestRoot();

  try {
    const recorder = await createRunRecorder('edge test', root, {
      browser: 'edge',
    });
    await recorder.recordSuccessfulStep("console.log('edge');", [{ type: 'text', text: 'edge' }]);
    await recorder.finalize('completed');

    const replay = await readFile(recorder.replayPath, 'utf8');
    assert.match(replay, /browser: \{ type: "string", default: "edge" \}/);
    const manifest = JSON.parse(
      await readFile(path.join(recorder.runDirectory, 'manifest.json'), 'utf8'),
    ) as { browser: string };
    assert.equal(manifest.browser, 'edge');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generated replay accepts profile arguments without persisting a path', async () => {
  const root = await createTestRoot();
  const privateProfilePath = '/private/example/edge-profile';

  try {
    const recorder = await createRunRecorder('profile test', root, {
      browser: 'edge',
    });
    await recorder.recordSuccessfulStep("console.log('profile');", [
      { type: 'text', text: 'profile' },
    ]);
    await recorder.finalize('completed');

    const replay = await readFile(recorder.replayPath, 'utf8');
    const manifest = await readFile(path.join(recorder.runDirectory, 'manifest.json'), 'utf8');
    assert.match(replay, /user-data-dir/);
    assert.match(replay, /profile-directory/);
    assert.doesNotMatch(replay, new RegExp(privateProfilePath));
    assert.doesNotMatch(manifest, new RegExp(privateProfilePath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
