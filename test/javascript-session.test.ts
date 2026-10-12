import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createExplorationWorker } from '../packages/core/src/core/exploration/worker-client.ts';
import { parseObservations } from '../packages/core/src/core/exploration/protocol.ts';
import { findBrowserExecutable } from './fixtures/browser-executable.ts';
import { createWebExplorationSession as launchJavaScriptSession } from '../packages/core/src/platforms/web/exploration-session.ts';
import { WebExplorationManager } from '../packages/core/src/platforms/web/exploration-manager.ts';
import { WebPlatformAdapter } from '../packages/core/src/platforms/web/web-adapter.ts';
import { MaatApi } from '../packages/core/src/api/maat-api.ts';
import { PlatformRegistry } from '../packages/core/src/core/platforms/registry.ts';
import {
  ExplorationExecutionError,
  WorkerTerminatedError,
  type JavaScriptSession,
} from '../packages/core/src/core/exploration/runtime.ts';

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

test('worker classifies code failures and preserves uncertain UI state for observation', async () => {
  const session = await launch();
  try {
    await assert.rejects(session.execute('const broken: = 1;'), (error: unknown) => {
      assert.ok(error instanceof ExplorationExecutionError);
      assert.equal(error.details.category, 'syntax-error');
      assert.equal(error.details.phase, 'compile');
      assert.equal(error.details.actionState, 'not-started');
      return true;
    });
    await assert.rejects(session.execute('setTimeout(() => {}, 1);'), (error: unknown) => {
      assert.ok(error instanceof ExplorationExecutionError);
      assert.equal(error.details.category, 'reference-error');
      assert.equal(error.details.actionState, 'uncertain');
      return true;
    });
    await session.execute(`await page.setContent('<h1>before</h1>');`);
    await assert.rejects(
      session.execute(`
        await page.locator('h1').evaluate(element => element.textContent = 'possibly changed');
        globalThis.slowScroll();
      `),
      (error: unknown) => {
        assert.ok(error instanceof ExplorationExecutionError);
        assert.equal(error.details.category, 'type-error');
        assert.equal(error.details.actionState, 'uncertain');
        return true;
      },
    );
    assert.deepEqual(
      await session.execute(`console.log(await page.locator('h1').textContent());`),
      [{ type: 'text', text: 'possibly changed' }],
    );
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
  assert.equal(session.isClosed, true);
  await assert.rejects(session.execute(`console.log('too late');`), /exceeded 200ms/);
  await session.close();
});

test('abort terminates an active execution', async () => {
  const session = await launch(5_000);
  const controller = new AbortController();
  const executing = session.execute(`await new Promise(() => {});`, controller.signal);
  controller.abort();

  await assert.rejects(executing, /aborted/);
  assert.equal(session.isClosed, true);
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
        error instanceof WorkerTerminatedError &&
        message.includes('code 23') &&
        message.includes('fixture runtime failed during import')
      );
    },
  );
  assert.ok(Date.now() - startedAt < 4_000);
});

test('Web API invalidates terminated Workers, reports idle and recovers only on a new explicit request', async (t) => {
  const manager = new WebExplorationManager();
  let launches = 0;
  t.mock.method(
    manager as unknown as { launch(signal?: AbortSignal): Promise<JavaScriptSession> },
    'launch',
    async (signal?: AbortSignal) => {
      launches++;
      return launchJavaScriptSession(
        {
          assertionTimeoutMs: 100,
          executablePath: await findBrowserExecutable(),
          executionTimeoutMs: 1_000,
          headless: true,
        },
        signal,
      );
    },
  );
  const adapter = new WebPlatformAdapter('/unused', manager);
  const api = new MaatApi(new PlatformRegistry([adapter]), '/unused');
  try {
    await api.exploration.executeJavaScript("await page.setContent('<h1>retained</h1>');");
    await assert.rejects(
      api.exploration.executeJavaScript(
        "throw new Error('Exploration execution exceeded 1ms; Exploration Worker exited; session closed');",
      ),
      /exceeded 1ms/,
    );
    assert.equal(api.platforms.status().session, 'ready');
    assert.equal(launches, 1);
    assert.deepEqual(
      await api.exploration.executeJavaScript(
        "console.log(await page.locator('h1').textContent());",
      ),
      [{ type: 'text', text: 'retained' }],
    );
    await assert.rejects(
      api.exploration.executeJavaScript(
        "await page.setContent('<h1>do not replay</h1>'); while (true) {}",
      ),
      WorkerTerminatedError,
    );
    assert.equal(api.platforms.status().session, 'idle');
    assert.equal(launches, 1);
    assert.deepEqual(
      await api.exploration.executeJavaScript(
        "console.log((await page.content()).includes('do not replay'));",
      ),
      [{ type: 'text', text: 'false' }],
    );
    assert.equal(launches, 2);
    await assert.rejects(
      api.exploration.executeJavaScript("Buffer.constructor('return process')().exit(23);"),
      /Worker exited.*code 23/,
    );
    assert.equal(api.platforms.status().session, 'idle');
    assert.equal(launches, 2);
    await api.exploration.executeJavaScript("console.log('explicit recovery');");
    assert.equal(launches, 3);
    const controller = new AbortController();
    const executing = api.exploration.executeJavaScript('while (true) {}', controller.signal);
    const timer = setTimeout(() => controller.abort(new Error('cancel Web execution')), 20);
    try {
      await assert.rejects(executing, WorkerTerminatedError);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(api.platforms.status().session, 'idle');
    assert.equal(launches, 3);
  } finally {
    await api.close();
  }
});

test('Web manager preserves a terminated execution error when owned cleanup also fails', async () => {
  const primary = new WorkerTerminatedError('Exploration execution exceeded 1ms.');
  const cleanup = new Error('browser cleanup failed');
  let closed = false;
  const session: JavaScriptSession = {
    get isClosed() {
      return closed;
    },
    async execute() {
      closed = true;
      throw primary;
    },
    async close() {
      throw cleanup;
    },
  };
  const manager = new WebExplorationManager();
  (manager as unknown as { session: JavaScriptSession }).session = session;
  await assert.rejects(manager.execute('void 0;'), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, primary);
    assert.deepEqual(error.errors, [primary, cleanup]);
    assert.match(error.message, /exceeded 1ms.*browser cleanup failed/s);
    return true;
  });
  assert.equal(manager.isRunning, false);
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
