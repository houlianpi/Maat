import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { BrowserManager } from "../src/browser/browser-manager.ts";
import { CaseManager } from "../src/cases/case-manager.ts";
import { runCases } from "../src/cases/case-runner.ts";
import { validateAndSaveCase } from "../src/cases/case-store.ts";

const testArtifacts = path.resolve("artifacts/test-cases");

async function createRoot(): Promise<string> {
  await mkdir(testArtifacts, { recursive: true });
  return mkdtemp(path.join(testArtifacts, "root-"));
}

test("Case saves natural language, selection metadata, and code in one spec", async () => {
  const root = await createRoot();
  const browserManager = new BrowserManager(root);
  const caseManager = new CaseManager();

  try {
    const draft = caseManager.begin({
      id: "Checkout Counter",
      module: "checkout/guest",
      name: "Checkout counter increments",
      description: "Verify the checkout counter business outcome.",
      preconditions: ["Checkout page is available"],
      actionSteps: ["Open checkout", "Click increment"],
      objectives: ["Counter displays 1"],
      tags: ["checkout", "smoke"],
      suites: ["smoke"],
      rootDirectory: root,
    });
    await caseManager.recordSuccessfulStep(
      `await page.setContent('<button>Increment</button><span id="count">0</span>');
await page.getByRole('button', { name: 'Increment' }).click();
await page.locator('#count').evaluate(element => element.textContent = '1');
await expect(page.locator('#count')).toHaveText('1');`,
      [{ type: "text", text: "counter is 1" }],
    );
    assert.equal(caseManager.listEvidence().length, 1);
    assert.equal(caseManager.listEvidence()[0]?.type, "text");
    assert.match(
      await readFile(caseManager.listEvidence()[0]!.path!, "utf8"),
      /counter is 1/,
    );

    const saved = await validateAndSaveCase(draft, browserManager);
    assert.equal(
      saved.testPath,
      path.join(root, "cases/checkout/guest/checkout-counter.spec.ts"),
    );
    const code = await readFile(saved.testPath, "utf8");

    assert.match(code, /Case ID: checkout-counter/);
    assert.match(code, /Description:/);
    assert.match(code, /Action steps:/);
    assert.match(code, /Test objectives:/);
    assert.match(code, /Counter displays 1/);
    assert.match(code, /@suite:smoke/);
    assert.match(code, /from "\.\.\/\.\.\/\.\.\/fixtures\/maat-test\.ts"/);
    assert.match(code, /test\.describe/);
    assert.match(code, /test\.step/);
    assert.match(code, /expect\(page.locator\('#count'\)\)/);
    await assert.rejects(
      readFile(path.join(saved.caseDirectory, "checkout-counter.md"), "utf8"),
      /ENOENT/,
    );
    await assert.rejects(
      readFile(path.join(saved.caseDirectory, "checkout-counter.json"), "utf8"),
      /ENOENT/,
    );

    const exitCode = await runCases({
      rootDirectory: root,
      selection: { mode: "suite", value: "smoke" },
      browser: "chrome",
    });
    assert.equal(exitCode, 0);
    assert.match(
      await readFile(path.join(root, "playwright.config.ts"), "utf8"),
      /trace: "retain-on-failure"/,
    );
    assert.match(
      await readFile(path.join(root, "fixtures/maat-test.ts"), "utf8"),
      /playwright\/test/,
    );
  } finally {
    await browserManager.close();
    await rm(root, { recursive: true, force: true });
    await rm(path.resolve("artifacts/cases/checkout-counter"), {
      recursive: true,
      force: true,
    });
  }
});

test("Case stores screenshot Evidence and failed Attempts outside source Cases", async () => {
  const root = await createRoot();
  const caseManager = new CaseManager();

  try {
    caseManager.begin({
      id: "evidence-case",
      name: "Evidence Case",
      description: "Evidence behavior",
      objectives: ["Screenshot is captured"],
      rootDirectory: root,
    });
    await caseManager.recordSuccessfulStep("display(image);", [
      {
        type: "image",
        mimeType: "image/png",
        data: Buffer.from("fake png").toString("base64"),
      },
    ]);
    await caseManager.recordFailedStep("broken();", new Error("broken"));

    const evidence = caseManager.listEvidence()[0];
    assert.equal(evidence?.type, "image");
    assert.ok(evidence?.path?.includes("artifacts/cases/evidence-case/evidence"));
    assert.deepEqual(await readFile(evidence!.path!), Buffer.from("fake png"));
    assert.match(
      await readFile(
        path.resolve("artifacts/cases/evidence-case/attempts/001.json"),
        "utf8",
      ),
      /broken/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(path.resolve("artifacts/cases/evidence-case"), {
      recursive: true,
      force: true,
    });
  }
});

test("clean validation failure prevents Case files from being saved", async () => {
  const root = await createRoot();
  const browserManager = new BrowserManager(root);
  const caseManager = new CaseManager();

  try {
    const draft = caseManager.begin({
      id: "failing-case",
      name: "Failing Case",
      description: "Must not save.",
      objectives: ["Heading is Expected"],
      rootDirectory: root,
    });
    await caseManager.recordSuccessfulStep(
      `await page.setContent('<h1>Actual</h1>');
await expect(page.locator('h1')).toHaveText('Expected');`,
      [],
    );

    await assert.rejects(
      validateAndSaveCase(draft, browserManager),
      /Expected.*Expected|expect\(locator\)/s,
    );
    await assert.rejects(
      readFile(path.join(root, "cases/failing-case/case.spec.ts"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await browserManager.close();
    await rm(root, { recursive: true, force: true });
    await rm(path.resolve("artifacts/cases/failing-case"), {
      recursive: true,
      force: true,
    });
  }
});
