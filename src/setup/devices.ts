import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname } from 'node:os';
import type { NativeDeviceKind, NativePlatform, NativeEnvironment, ResolvedNativeSession } from '../platforms/appium/schema.ts';
const exec = promisify(execFile);
export type Device = { id: string; name: string; kind: NativeDeviceKind };

export function matchDevices(devices: Device[], selector?: NativeEnvironment['device']): Device[] {
  return devices.filter(device =>
    (!selector?.kind || device.kind === selector.kind) &&
    (!selector?.name || device.name.localeCompare(selector.name, undefined, { sensitivity: 'accent' }) === 0));
}

export function parseAndroidDevices(text: string): Device[] {
  return text.split('\n').flatMap(line => {
    const match = /^(\S+)\s+device(?:\s+(.*))?$/.exec(line);
    if (!match || match[1] === 'List') return [];
    return [{ id: match[1], name: /model:(\S+)/.exec(match[2] ?? '')?.[1] ?? match[1], kind: match[1].startsWith('emulator-') ? 'emulator' : 'device' }];
  });
}

export function parseIosDevices(text: string): Device[] {
  let section = '';
  return text.split('\n').flatMap(line => {
    const heading = /^== (.+) ==$/.exec(line.trim());
    if (heading) { section = heading[1]!; return []; }
    if (section !== 'Devices' && section !== 'Simulators') return [];
    const match = /^(.+?) \(([^)]+)\) \(([A-Fa-f0-9-]{20,})\)$/.exec(line.trim());
    if (!match) return [];
    return [{ id: match[3]!, name: match[1]!.replace(/ Simulator$/, ''), kind: section === 'Simulators' ? 'simulator' as const : 'device' as const }];
  });
}

export async function discoverDevices(platform: NativePlatform): Promise<Device[]> {
  if (platform === 'macos') {
    if (process.platform !== 'darwin') throw new Error('Local macOS automation requires macOS.');
    return [{ id: 'local', name: hostname(), kind: 'host' }];
  }
  if (platform === 'android') return parseAndroidDevices((await exec('adb', ['devices', '-l'], { timeout: 10_000 })).stdout);
  if (process.platform !== 'darwin') throw new Error('Local iOS discovery requires Xcode on macOS.');
  const { stdout } = await exec('xcrun', ['xctrace', 'list', 'devices'], { timeout: 20_000 });
  // Xcode may place the offline section before simulators; parse named sections.
  return parseIosDevices(stdout);
}

export async function resolveDevice(environment: NativeEnvironment): Promise<ResolvedNativeSession> {
  // A stable selector opts into local discovery even when Appium itself is on localhost.
  // Without one, an explicit server URL is treated as externally managed.
  if (environment.serverUrl && !environment.device) {
    if (environment.platform === 'macos' || environment.capabilities['appium:deviceName']) return { environment, capabilities: { ...environment.capabilities } };
    throw new Error('Remote Appium does not define device discovery. Configure deviceName or udid once for this project.');
  }
  const discovered = await discoverDevices(environment.platform);
  const selector = environment.device;
  const devices = matchDevices(discovered, selector);
  if (!devices.length && selector) throw new Error(`No device matches ${JSON.stringify(selector)}. Available: ${JSON.stringify(discovered)}`);
  if (devices.length !== 1) throw new Error(devices.length ? `Choose a device once: ${JSON.stringify(devices)}` : 'No online device. Connect/unlock a device or start a simulator.');
  return { environment, capabilities: { ...environment.capabilities, ...(environment.platform === 'macos' ? {} : { 'appium:udid': devices[0].id }), 'appium:deviceName': devices[0].name } };
}
