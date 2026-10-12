import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type PackResult = { filename: string; files: Array<{ path: string }> };
type Manifest = {
  dependencies?: Record<string, string>;
  name: string;
  peerDependencies?: Record<string, string>;
  pi?: { extensions?: string[]; skills?: string[] };
  version: string;
  exports?: Record<string, string>;
};

const workspaces = ['@houlianpi/maat-core', '@houlianpi/maat-pi', '@houlianpi/maat'] as const;
const manifests = new Map<string, Manifest>();
const rootManifest = JSON.parse(await readFile('package.json', 'utf8')) as Manifest;
for (const directory of ['packages/core', 'packages/pi', 'packages/maat']) {
  const manifest = JSON.parse(
    await readFile(path.join(directory, 'package.json'), 'utf8'),
  ) as Manifest;
  manifests.set(manifest.name, manifest);
  assert.equal(manifest.version, rootManifest.version);
}
assert.equal(
  manifests.get('@houlianpi/maat-core')?.dependencies?.['@earendil-works/pi-coding-agent'],
  undefined,
);
assert.equal(
  manifests.get('@houlianpi/maat-pi')?.dependencies?.['@earendil-works/pi-coding-agent'],
  undefined,
);
assert.equal(
  manifests.get('@houlianpi/maat-pi')?.peerDependencies?.['@earendil-works/pi-coding-agent'],
  '*',
);
assert.equal(
  manifests.get('@houlianpi/maat')?.dependencies?.['@earendil-works/pi-coding-agent'],
  '0.87.0',
);
assert.equal(manifests.get('@houlianpi/maat-core')?.exports?.['./test'], undefined);
for (const name of ['mocha', 'tsx'])
  assert.equal(manifests.get('@houlianpi/maat-core')?.dependencies?.[name], undefined);
assert.equal(manifests.get('@houlianpi/maat')?.dependencies?.tsx, undefined);

execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
const tarballs: string[] = [];
try {
  for (const workspace of workspaces) {
    const raw = JSON.parse(
      execFileSync('npm', ['pack', '--workspace', workspace, '--json', '--ignore-scripts'], {
        encoding: 'utf8',
      }),
    ) as PackResult[] | Record<string, PackResult>;
    const packed = Array.isArray(raw) ? raw[0] : Object.values(raw)[0];
    assert.ok(packed, `npm pack returned no package for ${workspace}.`);
    tarballs.push(path.resolve(packed.filename));
    const files = new Set(packed.files.map((file) => file.path));
    assert.ok(files.has('package.json'));
    assert.ok([...files].some((file) => file.startsWith('dist/')));
    assert.ok(![...files].some((file) => file.startsWith('src/')));
    assert.ok(
      ![...files].some((file) =>
        /^dist\/(?:core\/(?:cases|testing)\/|test\/|work-mode\.|tools\/case-tools\.|cli\/cases\.|agent\/(?:run-recorder|replay-generator)\.|platforms\/(?:web|appium)\/test-session\.)/.test(
          file,
        ),
      ),
      'Packed package contains removed test, mode or Replay code.',
    );
    assert.ok(
      !files.has('dist/setup/browser-discovery.js'),
      'Packed package contains the test-only browser executable helper.',
    );
    if (workspace === '@houlianpi/maat-pi') {
      assert.ok(files.has('skills/maat-setup/SKILL.md'), 'Packed Pi setup Skill is missing.');
      assert.ok(files.has('skills/mobile-use/SKILL.md'), 'Packed Pi Mobile Use Skill is missing.');
      assert.ok(
        files.has('skills/maat-setup/scripts/android-tools.mjs'),
        'Packed Android preparation script is missing.',
      );
    }
  }

  const installation = await mkdtemp(path.join(tmpdir(), 'maat-workspaces-'));
  const piInstallation = await mkdtemp(path.join(tmpdir(), 'maat-pi-host-'));
  const emptyProject = await mkdtemp(path.join(tmpdir(), 'maat-empty-'));
  try {
    execFileSync(
      'npm',
      ['install', '--prefix', installation, '--ignore-scripts', '--legacy-peer-deps', ...tarballs],
      { stdio: 'pipe' },
    );
    const modules = path.join(installation, 'node_modules');
    const coreRoot = path.join(modules, '@houlianpi', 'maat-core');
    const maatRoot = path.join(modules, '@houlianpi', 'maat');
    const installedPiRoot = path.join(modules, '@houlianpi', 'maat-pi');
    const cli = path.join(maatRoot, 'bin', 'maat.mjs');
    assert.match(
      execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }),
      /Maat - UI execution for Coding Agents/,
    );
    for (const command of ['test', 'cases', 'replay']) {
      const removed = spawnSync(process.execPath, [cli, command], { encoding: 'utf8' });
      assert.equal(removed.status, 1);
      assert.match(removed.stderr, new RegExp('Unknown command: ' + command));
    }

    const workerSmoke = `
      import { pathToFileURL } from 'node:url';
      const core = await import(pathToFileURL(process.argv[1] + '/dist/index.js'));
      const maat = core.createMaat({ workspaceRoot: process.cwd() });
      try {
        if (typeof core.resolveAndroidTools !== 'function' || typeof core.prepareAndroidTools !== 'function')
          throw new Error('Installed Core Android tool APIs are missing');
        if (typeof core.detectIosSetup !== 'function')
          throw new Error('Installed Core iOS setup API is missing');
        if (typeof core.inspectIosWda !== 'function' || typeof core.prepareIosWda !== 'function')
          throw new Error('Installed Core signing-aware preparation APIs are missing');
        const ios = await core.detectIosSetup({}, {
          hostPlatform: 'linux',
          command: async () => { throw new Error('Unsupported host must not run setup commands'); },
          fetchStatus: async () => { throw new Error('Unsupported host must not probe Appium'); },
          devices: async () => { throw new Error('Unsupported host must not discover devices'); },
        });
        if (ios.canContinue || ios.capabilities[0]?.errorCode !== 'IOS_HOST_UNSUPPORTED')
          throw new Error('Installed iOS setup did not report the unsupported host');
        for (const name of ['saveCase', 'runMaatTests', 'CaseDraftManager'])
          if (name in core) throw new Error('Removed Core export remains: ' + name);
        for (const name of ['cases', 'drafts', 'tests', 'evidence'])
          if (name in maat) throw new Error('Removed Core API remains: ' + name);
        await maat.platforms.configure({ browser: 'chromium', headless: true });
        const result = await maat.exploration.executeJavaScript("await page.setContent('<h1>installed</h1>'); console.log(await page.textContent('h1')); display(await page.screenshot());");
        if (result[0]?.type !== 'text' || result[0].text !== 'installed') throw new Error('Worker smoke failed');
        if (result[1]?.type !== 'image' || result[1].mimeType !== 'image/png' || !result[1].data)
          throw new Error('Installed Worker screenshot observation failed');
      } finally { await maat.close(); }
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', workerSmoke, coreRoot], {
      stdio: 'pipe',
    });
    const noSdkEnvironment = { ...process.env };
    delete noSdkEnvironment.ANDROID_HOME;
    delete noSdkEnvironment.ANDROID_SDK_ROOT;
    const androidStatus = JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(installedPiRoot, 'skills', 'maat-setup', 'scripts', 'android-tools.mjs'),
          'status',
        ],
        { cwd: emptyProject, env: noSdkEnvironment, encoding: 'utf8' },
      ),
    ) as { toolchainReady?: unknown; adbAvailable?: unknown; aapt2Available?: unknown };
    assert.equal(typeof androidStatus.toolchainReady, 'boolean');
    assert.equal(typeof androidStatus.adbAvailable, 'boolean');
    assert.equal(typeof androidStatus.aapt2Available, 'boolean');

    // Pi owns its SDK and supplies Extension peers. Test this independently from the
    // standalone package, which intentionally carries its own exact Pi SDK dependency.
    execFileSync(
      'npm',
      [
        'install',
        '--prefix',
        piInstallation,
        '--ignore-scripts',
        '@earendil-works/pi-coding-agent@0.87.0',
        tarballs[0]!,
        tarballs[1]!,
      ],
      { stdio: 'pipe' },
    );
    const piModules = path.join(piInstallation, 'node_modules');
    const piRoot = path.join(piModules, '@houlianpi', 'maat-pi');
    const piManifest = JSON.parse(
      await readFile(path.join(piRoot, 'package.json'), 'utf8'),
    ) as Manifest;
    assert.deepEqual(piManifest.pi?.extensions, ['./dist/extension.js']);
    assert.equal(piManifest.pi?.skills, undefined);
    const extensionSmoke = `
      import { pathToFileURL } from 'node:url';
      import { realpath } from 'node:fs/promises';
      const api = await import(pathToFileURL(process.argv[1] + '/dist/index.js'));
      const extension = api.maatPiExtension;
      const sdk = await import(pathToFileURL(process.argv[2] + '/dist/index.js'));
      const skills = sdk.loadSkillsFromDir({ dir: process.argv[1] + '/skills', source: 'installed-maat' });
      if (skills.diagnostics.length || skills.skills.map((skill) => skill.name).join(',') !== 'maat-setup,mobile-use')
        throw new Error('Installed Pi Skills were not discovered');
      if (await realpath(skills.skills[0].filePath) !== await realpath(api.MAAT_SETUP_SKILL_PATH) ||
          await realpath(skills.skills[1].filePath) !== await realpath(api.MAAT_MOBILE_USE_SKILL_PATH))
        throw new Error('Installed Skill path points outside the package');
      const tools = []; const commands = []; const handlers = new Map();
      const definitions = new Map();
      let mobileEnabled = false;
      const pi = {
        registerFlag(name, options) {
          if (name !== 'maat-mobile-ui' || options.description !== 'Compact Maat tool cards and concise status' ||
              options.type !== 'boolean' || options.default !== false)
            throw new Error('Installed compact UI flag contract is incorrect');
        },
        getFlag(name) {
          if (name !== 'maat-mobile-ui') throw new Error('Unexpected flag lookup: ' + name);
          return mobileEnabled;
        },
        registerMessageRenderer() {},
        registerTool(tool) { tools.push(tool.name); definitions.set(tool.name, tool); },
        registerCommand(name) { commands.push(name); },
        on(event, handler) {
          const listeners = handlers.get(event) ?? [];
          listeners.push(handler);
          handlers.set(event, listeners);
          return () => {};
        },
      };
      const emit = async (event, payload, context) => {
        let result;
        for (const handler of handlers.get(event) ?? []) {
          const value = await handler(payload, context);
          if (value !== undefined) result = value;
        }
        return result;
      };
      extension(pi);
      for (const name of ['check_platform_setup', 'check_device_ready', 'prepare_mobile', 'open_setup_step', 'retry_setup_step', 'continue_without_capability'])
        if (!tools.includes(name)) throw new Error('Installed extension missing tool: ' + name);
      for (const name of ['begin_case', 'save_case', 'list_evidence', 'set_work_mode'])
        if (tools.includes(name)) throw new Error('Installed extension contains removed tool: ' + name);
      if (commands.includes('mode') || handlers.has('user_bash'))
        throw new Error('Installed extension contains removed work-mode policy');
      if (commands.join(',') !== 'maat-setup')
        throw new Error('Installed extension should register only maat-setup');
      if (definitions.get('exe_js').renderCall)
        throw new Error('Installed compact UI must remain opt-in');
      mobileEnabled = true;
      const mobileContext = { mode: 'print', sessionManager: {
        getEntries() { return [{ type: 'message', message: { role: 'user', content: '请检查手机' } }]; }
      } };
      await emit('session_start', { reason: 'startup' }, mobileContext);
      const promptResult = await emit('before_agent_start', { systemPrompt: 'original prompt' }, mobileContext);
      if (!promptResult.systemPrompt.startsWith('original prompt'))
        throw new Error('Installed extension lost the host prompt');
      for (const tool of definitions.values())
        if (typeof tool.renderCall !== 'function' || typeof tool.renderResult !== 'function' || tool.renderShell !== 'self')
          throw new Error('Installed compact renderer missing: ' + tool.name);
      sdk.initTheme('dark');
      const platforms = definitions.get('list_platforms');
      const platformResult = await platforms.execute('platforms', {}, undefined, undefined, { mode: 'print' });
      const card = new sdk.ToolExecutionComponent('list_platforms', 'platforms', {}, { showImages: false },
        platforms, { requestRender() {} }, process.cwd());
      card.setArgsComplete();
      card.markExecutionStarted();
      card.updateResult({ ...platformResult, isError: false }, false);
      const compact = card.render(120).join('\\n');
      if (!compact.includes('Android') || compact.includes('codeContext'))
        throw new Error('Installed compact platform facts are incorrect');
      if (!compact.includes('查看可用平台') || compact.includes('Executing') || compact.includes('执行中'))
        throw new Error('Installed compact card locale/completion is incorrect');
      card.setExpanded(true);
      if (!card.render(120).join('\\n').includes('codeContext'))
        throw new Error('Installed expanded renderer lost model facts');
      await emit('session_shutdown');
    `;
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        extensionSmoke,
        piRoot,
        path.join(piModules, '@earendil-works', 'pi-coding-agent'),
      ],
      {
        cwd: emptyProject,
        env: { ...process.env, NODE_PATH: piModules },
        stdio: 'pipe',
      },
    );

    const setupPersistenceSmoke = `
      import { pathToFileURL } from 'node:url';
      import path from 'node:path';
      const core = await import(pathToFileURL(process.argv[1] + '/dist/index.js'));
      const preferencesFile = path.join(process.argv[2], 'setup.json');
      const fingerprint = { appiumPid: 10, appiumStartedAt: 'now', wdaPid: 20, wdaStartedAt: 'now' };
      const detector = async () => core.aggregateSetup({ platform: 'macos', fingerprint, capabilities: [
        { id: 'appiumServer', status: 'ready', required: true, messageKey: 'capability.appium.ready' },
        { id: 'screenCapture', status: 'action-required', required: false, messageKey: 'capability.screenshot.required', action: { id: 'open-screen-recording', labelKey: 'action.openScreenRecording' } },
      ] });
      const first = new core.SetupAssistant({ preferencesFile, detector });
      await first.check(); await first.action('open-screen-recording');
      const second = new core.SetupAssistant({ preferencesFile, detector });
      const persisted = await second.check();
      if (persisted.capabilities.find((item) => item.id === 'screenCapture')?.status !== 'restart-required')
        throw new Error('Installed Core did not preserve pending Setup action');
    `;
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', setupPersistenceSmoke, coreRoot, emptyProject],
      { cwd: emptyProject, env: { ...process.env, NODE_PATH: modules }, stdio: 'pipe' },
    );

    const dependencyTree = execFileSync(
      'npm',
      ['ls', '--prefix', piInstallation, '@earendil-works/pi-coding-agent', '--all', '--parseable'],
      { encoding: 'utf8' },
    );
    const sdkPaths = dependencyTree
      .trim()
      .split('\n')
      .filter((line) => line.endsWith('/node_modules/@earendil-works/pi-coding-agent'));
    const hostSdk = await realpath(path.join(piModules, '@earendil-works', 'pi-coding-agent'));
    const resolvedSdkPaths = await Promise.all(sdkPaths.map((sdkPath) => realpath(sdkPath)));
    const resolvedPiRoot = await realpath(piRoot);
    assert.ok(
      resolvedSdkPaths.includes(hostSdk),
      `Host Pi SDK missing from: ${resolvedSdkPaths.join(', ')}`,
    );
    assert.ok(
      !resolvedSdkPaths.some((sdkPath) => sdkPath.startsWith(resolvedPiRoot + path.sep)),
      `Pi Extension installed a duplicate SDK: ${resolvedSdkPaths.join(', ')}`,
    );
    assert.match(
      (JSON.parse(await readFile(path.join(hostSdk, 'package.json'), 'utf8')) as Manifest).version,
      /^0\.87\./,
    );
    const piExecutable = path.join(piModules, '.bin', 'pi');
    const piRun = spawnSync(piExecutable, ['--no-extensions', '--extension', piRoot, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', NODE_PATH: piModules },
    });
    assert.equal(piRun.status, 0, piRun.stderr);
    assert.match(piRun.stdout, /pi - AI coding assistant/);
    assert.doesNotMatch(piRun.stderr, /Host-provided extension packages must be declared/);
  } finally {
    await rm(installation, { recursive: true, force: true });
    await rm(piInstallation, { recursive: true, force: true });
    await rm(emptyProject, { recursive: true, force: true });
  }
  process.stdout.write(
    `Verified three Maat ${rootManifest.version} workspace tarballs and installed runtimes.\n`,
  );
} finally {
  for (const tarball of tarballs) await rm(tarball, { force: true });
}
