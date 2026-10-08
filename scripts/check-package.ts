import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type PackResult = { filename: string; files: Array<{ path: string }> };
type Manifest = {
  bin?: Record<string, string>;
  name?: string;
  version?: string;
  private?: boolean;
  exports?: Record<string, string>;
  pi?: { extensions?: string[] };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const manifest = JSON.parse(await readFile('package.json', 'utf8')) as Manifest;
assert.equal(manifest.name, '@houlianpi/maat');
assert.match(manifest.version ?? '', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.notEqual(manifest.private, true);
assert.equal(manifest.exports?.['./pi'], './dist/hosts/pi/extension.js');
assert.deepEqual(manifest.pi?.extensions, ['./dist/hosts/pi/extension.js']);
assert.equal(manifest.dependencies?.['@wdio/globals'], '9.31.3');
assert.equal(manifest.dependencies?.['@wdio/logger'], '9.29.1');
assert.equal(manifest.dependencies?.['@earendil-works/pi-coding-agent'], undefined);
assert.equal(manifest.peerDependencies?.['@earendil-works/pi-coding-agent'], '*');

execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
const packOutput = JSON.parse(
  execFileSync('npm', ['pack', '--json', '--ignore-scripts'], { encoding: 'utf8' }),
) as PackResult[] | Record<string, PackResult>;
const packed = Array.isArray(packOutput) ? packOutput[0] : Object.values(packOutput)[0];
assert.ok(packed, 'npm pack returned no package.');

try {
  const packedManifest = JSON.parse(
    execFileSync('tar', ['-xOf', packed.filename, 'package/package.json'], { encoding: 'utf8' }),
  ) as Manifest;
  assert.equal(
    packedManifest.bin?.maat,
    'bin/maat.mjs',
    'Published package must expose the maat executable.',
  );
  assert.equal(packedManifest.dependencies?.['@wdio/globals'], '9.31.3');
  assert.equal(packedManifest.dependencies?.['@wdio/logger'], '9.29.1');
  assert.equal(packedManifest.peerDependencies?.['@earendil-works/pi-coding-agent'], '*');
  const files = new Set(packed.files.map((file) => file.path));
  for (const required of [
    'package.json',
    'bin/maat.mjs',
    'dist/api/create-maat.js',
    'dist/hosts/pi/extension.js',
    'dist/hosts/test/fixture.js',
    'dist/core/exploration/worker-host.js',
  ]) {
    assert.ok(files.has(required), `Published package is missing ${required}.`);
  }
  assert.ok(
    ![...files].some(
      (file) =>
        file.startsWith('src/') || file.startsWith('test/') || file.startsWith('maat-tests/'),
    ),
    'Published package must contain compiled output, not source, tests, or generated Cases.',
  );

  const installation = await mkdtemp(path.join(tmpdir(), 'maat-package-'));
  try {
    execFileSync(
      'npm',
      [
        'install',
        '--prefix',
        installation,
        '--ignore-scripts',
        '--legacy-peer-deps',
        '--offline',
        path.resolve(packed.filename),
      ],
      { stdio: 'pipe' },
    );
    const installedRoot = path.join(installation, 'node_modules', '@houlianpi', 'maat');
    const cli = path.join(installedRoot, 'bin', 'maat.mjs');
    const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
    assert.match(help, /Maat - conversational UI verification/);
    assert.throws(
      () => execFileSync(process.execPath, [cli, 'test', '--case', 'does-not-exist']),
      /Unknown Case: does-not-exist/,
    );
    const workerSmoke = `
      import { pathToFileURL } from 'node:url';
      const root = process.argv[1];
      const module = await import(pathToFileURL(root + '/dist/platforms/web/exploration-session.js'));
      const session = await module.createWebExplorationSession({ headless: true });
      try {
        const result = await session.execute("await page.setContent('<h1>installed</h1>'); console.log(await page.textContent('h1'));");
        if (result[0]?.type !== 'text' || result[0].text !== 'installed') throw new Error('Installed Worker smoke failed.');
      } finally {
        await session.close();
      }
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', workerSmoke, installedRoot], {
      stdio: 'pipe',
    });
  } finally {
    await rm(installation, { recursive: true, force: true });
  }
  process.stdout.write(
    `Package verified: ${manifest.name}@${manifest.version} (${files.size} files)\n`,
  );
} finally {
  await rm(path.resolve(packed.filename), { force: true });
}
