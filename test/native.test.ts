import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { startNativeSession } from '../src/platforms/appium/runtime/session.ts';
import { capabilities, connection, splitCapabilities } from '../src/platforms/appium/schema.ts';
import { matchDevices, parseAndroidDevices, parseIosDevices } from '../src/setup/devices.ts';
import { CaseManager } from '../src/cases/case-manager.ts';
import { ProjectManager } from '../src/projects/project-manager.ts';
import { BrowserManager } from '../src/browser/browser-manager.ts';
import { platformRoot, casePath } from '../src/projects/layout.ts';
import { createProjectTools } from '../src/projects/project-tools.ts';
import { createCaseTools } from '../src/cases/case-tools.ts';
import { createMaatResourceOptions } from '../src/tui/maat-runtime-config.ts';
import { AppiumPlatformAdapter } from '../src/platforms/appium/appium-adapter.ts';
import { createDefaultPlatformRegistry } from '../src/platforms/default-registry.ts';

async function mockAppium() {
  let deletes = 0;
  let creations = 0;
  const sessionCapabilities: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    let value: unknown = null;
    if (req.url === '/session' && req.method === 'POST') {
      creations++;
      sessionCapabilities.push(body.capabilities.alwaysMatch);
      value = { sessionId: 'owned-' + creations, capabilities: body.capabilities.alwaysMatch };
    } else if (req.method === 'DELETE') deletes++;
    else if (req.url?.endsWith('/element'))
      value = { 'element-6066-11e4-a52e-4f735466cecf': 'button-1' };
    else if (req.url?.endsWith('/text')) value = 'Welcome';
    else if (req.url?.endsWith('/displayed')) value = true;
    else if (req.url?.endsWith('/screenshot')) value = 'iVBORw0KGgo=';
    else if (req.url?.endsWith('/source')) value = '<Application name="Demo" />';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    server,
    deleted: () => deletes,
    created: () => creations,
    sessionCapabilities,
  };
}

test('native defaults preserve data and device discovery excludes offline devices', () => {
  assert.equal(capabilities({ platform: 'ios', capabilities: {} })['appium:noReset'], true);
  assert.equal(
    capabilities({ platform: 'macos', capabilities: {} })['appium:automationName'],
    'Mac2',
  );
  assert.equal(connection('http://localhost:4723/wd/hub').path, '/wd/hub');
  assert.equal(
    parseAndroidDevices('List of devices attached\na device model:Pixel\nb unauthorized\nc offline')
      .length,
    1,
  );
});

test('native target persists stable environment and resolves changing device UUIDs', () => {
  const split = splitCapabilities({
    'appium:udid': 'old-uuid',
    'appium:bundleId': 'com.example.old',
    'appium:xcodeOrgId': 'TEAM',
  });
  assert.equal(split.environment['appium:udid'], undefined);
  assert.equal(split.app['appium:bundleId'], 'com.example.old');
  assert.equal(split.environment['appium:xcodeOrgId'], 'TEAM');
  assert.equal(
    matchDevices([{ id: 'new-uuid', name: 'iPhone 17', kind: 'simulator' }], {
      kind: 'simulator',
      name: 'iPhone 17',
    })[0]?.id,
    'new-uuid',
  );
});

test('iOS discovery keeps simulators listed after offline devices', () => {
  const devices = parseIosDevices(
    `== Devices ==\nPhone (26.7) (00000000-0000000000000001)\n== Devices Offline ==\nOld Phone (26.6) (00000000-0000000000000002)\n== Simulators ==\niPhone 17 Simulator (27.0) (00000000-0000-0000-0000-000000000003)`,
  );
  assert.deepEqual(
    devices.map(({ name, kind }) => ({ name, kind })),
    [
      { name: 'Phone', kind: 'device' },
      { name: 'iPhone 17', kind: 'simulator' },
    ],
  );
});

test('WDIO worker executes TypeScript and assertions, owns only its remote session', async () => {
  const mock = await mockAppium();
  const session = await startNativeSession({
    environment: { platform: 'android', serverUrl: mock.url, capabilities: {} },
    capabilities: {},
  });
  try {
    const result = await session.execute(
      `const label: string = await driver.$('~welcome').getText(); expect(label).toBe('Welcome'); console.log(label);`,
    );
    assert.deepEqual(result, [{ type: 'text', text: 'Welcome' }]);
    const second = await session.execute(
      `await expect(driver.$('~welcome')).toBeDisplayed(); display(await driver.takeScreenshot());`,
    );
    assert.equal(second[0].type, 'image');
    assert.equal((await session.execute("await evidence.screenshot('result');"))[0].type, 'image');
    assert.equal(mock.created(), 1);
  } finally {
    await session.close();
  }
  assert.equal(mock.deleted(), 1);
  assert.equal(mock.server.listening, true);
  mock.server.close();
});

test('native synchronous runaway is killed and remote session deleted', async () => {
  const mock = await mockAppium();
  const session = await startNativeSession(
    {
      environment: { platform: 'android', serverUrl: mock.url, capabilities: {} },
      capabilities: {},
    },
    5000,
  );
  const abort = new AbortController();
  try {
    const executing = session.execute('while (true) {}', abort.signal);
    const timer = setTimeout(() => abort.abort(), 100);
    try {
      await assert.rejects(executing, /aborted/);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await session.close();
    mock.server.close();
  }
  assert.equal(mock.deleted(), 1);
});

test('native execution enforces code/output limits and a parent deadline', async () => {
  const mock = await mockAppium();
  const session = await startNativeSession(
    { environment: { platform: 'ios', serverUrl: mock.url, capabilities: {} }, capabilities: {} },
    1500,
  );
  try {
    await assert.rejects(session.execute('x'.repeat(65537)), /64 KiB/);
    await assert.rejects(session.execute("console.log('x'.repeat(13 * 1024 * 1024))"), /12 MiB/);
    await assert.rejects(
      session.execute('await Promise.resolve(); while (true) {}'),
      /exceeded 1500ms/,
    );
  } finally {
    await session.close();
    mock.server.close();
  }
  assert.equal(mock.deleted(), 1);
});

test('Agent project flow saves a verified TypeScript native Case and retains remote server', async () => {
  const mock = await mockAppium();
  await mkdir('artifacts/native-tests', { recursive: true });
  const base = await mkdtemp(path.resolve('artifacts/native-tests/layout-'));
  const browser = new BrowserManager();
  const projects = new ProjectManager(createDefaultPlatformRegistry(base, browser), base);
  const cases = new CaseManager();
  const root = path.join(base, 'android');
  try {
    await projects.select('android');
    await projects.configureSession({
      serverUrl: mock.url,
      capabilities: { 'appium:deviceName': 'mock', 'appium:appPackage': 'example.welcome' },
    });
    const configure = createProjectTools(projects, cases).find(
      (tool) => tool.name === 'configure_session',
    )!;
    await configure.execute(
      'update',
      { capabilities: { 'appium:newCommandTimeout': 180 } },
      undefined,
      undefined,
      {} as never,
    );
    assert.ok(projects.adapter instanceof AppiumPlatformAdapter);
    assert.equal(projects.adapter.sessionHints?.serverUrl, mock.url);
    assert.equal(projects.adapter.sessionHints?.capabilities['appium:deviceName'], 'mock');
    const draft = cases.begin({
      id: 'welcome',
      module: 'account/login',
      name: 'Welcome',
      description: 'Welcome is shown',
      objectives: ['Welcome'],
      rootDirectory: base,
    });
    const code = `await expect(driver.$('~welcome')).toHaveText('Welcome');`;
    await cases.recordSuccessfulStep(code, await projects.execute(code), {
      adapterId: 'android',
      bindings: ['driver', 'browser', 'expect', 'display', 'evidence'],
      requirement: projects.adapter.runtimeRequirement(),
    });
    const saved = await projects.save(draft);
    const { readFile } = await import('node:fs/promises');
    const spec = await readFile(saved.testPath, 'utf8');
    assert.match(spec, /createMaatTest/);
    assert.equal(mock.created(), 2);
    assert.equal(mock.deleted(), 1);
    assert.equal(saved.testPath, path.join(base, 'cases/account/login/welcome.spec.ts'));
    assert.match(spec, /maat\.step\("Recorded step 001", "android"/);
    assert.doesNotMatch(spec, /node:fs|mkdirSync|writeFileSync|randomUUID|path.resolve/);
    assert.equal(mock.server.listening, true);
    assert.ok(!spec.includes(mock.url));
    draft.steps.push({
      number: 2,
      adapterId: 'android',
      bindings: ['expect'],
      observations: [],
      code: `await expect(1).toBe(2);`,
    });
    await assert.rejects(projects.save(draft), /Clean validation failed/);
    assert.equal(await readFile(saved.testPath, 'utf8'), spec);
    const runs = path.resolve('artifacts/maat/runs');
    assert.ok((await readdir(runs)).length > 0);
  } finally {
    await projects.close();
    await browser.close();
    mock.server.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('platform layout is enforced by schema and manager, not model naming', async () => {
  const projects = new ProjectManager(createDefaultPlatformRegistry(), path.resolve('maat-tests'));
  const browser = new BrowserManager();
  await assert.rejects(projects.select('iphone-calculator'), /Unknown platform/);
  assert.equal(projects.current.platform, 'web');
  for (const platform of ['web', 'android', 'ios', 'macos'])
    assert.equal(platformRoot('maat-tests', platform), path.resolve('maat-tests', platform));
  assert.throws(() => platformRoot('maat-tests', '../escape'));
  assert.throws(() => casePath('/root/ios', '../escape'));
  assert.throws(() => casePath('/root/ios', 'case', '../escape'));
  const tools = createProjectTools(projects, new CaseManager());
  assert.equal(
    tools.find((tool) => tool.name === 'select_platform')!.parameters.properties.platform.type,
    'string',
  );
  const caseTools = createCaseTools(new CaseManager(), projects);
  assert.equal(
    caseTools.find((tool) => tool.name === 'begin_case')!.parameters.properties.rootDirectory,
    undefined,
  );
  assert.ok(
    createMaatResourceOptions([]).systemPrompt.includes(
      'maat-tests/<platform>/cases/<module>/<case-id>.spec.ts',
    ),
  );
});
