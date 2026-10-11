import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMaat } from '../packages/core/src/api/create-maat.ts';
import { findBrowserExecutable } from '../packages/core/src/setup/browser-discovery.ts';
import { AppiumPlatformAdapter } from '../packages/core/src/platforms/appium/appium-adapter.ts';

async function mockAppium() {
  let creations = 0;
  let deletes = 0;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    let value: unknown = null;
    if (request.url === '/status') value = { ready: true };
    else if (request.url === '/session' && request.method === 'POST') {
      creations++;
      value = {
        sessionId: `mixed-${creations}`,
        capabilities: JSON.parse(raw).capabilities.alwaysMatch,
      };
    } else if (request.method === 'DELETE') deletes++;
    else if (request.url?.endsWith('/element'))
      value = { 'element-6066-11e4-a52e-4f735466cecf': 'label' };
    else if (request.url?.endsWith('/text')) value = 'Native ready';
    else if (request.url?.endsWith('/screenshot')) value = 'iVBORw0KGgo=';
    else if (request.url?.endsWith('/execute/sync')) value = false; // mobile: isLocked
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ value }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No mock address.');
  return {
    server,
    url: `http://127.0.0.1:${address.port}/`,
    creations: () => creations,
    deletes: () => deletes,
  };
}

test('UI execution reuses Web state around native execution without saved Cases', async () => {
  const appium = await mockAppium();
  const root = await mkdtemp(path.join(tmpdir(), 'maat-mixed-execution-'));
  const hints = await mkdtemp(path.join(tmpdir(), 'maat-mixed-hints-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  const maat = createMaat({ workspaceRoot: root });
  try {
    process.env.MAAT_SESSION_HINTS_DIR = hints;
    await maat.platforms.configure({
      browser: 'chromium',
      headless: true,
      executablePath: await findBrowserExecutable(),
    });
    await maat.exploration.executeJavaScript(
      "await page.setContent('<h1 id=state>Web ready</h1>');",
    );
    await maat.platforms.select('android');
    await maat.platforms.configureSession({
      serverUrl: appium.url,
      capabilities: { 'appium:deviceName': 'mock' },
    });
    // The mixed-platform contract uses an already resolved mock native Session.
    // Exact Android cold-routing/preflight is covered by native.test.ts.
    const native = maat.registry.current as AppiumPlatformAdapter;
    await native.runtime.configureResolved({
      environment: native.sessionHints!,
      capabilities: { 'appium:deviceName': 'mock', 'appium:skipUnlock': true },
    });
    await native.runtime.execute('void 0;');
    assert.deepEqual(
      await maat.exploration.executeJavaScript("console.log(await driver.$('~status').getText());"),
      [{ type: 'text', text: 'Native ready' }],
    );
    await maat.platforms.select('web');
    assert.deepEqual(
      await maat.exploration.executeJavaScript(
        "console.log(await page.locator('#state').textContent());",
      ),
      [{ type: 'text', text: 'Web ready' }],
    );
    assert.equal(appium.creations(), 1);
    assert.equal(appium.deletes(), 0);
    assert.deepEqual(await readdir(root), []);
    await maat.close();
    assert.equal(appium.deletes(), 1);
    assert.equal(appium.server.listening, true);
  } finally {
    await maat.close();
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    appium.server.close();
    await rm(root, { recursive: true, force: true });
    await rm(hints, { recursive: true, force: true });
  }
});
