import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveCaseSpec } from '../src/core/testing/case-selection.ts';
import { buildSpecModel } from '../src/core/cases/spec-model.ts';
import { renderSpec } from '../src/core/cases/spec-renderer.ts';
import type { CaseDraft } from '../src/core/cases/types.ts';

test('unified renderer creates one Mocha Case with adapter steps', () => {
  const draft: CaseDraft = {
    id: 'sample-case',
    module: 'sample',
    name: 'Sample Case',
    description: 'Sample',
    preconditions: [],
    actionSteps: [],
    objectives: [{ id: 'objective-1', description: 'Result is visible' }],
    tags: ['smoke'],
    suites: ['regression'],
    rootDirectory: '/tmp/tests',
    requirements: [{ adapterId: 'web', setup: { browser: 'chrome' } }],
    steps: [
      {
        number: 1,
        adapterId: 'web',
        bindings: ['page', 'expect'],
        code: "await expect(page.locator('h1')).toHaveText('Done');",
        observations: [],
      },
    ],
    failures: [],
    evidence: [],
  };
  const spec = renderSpec(buildSpecModel(draft), '../../src/hosts/test/fixture.ts');
  assert.match(spec, /import \{ describe, it \} from 'mocha'/);
  assert.match(spec, /Case ID: sample-case/);
  assert.match(spec, /@suite:regression/);
  assert.match(spec, /createMaatTest/);
  assert.match(spec, /maat\.step\("Recorded step 001", "web"/);
  assert.match(spec, /async \(\{ page, expect \}\)/);
});

test('runner resolves unique short names and reports module ambiguity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-case-paths-'));
  const cases = path.join(root, 'cases');
  try {
    await Promise.all([
      mkdir(path.join(cases, 'calculator'), { recursive: true }),
      mkdir(path.join(cases, 'payments'), { recursive: true }),
    ]);
    await writeFile(path.join(cases, 'calculator/basic.spec.ts'), '// calculator');
    assert.equal(
      await resolveCaseSpec(root, 'basic'),
      path.join(cases, 'calculator/basic.spec.ts'),
    );
    assert.equal(
      await resolveCaseSpec(root, 'calculator/basic'),
      path.join(cases, 'calculator/basic.spec.ts'),
    );
    await writeFile(path.join(cases, 'payments/basic.spec.ts'), '// payments');
    await assert.rejects(resolveCaseSpec(root, 'basic'), /Ambiguous Case/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
