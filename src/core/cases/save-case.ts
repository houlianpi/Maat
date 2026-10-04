import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CaseDraft } from '../../cases/types.ts';
import { buildSpecModel } from './spec-model.ts';
import { renderSpec } from './spec-renderer.ts';
import { runMaatTests } from '../testing/runner.ts';

export async function saveCase(draft: CaseDraft, testsRoot: string, signal?: AbortSignal) {
  if (!draft.steps.length) throw new Error('The Case has no successful steps to save.');
  const directory = path.join(testsRoot, 'cases', ...(draft.module?.split('/') ?? []));
  await mkdir(directory, { recursive: true });
  const final = path.join(directory, `${draft.id}.spec.ts`);
  const candidate = path.join(directory, `.validate-${randomUUID()}.spec.ts`);
  let fixtureImport = path
    .relative(directory, path.resolve('src/core/testing/fixture.ts'))
    .split(path.sep)
    .join('/');
  if (!fixtureImport.startsWith('.')) fixtureImport = `./${fixtureImport}`;
  await writeFile(candidate, renderSpec(buildSpecModel(draft), fixtureImport));
  try {
    await runMaatTests(testsRoot, { mode: 'all' }, signal, candidate);
    await rename(candidate, final);
  } finally {
    await unlink(candidate).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  return { caseDirectory: directory, testPath: final };
}
