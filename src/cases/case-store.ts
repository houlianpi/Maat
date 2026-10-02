import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BrowserManager } from "../browser/browser-manager.ts";
import {
  generatePlaywrightSpec,
  maatFixtureSource,
  playwrightConfigSource,
} from "./playwright-spec-generator.ts";
import type { CaseDraft } from "./types.ts";

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
  const casesDirectory = path.join(root, "cases");
  const caseDirectory = draft.module
    ? path.join(casesDirectory, ...draft.module.split("/"))
    : casesDirectory;
  const testPath = path.join(caseDirectory, `${draft.id}.spec.ts`);
  const configPath = path.join(root, "maat.config.json");
  const fixturePath = path.join(root, "fixtures", "maat-test.ts");
  const playwrightConfigPath = path.join(root, "playwright.config.ts");
  await Promise.all([
    mkdir(caseDirectory, { recursive: true }),
    mkdir(path.dirname(fixturePath), { recursive: true }),
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

  await Promise.all([
    writeFile(
      testPath,
      generatePlaywrightSpec(draft, {
        fixtureImport: path
          .relative(caseDirectory, fixturePath)
          .replaceAll(path.sep, "/")
          .replace(/^(?!\.)/, "./"),
      }),
    ),
    writeFile(fixturePath, maatFixtureSource),
    writeFile(playwrightConfigPath, playwrightConfigSource),
  ]);

  return { caseDirectory, testPath };
}
