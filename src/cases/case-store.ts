import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BrowserManager } from "../browser/browser-manager.ts";
import { generateReplay } from "../recording/replay-generator.ts";
import type { CaseDraft, SavedCase } from "./types.ts";

type SuiteFile = { version: 1; id: string; cases: string[] };

function markdownList(items: string[]): string {
  return items.length > 0
    ? items.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "None.";
}

function renderCaseMarkdown(draft: CaseDraft): string {
  return `# ${draft.name}

${draft.description}

## Preconditions

${markdownList(draft.preconditions)}

## Action steps

${markdownList(draft.actionSteps)}

## Test objectives

${draft.objectives
  .map((objective, index) => `${index + 1}. [${objective.id}] ${objective.description}`)
  .join("\n")}
`;
}

async function updateSuite(
  suitesDirectory: string,
  suiteId: string,
  caseId: string,
): Promise<void> {
  await mkdir(suitesDirectory, { recursive: true });
  const suitePath = path.join(suitesDirectory, `${suiteId}.json`);
  let suite: SuiteFile = { version: 1, id: suiteId, cases: [] };
  try {
    suite = JSON.parse(await readFile(suitePath, "utf8")) as SuiteFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  suite.cases = [...new Set([...suite.cases, caseId])];
  await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`);
}

export async function validateAndSaveCase(
  draft: CaseDraft,
  browserManager: BrowserManager,
): Promise<{ caseDirectory: string; testPath: string }> {
  if (draft.steps.length === 0) {
    throw new Error("The Case has no successful candidate steps to save.");
  }

  await browserManager.close();
  const validation = await browserManager.createValidationSession();
  try {
    for (const step of draft.steps) await validation.execute(step.code);
  } finally {
    await validation.close();
  }

  const root = draft.rootDirectory;
  const caseDirectory = path.join(root, "cases", draft.id);
  const suitesDirectory = path.join(root, "suites");
  const testPath = path.join(caseDirectory, "test.ts");
  const configPath = path.join(root, "cua.config.json");
  await Promise.all([
    mkdir(caseDirectory, { recursive: true }),
    mkdir(suitesDirectory, { recursive: true }),
  ]);

  try {
    await readFile(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(
      configPath,
      `${JSON.stringify({ version: 1, profiles: {} }, null, 2)}\n`,
    );
  }

  const browserConfig = browserManager.currentConfig;
  const savedCase: SavedCase = {
    version: 1,
    id: draft.id,
    name: draft.name,
    description: draft.description,
    preconditions: draft.preconditions,
    actionSteps: draft.actionSteps,
    objectives: draft.objectives,
    tags: draft.tags,
    suites: draft.suites,
    browser: browserConfig.browser,
    ...(browserConfig.profile ? { profile: browserConfig.profile } : {}),
    code: "test.ts",
    savedAt: new Date().toISOString(),
  };

  await Promise.all([
    writeFile(path.join(caseDirectory, "case.md"), renderCaseMarkdown(draft)),
    writeFile(
      path.join(caseDirectory, "case.json"),
      `${JSON.stringify(savedCase, null, 2)}\n`,
    ),
    writeFile(
      testPath,
      generateReplay(draft.steps, { browser: browserConfig.browser }),
    ),
    ...draft.suites.map((suite) => updateSuite(suitesDirectory, suite, draft.id)),
  ]);

  return { caseDirectory, testPath };
}
