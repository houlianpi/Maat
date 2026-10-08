import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createExplorationWorker } from '../src/core/exploration/worker-client.ts';
import { parseObservations } from '../src/core/exploration/protocol.ts';
import { findBrowserExecutable } from '../src/setup/browser-discovery.ts';
import { createWebExplorationSession as launchJavaScriptSession } from '../src/platforms/web/exploration-session.ts';

async function launch(executionTimeoutMs = 5_000) {
  return launchJavaScriptSession({
    assertionTimeoutMs: 500,
    executablePath: await findBrowserExecutable(),
    executionTimeoutMs,
    headless: true,
  });
}

test('worker preserves page state across executions', async () => {
  const session = await launch();

  try {
    const first = await session.execute(`
      await page.setContent('<button id="counter">41</button>');
      console.log('initialized');
    `);
    const second = await session.execute(`
      const button = page.locator('#counter');
      const value = Number(await button.textContent()) + 1;
      await button.evaluate((element, next) => element.textContent = String(next), value);
      console.log(value);
    `);

    assert.deepEqual(first, [{ type: 'text', text: 'initialized' }]);
    assert.deepEqual(second, [{ type: 'text', text: '42' }]);
  } finally {
    await session.close();
  }
});

test('worker returns values and screenshots', async () => {
  const session = await launch();

  try {
    assert.deepEqual(await session.execute(`return { ok: true };`), [
      { type: 'text', text: '{ ok: true }' },
    ]);

    const screenshot = await session.execute(`display(await page.screenshot());`);
    assert.equal(screenshot.length, 1);
    assert.equal(screenshot[0]?.type, 'image');
    if (screenshot[0]?.type === 'image') {
      assert.equal(screenshot[0].mimeType, 'image/png');
      assert.ok(screenshot[0].data.length > 100);
    }
  } finally {
    await session.close();
  }
});

test('display rejects text and non-image bytes without returning a corrupt observation', async () => {
  const session = await launch();
  try {
    await assert.rejects(
      session.execute(`display('not an image');`),
      /Use console\.log\(\) for text/,
    );
    await assert.rejects(
      session.execute(`display(Buffer.from('not an image'));`),
      /valid PNG, JPEG, or WebP payload/,
    );
    assert.deepEqual(await session.execute(`console.log('session remains usable');`), [
      { type: 'text', text: 'session remains usable' },
    ]);
  } finally {
    await session.close();
  }
});

test('parent rejects forged image observations', () => {
  assert.throws(
    () => parseObservations([{ type: 'image', mimeType: 'image/png', data: '1 + 6 = 7' }]),
    /unsupported observation/,
  );
  assert.throws(
    () =>
      parseObservations([
        { type: 'image', mimeType: 'image/jpeg', data: 'iVBORw0KGgoAAAANSUhEUg==' },
      ]),
    /does not match its MIME type/,
  );
});

test('worker exposes Playwright expect assertions', async () => {
  const session = await launch();

  try {
    const passed = await session.execute(`
      await page.setContent('<h1>Expected outcome</h1>');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Expected outcome');
      console.log('assertion passed');
    `);
    assert.deepEqual(passed, [{ type: 'text', text: 'assertion passed' }]);

    await assert.rejects(
      session.execute(
        `await expect(page.getByRole('heading', { level: 1 })).toHaveText('Wrong outcome');`,
      ),
      (error: unknown) => {
        const message = (error instanceof Error ? error.message : String(error)).replace(
          /\x1B\[[0-?]*[ -/]*[@-~]/g,
          '',
        );
        return (
          message.includes('expect(locator)') &&
          message.includes('Expected:') &&
          message.includes('Wrong outcome') &&
          message.includes('Received:')
        );
      },
    );
  } finally {
    await session.close();
  }
});

test('parent rejects empty and oversized code before IPC', async () => {
  const session = await launch();

  try {
    await assert.rejects(session.execute('  '), /nonempty and at most 64 KiB/);
    await assert.rejects(session.execute('x'.repeat(64 * 1024 + 1)), /nonempty and at most 64 KiB/);
  } finally {
    await session.close();
  }
});

test('output limit rejects the execution without crashing the parent', async () => {
  const session = await launch();

  try {
    await assert.rejects(
      session.execute(`console.log('a'.repeat(13 * 1024 * 1024));`),
      /output exceeds 12 MiB/,
    );
  } finally {
    await session.close();
  }
});

test('timeout terminates a stuck worker and its browser', async () => {
  const session = await launch(200);

  await assert.rejects(session.execute(`await new Promise(() => {});`), /exceeded 200ms/);
  await assert.rejects(session.execute(`console.log('too late');`), /exceeded 200ms/);
  await session.close();
});

test('abort terminates an active execution', async () => {
  const session = await launch(5_000);
  const controller = new AbortController();
  const executing = session.execute(`await new Promise(() => {});`, controller.signal);
  controller.abort();

  await assert.rejects(executing, /aborted/);
  await session.close();
});

test('closing an already terminated worker remains bounded and idempotent', async () => {
  const session = await launch(200);
  await assert.rejects(session.execute(`await new Promise(() => {});`), /exceeded 200ms/);
  const startedAt = Date.now();
  await Promise.all([session.close(), session.close()]);
  assert.ok(Date.now() - startedAt < 3_000);
});

test('worker reports an early process exit with bounded stderr instead of timing out', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    createExplorationWorker(
      new URL('./fixtures/exploration-worker-exit.ts', import.meta.url),
      {},
      5_000,
      5_000,
    ),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return (
        message.includes('code 23') && message.includes('fixture runtime failed during import')
      );
    },
  );
  assert.ok(Date.now() - startedAt < 4_000);
});

test('persistent profile keeps browser state between sessions', async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'maat-profile-'));
  const executablePath = await findBrowserExecutable();

  try {
    const first = await launchJavaScriptSession({
      assertionTimeoutMs: 500,
      executablePath,
      headless: true,
      userDataDir,
    });
    try {
      await first.execute(`
        await context.addCookies([{
          name: 'persistent-test',
          value: 'saved',
          domain: 'example.com',
          path: '/',
          expires: Math.floor(Date.now() / 1000) + 3600,
        }]);
        console.log('saved');
      `);
    } finally {
      await first.close();
    }

    const second = await launchJavaScriptSession({
      assertionTimeoutMs: 500,
      executablePath,
      headless: true,
      userDataDir,
    });
    try {
      const result = await second.execute(`
        const cookies = await context.cookies('https://example.com');
        console.log(cookies.find(cookie => cookie.name === 'persistent-test')?.value);
      `);
      assert.deepEqual(result, [{ type: 'text', text: 'saved' }]);
    } finally {
      await second.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});
