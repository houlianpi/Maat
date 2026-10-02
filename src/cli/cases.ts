import { parseArgs } from "node:util";

import { parseBrowserName } from "../browser/browser-options.ts";
import { runCases, type CaseSelection } from "../cases/case-runner.ts";

try {
  const { values } = parseArgs({
    options: {
      all: { type: "boolean" },
      browser: { type: "string" },
      case: { type: "string" },
      headed: { type: "boolean" },
      root: { type: "string", default: "cua-tests" },
      suite: { type: "string" },
      tag: { type: "string" },
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

  process.exitCode = await runCases({
    rootDirectory: values.root,
    selection,
    ...(values.browser ? { browser: parseBrowserName(values.browser) } : {}),
    headed: values.headed,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
