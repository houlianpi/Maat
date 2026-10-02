import { readFile } from 'node:fs/promises';
import type { remote } from 'webdriverio';

export const nativePlatforms = ['android', 'ios', 'macos'] as const;
export type NativePlatform = typeof nativePlatforms[number];
export type NativeTarget = {
  platform: NativePlatform;
  serverUrl?: string;
  capabilities: Record<string, unknown>;
};
export type Connection = Pick<Parameters<typeof remote>[0], 'hostname' | 'port' | 'path' | 'protocol'>;

export function connection(url: string): Connection {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Appium URL must be an http(s) endpoint without embedded credentials.');
  }
  return { hostname: parsed.hostname, port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
    protocol: parsed.protocol.slice(0, -1) as 'http' | 'https', path: parsed.pathname };
}

export function capabilities(target: NativeTarget) {
  const drivers = { android: ['Android', 'UiAutomator2'], ios: ['iOS', 'XCUITest'], macos: ['Mac', 'Mac2'] };
  const pair = drivers[target.platform];
  if (!pair) throw new Error('Unsupported native platform.');
  const caps = target.capabilities;
  if (caps.platformName && caps.platformName !== pair[0]) throw new Error('platformName conflicts with project platform.');
  if (caps['appium:automationName'] && caps['appium:automationName'] !== pair[1]) throw new Error('automationName conflicts with project platform.');
  return {
    'appium:noReset': true, 'appium:fullReset': false, 'appium:newCommandTimeout': 120,
    ...caps, platformName: pair[0], 'appium:automationName': pair[1],
  };
}

export async function readNativeTarget(file: string): Promise<NativeTarget> {
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (!value || !nativePlatforms.includes(value.platform) || typeof value.capabilities !== 'object' || !value.capabilities || Array.isArray(value.capabilities)) {
    throw new Error('Native target needs platform and a capabilities object.');
  }
  if (value.serverUrl !== undefined) connection(value.serverUrl);
  capabilities(value);
  return value;
}
