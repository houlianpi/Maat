import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { CaseManager } from '../src/cases/case-manager.ts';
import { saveCase } from '../src/core/cases/save-case.ts';

async function mockAppium() {
  let creations = 0;
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
    } else if (request.url?.endsWith('/element'))
      value = { 'element-6066-11e4-a52e-4f735466cecf': 'label' };
    else if (request.url?.endsWith('/text')) value = 'Native ready';
    else if (request.url?.endsWith('/screenshot')) value = 'iVBORw0KGgo=';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ value }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No mock address.');
  return { server, url: `http://127.0.0.1:${address.port}/`, creations: () => creations };
}

test('one Mocha Case reuses Web around an Appium step', async () => {
  const appium = await mockAppium();
  await mkdir('artifacts/mixed-tests', { recursive: true });
  const root = await mkdtemp(path.resolve('artifacts/mixed-tests/root-'));
  try {
    await mkdir(path.join(root, 'android'), { recursive: true });
    await writeFile(
      path.join(root, 'android/native-target.local.json'),
      JSON.stringify({
        platform: 'android',
        serverUrl: appium.url,
        capabilities: { 'appium:deviceName': 'mock' },
      }),
    );
    const manager = new CaseManager();
    const draft = manager.begin({
      id: 'mixed-flow',
      name: 'Mixed flow',
      description: 'Web then Android then Web',
      objectives: ['Both runtimes retain state'],
      rootDirectory: root,
    });
    draft.steps.push(
      {
        number: 1,
        adapterId: 'web',
        bindings: ['page'],
        observations: [],
        code: `await page.setContent('<h1 id=state>Web ready</h1>');`,
      },
      {
        number: 2,
        adapterId: 'android',
        bindings: ['driver', 'expect'],
        observations: [],
        code: `await expect(driver.$('~status')).toHaveText('Native ready');`,
      },
      {
        number: 3,
        adapterId: 'web',
        bindings: ['page', 'expect'],
        observations: [],
        code: `await expect(page.locator('#state')).toHaveText('Web ready');`,
      },
    );
    draft.requirements = [
      { adapterId: 'web', setup: { browser: 'chrome', headless: true } },
      { adapterId: 'android', setup: { app: { 'appium:appPackage': 'example.mixed' } } },
    ];
    const saved = await saveCase(draft, root);
    const source = await readFile(saved.testPath, 'utf8');
    assert.match(source, /maat\.step\("Recorded step 001", "web"/);
    assert.match(source, /maat\.step\("Recorded step 002", "android"/);
    assert.match(source, /maat\.step\("Recorded step 003", "web"/);
    assert.equal(appium.creations(), 1);
  } finally {
    appium.server.close();
    await rm(root, { recursive: true, force: true });
  }
});
