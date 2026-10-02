import { parseArgs } from "node:util";

import { parseBrowserName } from "../browser/browser-options.ts";
import { runCases, type CaseSelection } from "../cases/case-runner.ts";
import path from 'node:path';
import { access } from 'node:fs/promises';
import { platformRoot } from '../projects/layout.ts';

try {
  const { values } = parseArgs({
    options: {
      all: { type: "boolean" },
      browser: { type: "string" },
      project: { type: "string" },
      case: { type: "string" },
      headed: { type: "boolean" },
      root: { type: "string", default: "maat-tests" },
      suite: { type: "string" },
      tag: { type: "string" },
      ui: { type: "boolean" },
      workers: { type: "string" },
    },
    strict: true,
  });

  const selections = [values.case, values.suite, values.tag, values.all].filter(
    Boolean,
  );
  if (selections.length !== 1) {
    throw new Error("Choose exactly one of --case, --suite, --tag, or --all.");
  }
  const selection: CaseSelection = values.case
    ? { mode: "case", value: values.case }
    : values.suite
      ? { mode: "suite", value: values.suite }
      : values.tag
        ? { mode: "tag", value: values.tag }
        : { mode: "all" };

  const project = values.project ?? 'web';
  const rootDirectory = platformRoot(values.root, project);
  const native = await access(path.join(rootDirectory, 'wdio.conf.ts')).then(() => true, () => false);
  if (native) {
    const { runNativeProject } = await import('../native/runner.ts');
    process.exitCode = await runNativeProject(rootDirectory, selection);
  } else process.exitCode = await runCases({
    rootDirectory,
    selection,
    ...(values.browser
      ? { browser: parseBrowserName(values.browser) }
      : {}),
    headed: values.headed,
    ui: values.ui,
    ...(values.workers ? { workers: Number(values.workers) } : {}),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
