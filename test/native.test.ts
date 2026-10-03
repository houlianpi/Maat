import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { startNativeSession } from '../src/native/exploration/session.ts';
import { startOwnedServer } from '../src/native/appium/server.ts';
import { capabilities, connection, splitCapabilities } from '../src/native/environment/schema.ts';
import { matchDevices, parseAndroidDevices, parseIosDevices } from '../src/native/environment/devices.ts';
import { nativeSpec } from '../src/native/cases/spec-generator.ts';
import { runNativeProject } from '../src/native/execution/runner.ts';
import { CaseManager } from '../src/cases/case-manager.ts';
import { ProjectManager } from '../src/projects/project-manager.ts';
import { BrowserManager } from '../src/browser/browser-manager.ts';
import { scaffoldNativeFixture } from '../src/native/cases/fixture.ts';
import { platformRoot, casePath } from '../src/projects/layout.ts';
import { createProjectTools } from '../src/projects/project-tools.ts';
import { createCaseTools } from '../src/cases/case-tools.ts';
import { createMaatResourceOptions } from '../src/tui/maat-runtime-config.ts';

async function mockAppium() {
  let deletes = 0; let creations = 0;
  const sessionCapabilities: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    let value: unknown = null;
    if (req.url === '/session' && req.method === 'POST') { creations++; sessionCapabilities.push(body.capabilities.alwaysMatch); value = { sessionId: 'owned-' + creations, capabilities: body.capabilities.alwaysMatch }; }
    else if (req.method === 'DELETE') deletes++;
    else if (req.url?.endsWith('/element')) value = { 'element-6066-11e4-a52e-4f735466cecf': 'button-1' };
    else if (req.url?.endsWith('/text')) value = 'Welcome';
    else if (req.url?.endsWith('/displayed')) value = true;
    else if (req.url?.endsWith('/screenshot')) value = 'iVBORw0KGgo=';
    else if (req.url?.endsWith('/source')) value = '<Application name="Demo" />';
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ value }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  return { url: `http://127.0.0.1:${address.port}/`, server, deleted: () => deletes, created: () => creations, sessionCapabilities };
}

test('native defaults preserve data and device discovery excludes offline devices', () => {
  assert.equal(capabilities({ platform: 'ios', capabilities: {} })['appium:noReset'], true);
  assert.equal(capabilities({ platform: 'macos', capabilities: {} })['appium:automationName'], 'Mac2');
  assert.equal(connection('http://localhost:4723/wd/hub').path, '/wd/hub');
  assert.equal(parseAndroidDevices('List of devices attached\na device model:Pixel\nb unauthorized\nc offline').length, 1);
});

test('native target persists stable environment and resolves changing device UUIDs', () => {
  const split = splitCapabilities({ 'appium:udid': 'old-uuid', 'appium:bundleId': 'com.example.old', 'appium:xcodeOrgId': 'TEAM' });
  assert.equal(split.environment['appium:udid'], undefined);
  assert.equal(split.app['appium:bundleId'], 'com.example.old');
  assert.equal(split.environment['appium:xcodeOrgId'], 'TEAM');
  assert.equal(matchDevices([{ id: 'new-uuid', name: 'iPhone 17', kind: 'simulator' }], { kind: 'simulator', name: 'iPhone 17' })[0]?.id, 'new-uuid');
});

test('iOS discovery keeps simulators listed after offline devices', () => {
  const devices = parseIosDevices(`== Devices ==\nPhone (26.7) (00000000-0000000000000001)\n== Devices Offline ==\nOld Phone (26.6) (00000000-0000000000000002)\n== Simulators ==\niPhone 17 Simulator (27.0) (00000000-0000-0000-0000-000000000003)`);
  assert.deepEqual(devices.map(({ name, kind }) => ({ name, kind })), [
    { name: 'Phone', kind: 'device' },
    { name: 'iPhone 17', kind: 'simulator' },
  ]);
});

test('WDIO worker executes TypeScript and assertions, owns only its remote session', async () => {
  const mock = await mockAppium();
  const session = await startNativeSession({ environment: { platform: 'android', serverUrl: mock.url, capabilities: {} }, capabilities: {} });
  try {
    const result = await session.execute(`const label: string = await driver.$('~welcome').getText(); expect(label).toBe('Welcome'); console.log(label);`);
    assert.deepEqual(result, [{ type: 'text', text: 'Welcome' }]);
    const second = await session.execute(`await expect(driver.$('~welcome')).toBeDisplayed(); display(await driver.takeScreenshot());`);
    assert.equal(second[0].type, 'image');
    assert.equal((await session.execute("await evidence.screenshot('result');"))[0].type, 'image');
    assert.equal(mock.created(), 1);
  } finally { await session.close(); }
  assert.equal(mock.deleted(), 1); assert.equal(mock.server.listening, true);
  mock.server.close();
});

test('native synchronous runaway is killed and remote session deleted', async () => {
  const mock = await mockAppium();
  const session = await startNativeSession({ environment: { platform: 'android', serverUrl: mock.url, capabilities: {} }, capabilities: {} }, 5000);
  const abort = new AbortController();
  try {
    const executing = session.execute('while (true) {}', abort.signal);
    const timer = setTimeout(() => abort.abort(), 100);
    try { await assert.rejects(executing, /aborted/); } finally { clearTimeout(timer); }
  } finally { await session.close(); mock.server.close(); }
  assert.equal(mock.deleted(), 1);
});

test('native execution enforces code/output limits and a parent deadline', async () => {
  const mock = await mockAppium();
  const session = await startNativeSession({ environment: { platform: 'ios', serverUrl: mock.url, capabilities: {} }, capabilities: {} }, 1500);
  try {
    await assert.rejects(session.execute('x'.repeat(65537)), /64 KiB/);
    await assert.rejects(session.execute("console.log('x'.repeat(13 * 1024 * 1024))"), /12 MiB/);
    await assert.rejects(session.execute('await Promise.resolve(); while (true) {}'), /timed out/);
  } finally { await session.close(); mock.server.close(); }
  assert.equal(mock.deleted(), 1);
});

test('official Appium service starts and stops its owned server without drivers', async () => {
  const server = await startOwnedServer();
  try { assert.equal((await fetch(server.url + 'status')).status, 200); } finally { await server.close(); }
  await assert.rejects(fetch(server.url + 'status'));
});

test('generated native Case runs under actual WDIO Runner, Mocha and expect-webdriverio', async () => {
  const mock = await mockAppium();
  await mkdir('artifacts/native-tests', { recursive: true });
  const root = await mkdtemp(path.resolve('artifacts/native-tests/run-'));
  try {
    await mkdir(path.join(root, 'cases'));
    await scaffoldNativeFixture(root);
    const draft = new CaseManager().begin({ id: 'native-smoke', name: 'Native smoke', description: 'Welcome label', objectives: ['Welcome visible'], suites: ['smoke'] });
    draft.steps.push({ number: 1, observations: [], code: `await expect(driver.$('~welcome')).toBeDisplayed(); await expect(driver.$('~welcome')).toHaveText('Welcome'); await evidence.screenshot('welcome'); display(await driver.takeScreenshot());` });
    await writeFile(path.join(root, 'cases/native-smoke.spec.ts'), nativeSpec(draft, { 'appium:appPackage': 'example.smoke' }));
    await writeFile(path.join(root, 'native-target.local.json'), JSON.stringify({ platform: 'android', serverUrl: mock.url, capabilities: { 'appium:deviceName': 'mock', 'appium:appPackage': 'example.other' } }));
    const implementation = path.resolve('src/native/execution/wdio-config.ts');
    await writeFile(path.join(root, 'wdio.conf.ts'), `import { createNativeConfig } from ${JSON.stringify(implementation)}; export const config = await createNativeConfig(${JSON.stringify(root)});`);
    assert.equal(await runNativeProject(root, { mode: 'all' }), 0);
    assert.equal(mock.deleted(), 1);
    assert.equal(mock.sessionCapabilities[0]?.['appium:appPackage'], 'example.smoke');
    const runs = path.resolve(root, '../../artifacts/native', path.basename(root), 'runs');
    const [run] = await readdir(runs);
    const evidenceRoot = path.join(runs, run, 'evidence');
    const [testDirectory] = await readdir(evidenceRoot);
    const manifest = JSON.parse(await readFile(path.join(evidenceRoot, testDirectory, 'evidence.json'), 'utf8'));
    assert.equal(manifest.test.title, 'native-smoke');
    assert.equal(manifest.passed, true);
    assert.deepEqual(manifest.items.map((item: { name: string }) => item.name), ['welcome', 'observation', 'final-state']);
    for (const item of manifest.items) assert.ok((await readFile(path.join(evidenceRoot, testDirectory, item.path))).length);
  } finally { mock.server.close(); await rm(root, { recursive: true, force: true }); }
});

test('native batch continues after a failing Case and reports aggregate failure', async () => {
  const mock = await mockAppium();
  await mkdir('artifacts/native-tests', { recursive: true });
  const root = await mkdtemp(path.resolve('artifacts/native-tests/batch-'));
  try {
    await mkdir(path.join(root, 'cases'));
    await scaffoldNativeFixture(root);
    const first = new CaseManager().begin({ id: 'first', name: 'First', description: 'Fails', objectives: ['Fail'] });
    first.steps.push({ number: 1, observations: [], code: `await expect(1).toBe(2);` });
    const second = new CaseManager().begin({ id: 'second', name: 'Second', description: 'Passes', objectives: ['Pass'] });
    second.steps.push({ number: 1, observations: [], code: `await expect(2).toBe(2);` });
    await writeFile(path.join(root, 'cases/first.spec.ts'), nativeSpec(first, { 'appium:appPackage': 'example.first' }));
    await writeFile(path.join(root, 'cases/second.spec.ts'), nativeSpec(second, { 'appium:appPackage': 'example.second' }));
    await writeFile(path.join(root, 'native-target.local.json'), JSON.stringify({ platform: 'android', serverUrl: mock.url, capabilities: { 'appium:deviceName': 'mock' } }));
    const implementation = path.resolve('src/native/execution/wdio-config.ts');
    await writeFile(path.join(root, 'wdio.conf.ts'), `import { createNativeConfig } from ${JSON.stringify(implementation)}; export const config = await createNativeConfig(${JSON.stringify(root)});`);
    assert.equal(await runNativeProject(root, { mode: 'all' }), 1);
    assert.deepEqual(mock.sessionCapabilities.map(caps => caps['appium:appPackage']), ['example.first', 'example.second']);
  } finally { mock.server.close(); await rm(root, { recursive: true, force: true }); }
});

test('Agent project flow saves a verified TypeScript native Case and retains remote server', async () => {
  const mock = await mockAppium();
  await mkdir('artifacts/native-tests', { recursive: true });
  const base = await mkdtemp(path.resolve('artifacts/native-tests/layout-'));
  const projects = new ProjectManager(base);
  const browser = new BrowserManager();
  const cases = new CaseManager();
  const root = path.join(base, 'android');
  try {
    await projects.select('android', 'android', browser);
    await projects.configure({ platform: 'android', serverUrl: mock.url, capabilities: { 'appium:deviceName': 'mock' } }, { 'appium:appPackage': 'example.welcome' });
    const configure = createProjectTools(projects, browser, cases).find(tool => tool.name === 'configure_native')!;
    await configure.execute('update', { capabilities: { 'appium:newCommandTimeout': 180 } }, undefined, undefined, {} as never);
    assert.equal(projects.native.currentEnvironment?.serverUrl, mock.url);
    assert.equal(projects.native.currentEnvironment?.capabilities['appium:deviceName'], 'mock');
    const draft = cases.begin({ id: 'welcome', module: 'account/login', name: 'Welcome', description: 'Welcome is shown', objectives: ['Welcome'], rootDirectory: root });
    const code = `await expect(driver.$('~welcome')).toHaveText('Welcome');`;
    await cases.recordSuccessfulStep(code, await projects.native.execute(code));
    const saved = await projects.save(draft, browser);
    const { readFile } = await import('node:fs/promises');
    const spec = await readFile(saved.testPath, 'utf8');
    assert.ok(spec.includes('fixtures/maat-test.ts'));
    assert.equal(mock.created(), 2); assert.equal(mock.deleted(), 2);
    assert.equal(saved.testPath, path.join(root, 'cases/account/login/welcome.spec.ts'));
    assert.ok(spec.includes('../../../fixtures/maat-test.ts'));
    assert.doesNotMatch(spec, /node:fs|mkdirSync|writeFileSync|randomUUID|path.resolve/);
    assert.equal(mock.server.listening, true);
    assert.ok(!spec.includes(mock.url));
    draft.steps.push({ number: 2, observations: [], code: `await expect(1).toBe(2);` });
    await assert.rejects(projects.save(draft, browser), /WDIO validation failed/);
    assert.equal(await readFile(saved.testPath, 'utf8'), spec);
    const runs = path.resolve(root, '../../artifacts/native/android/runs');
    const manifests = [];
    for (const run of await readdir(runs)) {
      const evidenceRoot = path.join(runs, run, 'evidence');
      for (const testDirectory of await readdir(evidenceRoot)) manifests.push(JSON.parse(await readFile(path.join(evidenceRoot, testDirectory, 'evidence.json'), 'utf8')));
    }
    assert.ok(manifests.some(m => m.passed === false && m.items.some((item: { name: string }) => item.name === 'failure')));
  } finally {
    await projects.native.close(); await browser.close(); mock.server.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('platform layout is enforced by schema and manager, not model naming', async () => {
  const projects = new ProjectManager();
  const browser = new BrowserManager();
  await assert.rejects(projects.select('iphone-calculator', 'ios', browser), /must equal platform/);
  assert.equal(projects.current.platform, 'web');
  for (const platform of ['web', 'android', 'ios', 'macos']) assert.equal(platformRoot('maat-tests', platform), path.resolve('maat-tests', platform));
  assert.throws(() => platformRoot('maat-tests', '../escape'));
  assert.throws(() => casePath('/root/ios', '../escape'));
  assert.throws(() => casePath('/root/ios', 'case', '../escape'));
  const tools = createProjectTools(projects, browser, new CaseManager());
  assert.equal(tools.find(tool => tool.name === 'select_project')!.parameters.properties.name, undefined);
  const caseTools = createCaseTools(new CaseManager(), browser, projects);
  assert.equal(caseTools.find(tool => tool.name === 'begin_case')!.parameters.properties.rootDirectory, undefined);
  assert.ok(createMaatResourceOptions([]).systemPrompt.includes('maat-tests/<platform>/cases/<module>/<case-id>.spec.ts'));
});
