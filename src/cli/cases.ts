import { parseArgs } from 'node:util';

import type { CaseSelection } from '../cases/case-runner.ts';
import path from 'node:path';
import { ProjectManager } from '../projects/project-manager.ts';
import { createDefaultPlatformRegistry } from '../platforms/default-registry.ts';

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

  const project = values.project;
  const testsRoot = path.resolve(values.root);
  const projects = new ProjectManager(createDefaultPlatformRegistry(testsRoot), testsRoot);
  if (project) await projects.select(project);
  try {
    process.exitCode = await projects.run(selection, {
      browser: values.browser,
      headed: values.headed,
      adapterId: project,
    });
  } finally {
    await projects.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
