import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startNativeSession } from '../src/platforms/appium/runtime/session.ts';
import { capabilities, connection, splitCapabilities } from '../src/platforms/appium/schema.ts';
import { matchDevices, parseAndroidDevices, parseIosDevices } from '../src/setup/devices.ts';
import { CaseDraftManager } from '../src/core/cases/draft-manager.ts';
import { MaatApi } from '../src/api/maat-api.ts';
import { adapterRoot as platformRoot, casePath } from '../src/core/cases/paths.ts';
import { createPlatformTools } from '../src/tools/platform-tools.ts';
import { createCaseTools } from '../src/tools/case-tools.ts';
import { createMaatResourceOptions } from '../src/hosts/tui/runtime-config.ts';
import { AppiumPlatformAdapter } from '../src/platforms/appium/appium-adapter.ts';
import { createDefaultPlatformRegistry } from '../src/platforms/default-registry.ts';
import { createAppiumTestSession } from '../src/platforms/appium/test-session.ts';

async function mockAppium() {
  let deletes = 0;
  let creations = 0;
  const requests: string[] = [];
  const sessionCapabilities: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
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
    requests,
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
    platformName: 'Mac',
    automationName: 'Mac2',
    'appium:automationName': 'Mac2',
  });
  assert.equal(split.environment['appium:udid'], undefined);
  assert.equal(split.environment.platformName, undefined);
  assert.equal(split.environment.automationName, undefined);
  assert.equal(split.environment['appium:automationName'], undefined);
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

test('derived native capabilities never leak unprefixed WebDriver fields', () => {
  const result = capabilities({
    environment: { platform: 'macos', capabilities: {} },
    capabilities: { platformName: 'Mac', automationName: 'Mac2' },
  });
  assert.equal(result.platformName, 'Mac');
  assert.equal('automationName' in result, false);
  assert.equal(result['appium:automationName'], 'Mac2');
  assert.throws(
    () =>
      capabilities({
        environment: { platform: 'macos', capabilities: {} },
        capabilities: { automationName: 'XCUITest' },
      }),
    /automationName conflicts/,
  );
});

test('legacy App capability names normalize and invalid configuration is recoverable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-native-config-'));
  const adapter = new AppiumPlatformAdapter(
    { id: 'macos', label: 'macOS', platformName: 'Mac', automationName: 'Mac2' },
    root,
  );
  try {
    await adapter.configureSession({ capabilities: { bundleId: 'com.example.old' } });
    assert.deepEqual(adapter.appTarget, { 'appium:bundleId': 'com.example.old' });
    assert.deepEqual(adapter.sessionHints?.capabilities, {});
    await assert.rejects(
      adapter.configureSession({ capabilities: { unknownCapability: true } }),
      /Unsupported unprefixed Appium capabilities: unknownCapability/,
    );
    assert.deepEqual(adapter.appTarget, { 'appium:bundleId': 'com.example.old' });
    assert.deepEqual(adapter.sessionHints?.capabilities, {});
    await adapter.configureSession({
      capabilities: { 'appium:bundleId': 'com.apple.calculator' },
    });
    assert.deepEqual(adapter.appTarget, { 'appium:bundleId': 'com.apple.calculator' });
    assert.deepEqual(adapter.sessionHints?.capabilities, {});
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
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

test('runtime Android App target drives lifecycle and resource-id namespace', async () => {
  const mock = await mockAppium();
  const session = await createAppiumTestSession(
    {
      environment: { platform: 'android', serverUrl: mock.url, capabilities: {} },
      capabilities: {},
    },
    { 'appium:appPackage': 'com.microsoft.emmx.canary' },
  );
  try {
    assert.equal((session.context.app as { id: string }).id, 'com.microsoft.emmx.canary');
    assert.equal(
      (session.context.app as { resourceId(name: string): string }).resourceId(
        'edge_ntp_scrollview',
      ),
      'id=com.microsoft.emmx.canary:id/edge_ntp_scrollview',
    );
    await session.setup();
  } finally {
    await session.teardown();
    mock.server.close();
  }
  assert.equal(mock.sessionCapabilities[0]?.['appium:appPackage'], 'com.microsoft.emmx.canary');
  assert.equal(mock.deleted(), 1);
});

test('macOS App target relies on Session capabilities instead of unsupported app lifecycle APIs', async () => {
  const mock = await mockAppium();
  const session = await createAppiumTestSession(
    {
      environment: { platform: 'macos', serverUrl: mock.url, capabilities: {} },
      capabilities: {},
    },
    { 'appium:bundleId': 'com.apple.calculator' },
  );
  try {
    await session.setup();
  } finally {
    await session.teardown();
    mock.server.close();
  }
  assert.equal(mock.sessionCapabilities[0]?.['appium:bundleId'], 'com.apple.calculator');
  assert.equal(
    mock.requests.some((request) => request.includes('activate_app')),
    false,
  );
  assert.equal(
    mock.requests.some((request) => request.includes('terminate_app')),
    false,
  );
  assert.equal(mock.deleted(), 1);
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
  const hints = await mkdtemp(path.resolve('artifacts/native-tests/hints-'));
  const previousHints = process.env.MAAT_SESSION_HINTS_DIR;
  const projects = new MaatApi(createDefaultPlatformRegistry(base), base);
  const cases = projects.drafts;
  const root = path.join(base, 'android');
  try {
    process.env.MAAT_SESSION_HINTS_DIR = hints;
    await projects.platforms.select('android');
    await projects.platforms.configureSession({
      serverUrl: mock.url,
      capabilities: { 'appium:deviceName': 'mock', 'appium:appPackage': 'example.welcome' },
    });
    const configure = createPlatformTools(projects).find(
      (tool) => tool.name === 'configure_session',
    )!;
    await configure.execute(
      'update',
      { capabilities: { 'appium:newCommandTimeout': 180 } },
      undefined,
      undefined,
      {} as never,
    );
    assert.ok(projects.platforms.current() instanceof AppiumPlatformAdapter);
    const adapter = projects.platforms.current() as AppiumPlatformAdapter;
    assert.equal(adapter.sessionHints?.serverUrl, mock.url);
    assert.equal(adapter.sessionHints?.capabilities['appium:deviceName'], 'mock');
    const draft = cases.begin({
      id: 'welcome',
      module: 'account/login',
      name: 'Welcome',
      description: 'Welcome is shown',
      objectives: ['Welcome'],
      rootDirectory: root,
    });
    const code = `await expect(driver.$('~welcome')).toHaveText('Welcome');`;
    await cases.recordSuccessfulStep(code, await projects.exploration.executeJavaScript(code), {
      adapterId: 'android',
      bindings: ['driver', 'browser', 'expect', 'display', 'evidence'],
      requirement: projects.platforms.current().runtimeRequirement(),
    });
    draft.steps.push({
      number: 2,
      adapterId: 'android',
      bindings: ['expect'],
      observations: [],
      code: `await expect(1).toBe(2);`,
    });
    await assert.rejects(projects.cases.save(), /Clean validation failed/);
    assert.equal(adapter.runtime.isRunning, true);
    assert.equal(mock.deleted(), 1);
    draft.steps.pop();
    const saved = await projects.cases.save();
    const { readFile } = await import('node:fs/promises');
    const spec = await readFile(saved.testPath, 'utf8');
    assert.match(spec, /createMaatTest/);
    assert.equal(mock.created(), 3);
    assert.equal(mock.deleted(), 3);
    assert.equal(adapter.runtime.isRunning, false);
    assert.equal(saved.testPath, path.join(root, 'cases/account/login/welcome.spec.ts'));
    assert.match(spec, /maat\.step\("Recorded step 001", "android"/);
    assert.doesNotMatch(spec, /node:fs|mkdirSync|writeFileSync|randomUUID|path.resolve/);
    assert.equal(mock.server.listening, true);
    assert.ok(!spec.includes(mock.url));
    assert.equal(await readFile(saved.testPath, 'utf8'), spec);
    const runs = path.resolve('artifacts/maat/runs');
    assert.ok((await readdir(runs)).length > 0);
  } finally {
    if (previousHints === undefined) delete process.env.MAAT_SESSION_HINTS_DIR;
    else process.env.MAAT_SESSION_HINTS_DIR = previousHints;
    await projects.close();
    mock.server.close();
    await rm(base, { recursive: true, force: true });
    await rm(hints, { recursive: true, force: true });
  }
});

test('platform layout is enforced by schema and manager, not model naming', async () => {
  const projects = new MaatApi(createDefaultPlatformRegistry(), path.resolve('maat-tests'));
  await assert.rejects(projects.platforms.select('iphone-calculator'), /Unknown platform/);
  assert.equal(projects.platforms.current().id, 'web');
  for (const platform of ['web', 'android', 'ios', 'macos'])
    assert.equal(platformRoot('maat-tests', platform), path.resolve('maat-tests', platform));
  assert.throws(() => platformRoot('maat-tests', '../escape'));
  assert.throws(() => casePath('/root/ios', '../escape'));
  assert.throws(() => casePath('/root/ios', 'case', '../escape'));
  const tools = createPlatformTools(projects);
  assert.equal(
    tools.find((tool) => tool.name === 'select_platform')!.parameters.properties.platform.type,
    'string',
  );
  const caseTools = createCaseTools(projects);
  assert.equal(
    caseTools.find((tool) => tool.name === 'begin_case')!.parameters.properties.rootDirectory,
    undefined,
  );
  assert.ok(
    createMaatResourceOptions([]).systemPrompt.includes(
      'maat-tests/<owner-platform>/cases/<module>/<case-id>.spec.ts',
    ),
  );
});
