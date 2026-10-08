import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type PackResult = { filename: string; files: Array<{ path: string }> };
type Manifest = {
  dependencies?: Record<string, string>;
  name: string;
  peerDependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
  version: string;
};

const workspaces = ['@houlianpi/maat-core', '@houlianpi/maat-pi', '@houlianpi/maat'] as const;
const manifests = new Map<string, Manifest>();
for (const directory of ['packages/core', 'packages/pi', 'packages/maat']) {
  const manifest = JSON.parse(
    await readFile(path.join(directory, 'package.json'), 'utf8'),
  ) as Manifest;
  manifests.set(manifest.name, manifest);
  assert.equal(manifest.version, '0.2.0');
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
  }

  const installation = await mkdtemp(path.join(tmpdir(), 'maat-workspaces-'));
  const emptyProject = await mkdtemp(path.join(tmpdir(), 'maat-empty-'));
  try {
    execFileSync(
      'npm',
      ['install', '--prefix', installation, '--ignore-scripts', '--legacy-peer-deps', ...tarballs],
      { stdio: 'pipe' },
    );
    const modules = path.join(installation, 'node_modules');
    const coreRoot = path.join(modules, '@houlianpi', 'maat-core');
    const piRoot = path.join(modules, '@houlianpi', 'maat-pi');
    const maatRoot = path.join(modules, '@houlianpi', 'maat');
    const cli = path.join(maatRoot, 'bin', 'maat.mjs');
    assert.match(
      execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }),
      /Maat - conversational UI verification/,
    );
    assert.throws(
      () => execFileSync(process.execPath, [cli, 'test', '--case', 'missing']),
      /Unknown Case/,
    );

    const workerSmoke = `
      import { pathToFileURL } from 'node:url';
      const core = await import(pathToFileURL(process.argv[1] + '/dist/index.js'));
      const maat = core.createMaat({ workspaceRoot: process.cwd() });
      try {
        await maat.platforms.configure({ browser: 'chromium', headless: true });
        const result = await maat.exploration.executeJavaScript("await page.setContent('<h1>installed</h1>'); console.log(await page.textContent('h1'));");
        if (result[0]?.type !== 'text' || result[0].text !== 'installed') throw new Error('Worker smoke failed');
      } finally { await maat.close(); }
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', workerSmoke, coreRoot], {
      stdio: 'pipe',
    });

    const saveSmoke = `
      import { pathToFileURL } from 'node:url';
      const core = await import(pathToFileURL(process.argv[1] + '/dist/index.js'));
      const root = process.argv[2];
      const manager = new core.CaseDraftManager();
      const draft = manager.begin({ id: 'saved-empty', name: 'Saved empty', description: 'Saved from installed Core', objectives: ['Ready'], rootDirectory: root });
      await manager.recordSuccessfulStep("await page.setContent('<h1>Ready</h1>'); await expect(page.locator('h1')).toHaveText('Ready');", [], { adapterId: 'web', bindings: ['page', 'expect'], requirement: { adapterId: 'web', setup: { browser: 'chromium', headless: true } } }, 'Verify ready');
      const saved = await core.saveCase(draft, root);
      console.log(saved.testPath);
    `;
    const generatedRoot = path.join(emptyProject, 'generated-tests', 'web');
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', saveSmoke, coreRoot, generatedRoot],
      { cwd: emptyProject, env: { ...process.env, NODE_PATH: modules }, stdio: 'pipe' },
    );
    execFileSync(
      process.execPath,
      [
        cli,
        'test',
        '--root',
        path.join(emptyProject, 'generated-tests'),
        '--project',
        'web',
        '--case',
        'saved-empty',
        '--browser',
        'chromium',
      ],
      { cwd: emptyProject, env: { ...process.env, NODE_PATH: modules }, stdio: 'pipe' },
    );

    const caseRoot = path.join(emptyProject, 'maat-tests', 'web', 'cases', 'smoke');
    await mkdir(caseRoot, { recursive: true });
    await writeFile(
      path.join(caseRoot, 'empty.spec.ts'),
      `import { afterEach, beforeEach, createMaatTest, describe, it, type MaatTest } from '@houlianpi/maat-core/test';
describe('Installed empty project', () => { let maat: MaatTest; beforeEach(async () => { maat = await createMaatTest('empty', [{ adapterId: 'web', setup: { browser: 'chromium', headless: true } }]); await maat.setup(); }); afterEach(async function () { await maat?.teardown({ passed: this.currentTest?.state === 'passed' }); }); it('empty', async () => { await maat.step('verify', 'web', async ({ page, expect }) => { await page.setContent('<h1>Ready</h1>'); await expect(page.locator('h1')).toHaveText('Ready'); }); }); });
`,
    );
    const caseArgs = [
      cli,
      'test',
      '--root',
      path.join(emptyProject, 'maat-tests'),
      '--project',
      'web',
      '--case',
      'smoke/empty',
      '--browser',
      'chromium',
    ];
    try {
      execFileSync(process.execPath, caseArgs, {
        cwd: emptyProject,
        env: { ...process.env, NODE_PATH: modules },
        stdio: 'pipe',
      });
    } catch (error) {
      const failure = error as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(
        `Installed empty-project Case failed:\n${failure.stdout?.toString() ?? ''}${failure.stderr?.toString() ?? ''}`,
        { cause: error },
      );
    }

    const piManifest = JSON.parse(
      await readFile(path.join(piRoot, 'package.json'), 'utf8'),
    ) as Manifest;
    assert.deepEqual(piManifest.pi?.extensions, ['./dist/extension.js']);
    const piExecutable = path.resolve('node_modules/.bin/pi');
    const piHelp = execFileSync(
      piExecutable,
      ['--no-extensions', '--extension', piRoot, '--help'],
      { encoding: 'utf8', env: { ...process.env, NODE_PATH: modules } },
    );
    assert.match(piHelp, /pi - AI coding assistant/);
    const piRun = spawnSync(
      piExecutable,
      [
        '--no-extensions',
        '--extension',
        piRoot,
        '--offline',
        '--no-session',
        '--mode',
        'json',
        '-p',
        'Reply OK',
      ],
      { encoding: 'utf8', env: { ...process.env, NODE_PATH: modules } },
    );
    assert.equal(piRun.status, 0, piRun.stderr);
    assert.doesNotMatch(piRun.stderr, /Host-provided extension packages must be declared/);
    const toolNames = piRun.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, any>)
      .find((entry) => entry.type === 'message_start')
      ?.message?.toolsAdded?.map((tool: { name: string }) => tool.name);
    for (const tool of ['exe_js', 'list_case_steps', 'save_case', 'set_work_mode'])
      assert.ok(toolNames?.includes(tool), `Pi did not load ${tool}.`);
  } finally {
    await rm(installation, { recursive: true, force: true });
    await rm(emptyProject, { recursive: true, force: true });
  }
  process.stdout.write('Verified three Maat 0.2.0 workspace tarballs and installed runtimes.\n');
} finally {
  for (const tarball of tarballs) await rm(tarball, { force: true });
}
