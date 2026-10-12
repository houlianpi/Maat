import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NativeEnvironment } from '../platforms/appium/schema.ts';
import { discoverDevices, resolveDevice } from './devices.ts';
import { discoverIosDevices } from './ios-devices.ts';
import { assertAdbServerCompatible, resolveAndroidTools } from './android-tools.ts';
import { isRecord } from '../core/exploration/protocol.ts';
import {
  identityFromLocalFact,
  sameDeviceIdentity,
  type DeviceIdentity,
} from '../mobile/contracts/device.ts';
const exec = promisify(execFile);

export async function discoverApplications(
  input: NativeEnvironment,
  query: string,
  dependencies: {
    resolveDevice: typeof resolveDevice;
    resolveAndroidTools: typeof resolveAndroidTools;
    assertAdbServerCompatible: typeof assertAdbServerCompatible;
    discoverDevices?: typeof discoverDevices;
    discoverIosDevices?: typeof discoverIosDevices;
    command(
      file: string,
      args: string[],
      options: { timeout: number },
    ): Promise<{ stdout: string }>;
  } = { resolveDevice, resolveAndroidTools, assertAdbServerCompatible, command: exec },
  exactIdentity?: DeviceIdentity,
) {
  if (input.serverUrl && !input.device)
    throw new Error(
      'Remote installed-app discovery is driver-specific. Supply an app identifier or package path.',
    );
  let target: Awaited<ReturnType<typeof resolveDevice>>;
  if (exactIdentity) {
    const devices =
      input.platform === 'ios'
        ? await (dependencies.discoverIosDevices ?? discoverIosDevices)()
        : await (dependencies.discoverDevices ?? discoverDevices)('android');
    const source = input.platform === 'ios' ? 'local-core-device' : 'local-adb';
    const device = devices.find((candidate) =>
      sameDeviceIdentity(
        exactIdentity,
        identityFromLocalFact({ source, platform: input.platform, device: candidate }),
      ),
    );
    if (!device)
      throw new Error(
        'SELECTED_DEVICE_UNAVAILABLE: the selected phone is unavailable; no other device was used.',
      );
    target = {
      environment: {
        ...input,
        device: { kind: device.kind, name: device.name },
      },
      capabilities: {
        ...input.capabilities,
        'appium:udid': device.id,
        'appium:deviceName': device.name,
      },
    };
  } else {
    target = await dependencies.resolveDevice(input);
  }
  let apps: Array<{ name: string; id: string }> = [];
  if (target.environment.platform === 'android') {
    const tools = await dependencies.resolveAndroidTools();
    if (!tools.adbPath) throw new Error('ADB_MISSING: prepare Android tools before app discovery.');
    await dependencies.assertAdbServerCompatible(tools.adbPath);
    const { stdout } = await dependencies.command(
      tools.adbPath,
      ['-s', String(target.capabilities['appium:udid']), 'shell', 'pm', 'list', 'packages'],
      { timeout: 15_000 },
    );
    apps = stdout
      .split('\n')
      .filter((line) => line.startsWith('package:'))
      .map((line) => ({ name: line.slice(8).trim(), id: line.slice(8).trim() }));
  } else if (target.environment.platform === 'ios') {
    if (target.environment.device?.kind === 'simulator') {
      const { stdout } = await dependencies.command(
        'xcrun',
        ['simctl', 'listapps', String(target.capabilities['appium:udid'])],
        { timeout: 20_000 },
      );
      const identifiers = [...stdout.matchAll(/^\s*"([^"]+)" =/gm)].map((match) => match[1]!);
      apps = identifiers.map((id) => ({ name: id, id }));
    } else {
      const dir = await mkdtemp(path.join(tmpdir(), 'maat-app-list-'));
      try {
        const file = path.join(dir, 'apps.json');
        await dependencies.command(
          'xcrun',
          [
            'devicectl',
            'device',
            'info',
            'apps',
            '--include-default-apps',
            '--device',
            String(target.capabilities['appium:udid']),
            '--json-output',
            file,
          ],
          { timeout: 20_000 },
        );
        const result: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (!isRecord(result) || !isRecord(result.result) || !Array.isArray(result.result.apps))
          throw new Error(
            'IOS_APP_DISCOVERY_FAILED: CoreDevice returned an invalid installed-app list.',
          );
        apps = result.result.apps.map((app: unknown) => {
          if (
            !isRecord(app) ||
            typeof app.name !== 'string' ||
            typeof app.bundleIdentifier !== 'string' ||
            !app.name.trim() ||
            !app.bundleIdentifier.trim()
          )
            throw new Error('IOS_APP_DISCOVERY_FAILED: CoreDevice returned invalid App metadata.');
          return { name: app.name, id: app.bundleIdentifier };
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  } else {
    for (const folder of ['/Applications', '/System/Applications']) {
      for (const entry of await readdir(folder)) {
        if (!entry.endsWith('.app')) continue;
        const { stdout } = await exec('/usr/libexec/PlistBuddy', [
          '-c',
          'Print :CFBundleIdentifier',
          path.join(folder, entry, 'Contents/Info.plist'),
        ]).catch(() => ({ stdout: '' }));
        if (stdout.trim()) apps.push({ name: entry.slice(0, -4), id: stdout.trim() });
      }
    }
  }
  return apps.filter((app) => `${app.name} ${app.id}`.toLowerCase().includes(query.toLowerCase()));
}
