import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlaywrightArgs,
  resolveCaseSpec,
} from "../src/cases/case-runner.ts";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  generatePlaywrightSpec,
  playwrightConfigSource,
} from "../src/cases/playwright-spec-generator.ts";
import type { CaseDraft } from "../src/cases/types.ts";

test("spec generator creates standard Playwright xUnit structure", () => {
  const draft: CaseDraft = {
    id: "sample-case",
    module: "sample",
    name: "Sample Case",
    description: "Sample",
    preconditions: [],
    actionSteps: [],
    objectives: [{ id: "objective-1", description: "Result is visible" }],
    tags: ["smoke"],
    suites: ["regression"],
    rootDirectory: "/tmp/tests",
    steps: [
      {
        number: 1,
        code: "await expect(page.locator('h1')).toHaveText('Done');",
        observations: [],
      },
    ],
    failures: [],
    evidence: [],
  };

  const spec = generatePlaywrightSpec(draft);
  assert.match(spec, /import \{ test, expect \} from/);
  assert.match(spec, /Case ID: sample-case/);
  assert.match(spec, /Test objectives:/);
  assert.match(spec, /test\.describe\("Sample Case"/);
  assert.match(spec, /@suite:regression/);
  assert.match(spec, /test\("sample-case"/);
  assert.match(spec, /test\.step\("Recorded step 001"/);
  assert.match(playwrightConfigSource, /testMatch: "\*\*\/\*\.spec\.ts"/);
});

test("runner resolves unique short names and reports module ambiguity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "maat-case-paths-"));
  const cases = path.join(root, "cases");
  try {
    await Promise.all([
      mkdir(path.join(cases, "calculator"), { recursive: true }),
      mkdir(path.join(cases, "payments"), { recursive: true }),
    ]);
    await writeFile(
      path.join(cases, "calculator/basic.spec.ts"),
      "// calculator",
    );
    assert.equal(
      await resolveCaseSpec(root, "basic"),
      path.join(cases, "calculator/basic.spec.ts"),
    );
    assert.equal(
      await resolveCaseSpec(root, "calculator/basic"),
      path.join(cases, "calculator/basic.spec.ts"),
    );

    await writeFile(path.join(cases, "payments/basic.spec.ts"), "// payments");
    await assert.rejects(resolveCaseSpec(root, "basic"), /Ambiguous Case/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner builds Playwright config, project, and suite grep arguments", async () => {
  const args = await buildPlaywrightArgs("/tmp/maat-tests", {
    selection: { mode: "suite", value: "smoke" },
    browser: "chrome",
    headed: true,
    workers: 1,
  });
  assert.deepEqual(args.slice(0, 4), [
    "test",
    "--config",
    "/tmp/maat-tests/playwright.config.ts",
    "--project=chrome",
  ]);
  assert.ok(args.includes("--headed"));
  assert.deepEqual(args.slice(-2), ["--grep", "@suite:smoke"]);
});
