import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname } from 'node:os';
import type { NativePlatform, NativeTarget } from './config.ts';
const exec = promisify(execFile);
export type Device = { id: string; name: string; kind: string };

export function parseAndroidDevices(text: string): Device[] {
  return text.split('\n').flatMap(line => {
    const match = /^(\S+)\s+device(?:\s+(.*))?$/.exec(line);
    if (!match || match[1] === 'List') return [];
    return [{ id: match[1], name: /model:(\S+)/.exec(match[2] ?? '')?.[1] ?? match[1], kind: match[1].startsWith('emulator-') ? 'emulator' : 'device' }];
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
  // Offline devices are deliberately excluded. Simulator IDs also work as Appium UDIDs.
  const online = stdout.split('== Devices Offline ==')[0];
  return online.split('\n').flatMap(line => {
    const match = /^(.+?) \(([^)]+)\) \(([A-Fa-f0-9-]{20,})\)$/.exec(line.trim());
    return match ? [{ id: match[3], name: `${match[1]} (${match[2]})`, kind: /Simulator/.test(line) ? 'simulator' : 'device' }] : [];
  });
}

export async function selectDevice(target: NativeTarget): Promise<NativeTarget> {
  if (target.capabilities['appium:udid']) return target;
  if (target.serverUrl) {
    if (target.platform === 'macos' || target.capabilities['appium:deviceName']) return target;
    throw new Error('Remote Appium does not define device discovery. Configure deviceName or udid once for this project.');
  }
  const devices = await discoverDevices(target.platform);
  if (devices.length !== 1) throw new Error(devices.length ? `Choose a device once: ${JSON.stringify(devices)}` : 'No online device. Connect/unlock a device or start a simulator.');
  return { ...target, capabilities: { ...target.capabilities, ...(target.platform === 'macos' ? {} : { 'appium:udid': devices[0].id }), 'appium:deviceName': devices[0].name } };
}
