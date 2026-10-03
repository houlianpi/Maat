import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NativeEnvironment } from './schema.ts';
import { resolveDevice } from './devices.ts';
const exec = promisify(execFile);

export async function discoverApplications(input: NativeEnvironment, query: string) {
  if (input.serverUrl && !input.device) throw new Error('Remote installed-app discovery is driver-specific. Supply an app identifier or package path.');
  const target = await resolveDevice(input);
  let apps: Array<{ name: string; id: string }> = [];
  if (target.environment.platform === 'android') {
    const { stdout } = await exec('adb', ['-s', String(target.capabilities['appium:udid']), 'shell', 'pm', 'list', 'packages'], { timeout: 15_000 });
    apps = stdout.split('\n').filter(line => line.startsWith('package:')).map(line => ({ name: line.slice(8).trim(), id: line.slice(8).trim() }));
  } else if (target.environment.platform === 'ios') {
    if (target.environment.device?.kind === 'simulator') {
      const { stdout } = await exec('xcrun', ['simctl', 'listapps', String(target.capabilities['appium:udid'])], { timeout: 20_000 });
      const identifiers = [...stdout.matchAll(/^\s*"([^"]+)" =/gm)].map(match => match[1]!);
      apps = identifiers.map(id => ({ name: id, id }));
    } else {
    const dir = await mkdtemp(path.join(tmpdir(), 'maat-app-list-'));
    try {
      const file = path.join(dir, 'apps.json');
      await exec('xcrun', ['devicectl', 'device', 'info', 'apps', '--device', String(target.capabilities['appium:udid']), '--json-output', file], { timeout: 20_000 });
      const result = JSON.parse(await readFile(file, 'utf8'));
      apps = (result.result?.apps ?? []).map((a: { name: string; bundleIdentifier: string }) => ({ name: a.name, id: a.bundleIdentifier }));
    } finally { await rm(dir, { recursive: true, force: true }); }
    }
  } else {
    for (const folder of ['/Applications', '/System/Applications']) {
      for (const entry of await readdir(folder)) {
        if (!entry.endsWith('.app')) continue;
        const { stdout } = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(folder, entry, 'Contents/Info.plist')]).catch(() => ({ stdout: '' }));
        if (stdout.trim()) apps.push({ name: entry.slice(0, -4), id: stdout.trim() });
      }
    }
  }
  return apps.filter(app => `${app.name} ${app.id}`.toLowerCase().includes(query.toLowerCase()));
}
