import { readFile } from 'node:fs/promises';
import type { remote } from 'webdriverio';

export const nativePlatforms = ['android', 'ios', 'macos'] as const;
export type NativePlatform = (typeof nativePlatforms)[number];
export const nativeDeviceKinds = ['device', 'simulator', 'emulator', 'host'] as const;
export type NativeDeviceKind = (typeof nativeDeviceKinds)[number];
export type NativeDeviceSelector = { kind?: NativeDeviceKind; name?: string };
export type NativeEnvironment = {
  platform: NativePlatform;
  serverUrl?: string;
  device?: NativeDeviceSelector;
  capabilities: Record<string, unknown>;
};
export type NativeAppTarget = Partial<
  Record<'appium:bundleId' | 'appium:appPackage' | 'appium:appActivity' | 'appium:app', string>
>;
export type ResolvedNativeSession = {
  environment: NativeEnvironment;
  capabilities: Record<string, unknown>;
  app?: NativeAppTarget;
  notices?: string[];
};
export type Connection = Pick<
  Parameters<typeof remote>[0],
  'hostname' | 'port' | 'path' | 'protocol'
>;

const legacyAppCapabilities: Record<string, keyof NativeAppTarget> = {
  bundleId: 'appium:bundleId',
  appPackage: 'appium:appPackage',
  appActivity: 'appium:appActivity',
  app: 'appium:app',
};
const standardWebDriverCapabilities = new Set([
  'acceptInsecureCerts',
  'browserName',
  'browserVersion',
  'pageLoadStrategy',
  'platformName',
  'proxy',
  'setWindowRect',
  'timeouts',
  'unhandledPromptBehavior',
  'webSocketUrl',
]);

function normalizeCapabilities(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  for (const [legacy, standard] of Object.entries(legacyAppCapabilities)) {
    if (normalized[legacy] !== undefined) {
      normalized[standard] ??= normalized[legacy];
      delete normalized[legacy];
    }
  }
  const unsupported = Object.keys(normalized).filter(
    (key) =>
      !key.includes(':') && !standardWebDriverCapabilities.has(key) && key !== 'automationName',
  );
  if (unsupported.length) {
    throw new Error(
      `Unsupported unprefixed Appium capabilities: ${unsupported.join(', ')}. Use W3C vendor-prefixed names such as appium:${unsupported[0]}.`,
    );
  }
  return normalized;
}

export function connection(url: string): Connection {
  const parsed = new URL(url);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Appium URL must be an http(s) endpoint without embedded credentials.');
  }
  return {
    hostname: parsed.hostname,
    port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
    protocol: parsed.protocol.slice(0, -1) as 'http' | 'https',
    path: parsed.pathname,
  };
}

export function capabilities(target: NativeEnvironment | ResolvedNativeSession) {
  const environment = 'environment' in target ? target.environment : target;
  const drivers = {
    android: ['Android', 'UiAutomator2'],
    ios: ['iOS', 'XCUITest'],
    macos: ['Mac', 'Mac2'],
  };
  const pair = drivers[environment.platform];
  if (!pair) throw new Error('Unsupported native platform.');
  const rawCapabilities: Record<string, unknown> = normalizeCapabilities({
    ...target.capabilities,
    ...('app' in target ? target.app : {}),
  });
  if (rawCapabilities.platformName && rawCapabilities.platformName !== pair[0])
    throw new Error('platformName conflicts with project platform.');
  if (rawCapabilities.automationName && rawCapabilities.automationName !== pair[1])
    throw new Error('automationName conflicts with project platform.');
  if (
    rawCapabilities['appium:automationName'] &&
    rawCapabilities['appium:automationName'] !== pair[1]
  )
    throw new Error('automationName conflicts with project platform.');
  const { platformName: _platformName, automationName: _automationName, ...caps } = rawCapabilities;
  return {
    'appium:noReset': true,
    'appium:fullReset': false,
    'appium:newCommandTimeout': 120,
    ...caps,
    platformName: pair[0],
    'appium:automationName': pair[1],
  };
}

export async function readNativeEnvironment(file: string): Promise<NativeEnvironment> {
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (
    !value ||
    !nativePlatforms.includes(value.platform) ||
    typeof value.capabilities !== 'object' ||
    !value.capabilities ||
    Array.isArray(value.capabilities)
  ) {
    throw new Error('Native target needs platform and a capabilities object.');
  }
  if (value.serverUrl !== undefined) connection(value.serverUrl);
  if (
    value.device !== undefined &&
    (!value.device ||
      typeof value.device !== 'object' ||
      Array.isArray(value.device) ||
      (value.device.kind !== undefined && !nativeDeviceKinds.includes(value.device.kind)) ||
      (value.device.name !== undefined &&
        (typeof value.device.name !== 'string' || !value.device.name.trim())))
  ) {
    throw new Error('Native target device must contain an optional kind and nonempty name.');
  }
  const split = splitCapabilities(value.capabilities);
  const environment = { ...value, capabilities: split.environment };
  capabilities(environment);
  return environment;
}

export function splitCapabilities(input: Record<string, unknown>): {
  environment: Record<string, unknown>;
  app: NativeAppTarget;
} {
  input = normalizeCapabilities(input);
  const appKeys = new Set([
    'appium:bundleId',
    'appium:appPackage',
    'appium:appActivity',
    'appium:app',
  ]);
  const app = Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) => appKeys.has(key) && typeof value === 'string' && value.trim(),
    ),
  ) as NativeAppTarget;
  const derived = new Set([
    'appium:udid',
    'platformName',
    'automationName',
    'appium:automationName',
  ]);
  const environment = Object.fromEntries(
    Object.entries(input).filter(([key]) => !appKeys.has(key) && !derived.has(key)),
  );
  return { environment, app };
}
