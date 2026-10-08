import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

type PackResult = { filename: string; files: Array<{ path: string }> };
type Manifest = {
  bin?: Record<string, string>;
  name?: string;
  version?: string;
  private?: boolean;
  exports?: Record<string, string>;
  pi?: { extensions?: string[] };
};

const manifest = JSON.parse(await readFile('package.json', 'utf8')) as Manifest;
assert.equal(manifest.name, '@houlianpi/maat');
assert.match(manifest.version ?? '', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.notEqual(manifest.private, true);
assert.equal(manifest.exports?.['./pi'], './src/hosts/pi/extension.ts');
assert.deepEqual(manifest.pi?.extensions, ['./src/hosts/pi/extension.ts']);

const [packed] = JSON.parse(
  execFileSync('npm', ['pack', '--json', '--ignore-scripts'], { encoding: 'utf8' }),
) as PackResult[];
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
  const files = new Set(packed.files.map((file) => file.path));
  for (const required of [
    'package.json',
    'bin/maat.mjs',
    'src/api/create-maat.ts',
    'src/hosts/pi/extension.ts',
    'src/hosts/test/fixture.ts',
  ]) {
    assert.ok(files.has(required), `Published package is missing ${required}.`);
  }
  assert.ok(
    ![...files].some((file) => file.startsWith('test/') || file.startsWith('maat-tests/')),
    'Published package must not contain repository tests or generated Cases.',
  );
  process.stdout.write(
    `Package verified: ${manifest.name}@${manifest.version} (${files.size} files)\n`,
  );
} finally {
  await rm(path.resolve(packed.filename), { force: true });
}
