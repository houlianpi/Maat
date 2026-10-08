import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CaseDraftManager } from '../packages/core/src/core/cases/draft-manager.ts';
import { saveCase } from '../packages/core/src/core/cases/save-case.ts';
import { runMaatTests } from '../packages/core/src/core/testing/runner.ts';

const testArtifacts = path.resolve('artifacts/test-cases');
async function createRoot() {
  await mkdir(testArtifacts, { recursive: true });
  return mkdtemp(path.join(testArtifacts, 'root-'));
}

test('Case saves intent, adapter steps and code in one Mocha spec', async () => {
  const root = await createRoot();
  const cases = new CaseDraftManager();
  try {
    const draft = cases.begin({
      id: 'Checkout Counter',
      module: 'checkout/guest',
      name: 'Checkout counter increments',
      description: 'Verify counter.',
      objectives: ['Counter displays 1'],
      tags: ['checkout'],
      suites: ['smoke'],
      rootDirectory: root,
    });
    await cases.recordSuccessfulStep(
      "await page.setContent('<span id=\"count\">1</span>'); await expect(page.locator('#count')).toHaveText('1');",
      [{ type: 'text', text: 'counter is 1' }],
      {
        adapterId: 'web',
        bindings: ['page', 'expect'],
        requirement: { adapterId: 'web', setup: { browser: 'chrome', headless: true } },
      },
    );
    const saved = await saveCase(draft, root);
    const source = await readFile(saved.testPath, 'utf8');
    assert.equal(saved.testPath, path.join(root, 'cases/checkout/guest/checkout-counter.spec.ts'));
    assert.match(source, /Case ID: checkout-counter/);
    assert.match(source, /describe\("Checkout counter increments @checkout @suite:smoke"/);
    assert.match(source, /maat\.step\("Recorded step 001", "web"/);
    assert.equal((await runMaatTests(root, { mode: 'suite', value: 'smoke' })).exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(path.resolve('artifacts/cases/checkout-counter'), { recursive: true, force: true });
  }
});

test('Case stores exploration Evidence and failed Attempts outside source', async () => {
  const root = await createRoot();
  const cases = new CaseDraftManager();
  try {
    cases.begin({
      id: 'evidence-case',
      name: 'Evidence',
      description: 'Evidence',
      objectives: ['Screenshot'],
      rootDirectory: root,
    });
    await cases.recordSuccessfulStep('display(image);', [
      { type: 'image', mimeType: 'image/png', data: Buffer.from('fake png').toString('base64') },
    ]);
    await cases.recordFailedStep('broken();', new Error('broken'));
    const evidence = cases.listEvidence()[0]!;
    assert.deepEqual(await readFile(evidence.path!), Buffer.from('fake png'));
    assert.match(
      await readFile(path.resolve('artifacts/cases/evidence-case/attempts/001.json'), 'utf8'),
      /broken/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(path.resolve('artifacts/cases/evidence-case'), { recursive: true, force: true });
  }
});

test('Case candidate steps can be listed, replaced, removed, and renumbered', async () => {
  const root = await createRoot();
  const cases = new CaseDraftManager();
  try {
    cases.begin({
      id: 'managed-steps',
      name: 'Managed steps',
      description: 'Manage candidates',
      objectives: ['Done'],
      rootDirectory: root,
    });
    await cases.recordSuccessfulStep(
      'void page;',
      [{ type: 'text', text: 'web' }],
      {
        adapterId: 'web',
        bindings: ['page'],
        requirement: { adapterId: 'web' },
      },
      'Explore web',
    );
    await cases.recordSuccessfulStep(
      'void driver;',
      [{ type: 'text', text: 'native' }],
      {
        adapterId: 'macos',
        bindings: ['driver'],
        requirement: { adapterId: 'macos' },
      },
      'Verify native',
    );
    cases.replaceStep(2, { name: 'Confirm native', code: 'void browser;' });
    assert.deepEqual(
      cases.listSteps().map(({ number, name, code }) => ({ number, name, code })),
      [
        { number: 1, name: 'Explore web', code: 'void page;' },
        { number: 2, name: 'Confirm native', code: 'void browser;' },
      ],
    );
    cases.removeStep(1);
    assert.deepEqual(
      cases.listSteps().map(({ number, name }) => ({ number, name })),
      [{ number: 1, name: 'Confirm native' }],
    );
    assert.deepEqual(cases.current?.requirements, [{ adapterId: 'macos' }]);
    assert.equal(cases.current?.evidence.length, 1);
    assert.equal(cases.current?.evidence[0]?.stepNumber, 1);
    assert.throws(() => cases.replaceStep(1, {}), /requires name and\/or code/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(path.resolve('artifacts/cases/managed-steps'), { recursive: true, force: true });
  }
});

test('clean validation failure prevents Case promotion', async () => {
  const root = await createRoot();
  const cases = new CaseDraftManager();
  try {
    const draft = cases.begin({
      id: 'failing-case',
      name: 'Failing',
      description: 'Must fail',
      objectives: ['Expected'],
      rootDirectory: root,
    });
    await cases.recordSuccessfulStep(
      "await page.setContent('<h1>Actual</h1>'); await expect(page.locator('h1')).toHaveText('Expected');",
      [],
      {
        adapterId: 'web',
        bindings: ['page', 'expect'],
        requirement: { adapterId: 'web', setup: { browser: 'chrome', headless: true } },
      },
    );
    await assert.rejects(saveCase(draft, root), /Clean validation failed/);
    await assert.rejects(readFile(path.join(root, 'cases/failing-case.spec.ts')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Case saves and reruns from an empty project without local dependencies', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'maat-empty-project-'));
  const root = path.join(workspace, 'maat-tests', 'web');
  const cases = new CaseDraftManager();
  try {
    const draft = cases.begin({
      id: 'empty-project',
      name: 'Empty project',
      description: 'Runs without project dependencies',
      objectives: ['Result is visible'],
      rootDirectory: root,
    });
    await cases.recordSuccessfulStep(
      `await page.setContent('<h1>Ready</h1>'); await expect(page.locator('h1')).toHaveText('Ready');`,
      [],
      {
        adapterId: 'web',
        bindings: ['page', 'expect'],
        requirement: { adapterId: 'web', setup: { browser: 'chromium', headless: true } },
      },
      'Verify ready',
    );
    const saved = await saveCase(draft, root);
    assert.match(await readFile(saved.testPath, 'utf8'), /@houlianpi\/maat-core\/test/);
    assert.equal(
      (
        await runMaatTests(root, { mode: 'case', value: 'empty-project' }, undefined, undefined, {
          browser: 'chromium',
          workspaceRoot: workspace,
        })
      ).exitCode,
      0,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(path.resolve('artifacts/cases/empty-project'), { recursive: true, force: true });
  }
});
