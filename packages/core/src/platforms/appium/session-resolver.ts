import { discoverDevices, matchDevices, type Device } from '../../setup/devices.ts';
import { connection, type NativeEnvironment, type ResolvedNativeSession } from './schema.ts';

export type SessionIssueCode =
  | 'server-unavailable'
  | 'no-device'
  | 'multiple-devices'
  | 'configured-device-unavailable';
export class SessionSetupError extends Error {
  readonly code: SessionIssueCode;
  readonly details: Record<string, unknown>;
  constructor(code: SessionIssueCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function isLocal(url: string): boolean {
  const host = new URL(url).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export type SessionResolverDependencies = {
  serverReady(url: string): Promise<boolean>;
  discoverDevices(platform: NativeEnvironment['platform']): Promise<Device[]>;
};

async function defaultServerReady(url: string): Promise<boolean> {
  try {
    const endpoint = new URL(url);
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/status`;
    const status = endpoint;
    const response = await fetch(status, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

const defaults: SessionResolverDependencies = { serverReady: defaultServerReady, discoverDevices };

export async function resolveAppiumSession(
  environment: NativeEnvironment,
  dependencies: SessionResolverDependencies = defaults,
): Promise<ResolvedNativeSession> {
  const configuredUrl = environment.serverUrl;
  const candidates = [
    ...new Set(
      [configuredUrl, 'http://127.0.0.1:4723/'].filter((value): value is string => Boolean(value)),
    ),
  ];
  let serverUrl: string | undefined;
  const notices: string[] = [];
  for (const candidate of candidates) {
    connection(candidate);
    if (await dependencies.serverReady(candidate)) {
      serverUrl = candidate;
      break;
    }
  }
  if (!serverUrl)
    throw new SessionSetupError(
      'server-unavailable',
      `No Appium server responded. Tried: ${candidates.join(', ')}`,
      { candidates },
    );
  if (configuredUrl && serverUrl !== configuredUrl)
    notices.push(`Configured Appium server ${configuredUrl} was unavailable; using ${serverUrl}.`);

  const resolvedEnvironment = { ...environment, serverUrl };
  if (!environment.device && environment.capabilities['appium:deviceName'])
    return {
      environment: resolvedEnvironment,
      capabilities: { ...environment.capabilities },
      notices,
    };
  if (!isLocal(serverUrl)) {
    throw new SessionSetupError(
      'no-device',
      'Remote Appium requires a deviceName or another provider-specific routing capability.',
    );
  }

  const available = await dependencies.discoverDevices(environment.platform);
  let matches = matchDevices(available, environment.device);
  if (!matches.length && environment.device) {
    if (available.length === 1) {
      matches = available;
      notices.push(
        `Configured device ${JSON.stringify(environment.device)} was unavailable; using the only online device ${available[0]!.name}.`,
      );
    } else
      throw new SessionSetupError(
        'configured-device-unavailable',
        `Configured device ${JSON.stringify(environment.device)} is unavailable.`,
        { available },
      );
  }
  if (!environment.device) matches = available;
  if (!matches.length)
    throw new SessionSetupError('no-device', 'No online device is available.', { available });
  if (matches.length > 1)
    throw new SessionSetupError(
      'multiple-devices',
      'Multiple devices are available. Select one by stable kind and name.',
      { available: matches },
    );
  const device: Device = matches[0]!;
  return {
    environment: { ...resolvedEnvironment, device: { kind: device.kind, name: device.name } },
    capabilities: {
      ...environment.capabilities,
      ...(environment.platform === 'macos' ? {} : { 'appium:udid': device.id }),
      'appium:deviceName': device.name,
    },
    notices,
  };
}
