import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const destination = path.join(root, 'dist', 'maat-codex-plugin');
const codexRoot = path.join(root, 'packages', 'codex');
const coreRoot = path.join(root, 'packages', 'core');

execFileSync('npm', ['run', 'build', '--workspace', '@houlianpi/maat-core'], { stdio: 'inherit' });
execFileSync('npm', ['run', 'build', '--workspace', '@houlianpi/maat-codex'], {
  stdio: 'inherit',
});
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const entry of [
  'plugin.json',
  'mcp.json',
  '.codex-plugin',
  '.mcp.json',
  'skills',
  'assets',
  'ui',
  'README.md',
]) {
  await cp(path.join(codexRoot, entry), path.join(destination, entry), { recursive: true });
}
await cp(path.join(root, 'node_modules'), path.join(destination, 'node_modules'), {
  recursive: true,
});
const scope = path.join(destination, 'node_modules', '@houlianpi');
await rm(scope, { recursive: true, force: true });
await mkdir(scope, { recursive: true });
for (const [name, source] of [
  ['maat-core', coreRoot],
  ['maat-codex', codexRoot],
] as const) {
  const target = path.join(scope, name);
  await mkdir(target, { recursive: true });
  await cp(path.join(source, 'dist'), path.join(target, 'dist'), { recursive: true });
  await cp(path.join(source, 'package.json'), path.join(target, 'package.json'));
}
const config = JSON.parse(await readFile(path.join(destination, 'mcp.json'), 'utf8')) as {
  mcpServers: { maat: { args: string[] } };
};
assert.equal(config.mcpServers.maat.args[0], '${PLUGIN_ROOT}/dist/server.js');
config.mcpServers.maat.args = ['${PLUGIN_ROOT}/node_modules/@houlianpi/maat-codex/dist/server.js'];
await Promise.all([
  writeFile(path.join(destination, 'mcp.json'), JSON.stringify(config, null, 2) + '\n'),
  writeFile(
    path.join(destination, '.mcp.json'),
    JSON.stringify({ mcpServers: config.mcpServers }, null, 2) + '\n',
  ),
]);
process.stdout.write(`${destination}\n`);
