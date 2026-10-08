import { parseArgs } from 'node:util';

import type { CaseSelection } from '../core/testing/case-selection.ts';
import path from 'node:path';
import { createMaat } from '../api/create-maat.ts';

try {
  const { values } = parseArgs({
    options: {
      all: { type: 'boolean' },
      browser: { type: 'string' },
      project: { type: 'string' },
      case: { type: 'string' },
      headed: { type: 'boolean' },
      root: { type: 'string', default: 'maat-tests' },
      suite: { type: 'string' },
      tag: { type: 'string' },
      ui: { type: 'boolean' },
      workers: { type: 'string' },
    },
    strict: true,
  });

  const selections = [values.case, values.suite, values.tag, values.all].filter(Boolean);
  if (selections.length !== 1) {
    throw new Error('Choose exactly one of --case, --suite, --tag, or --all.');
  }
  const selection: CaseSelection = values.case
    ? { mode: 'case', value: values.case }
    : values.suite
      ? { mode: 'suite', value: values.suite }
      : values.tag
        ? { mode: 'tag', value: values.tag }
        : { mode: 'all' };

  const project = values.project ?? 'web';
  const testsRoot = path.resolve(values.root);
  const maat = createMaat({ workspaceRoot: process.cwd(), testsRoot });
  await maat.platforms.select(project);
  try {
    const result = await maat.tests.run(selection, {
      ...(values.browser ? { browser: values.browser } : {}),
      ...(values.headed ? { headed: values.headed } : {}),
    });
    process.exitCode = result.exitCode;
  } finally {
    await maat.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
