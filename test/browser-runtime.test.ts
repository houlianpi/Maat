import assert from "node:assert/strict";
import test from "node:test";

import { findBrowserExecutable } from "../src/browser/browser-executable.ts";
import { BrowserRuntime } from "../src/browser/browser-runtime.ts";

async function createRuntime(): Promise<BrowserRuntime> {
  return new BrowserRuntime({
    executablePath: await findBrowserExecutable(),
  });
}

test("start reuses one page and preserves its state", async () => {
  const runtime = await createRuntime();

  try {
    const firstPage = await runtime.start();
    await firstPage.setContent('<button id="counter">0</button>');
    await firstPage.locator("#counter").evaluate((button) => {
      button.textContent = "1";
    });

    const secondPage = await runtime.start();

    assert.strictEqual(secondPage, firstPage);
    assert.equal(await secondPage.locator("#counter").textContent(), "1");
    assert.equal(runtime.isStarted, true);
  } finally {
    await runtime.close();
  }
});

test("close is safe to call more than once", async () => {
  const runtime = await createRuntime();
  await runtime.start();

  await runtime.close();
  await runtime.close();

  assert.equal(runtime.isStarted, false);
  assert.throws(() => runtime.page, /has not been started/);
});
