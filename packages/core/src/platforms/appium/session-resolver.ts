import {
  discoverDevices,
  discoverAndroidReadinessDevices,
  assertAndroidColdReadiness,
  matchDevices,
  type Device,
} from '../../setup/devices.ts';
import type { Socket } from 'node:net';
import { isRecord } from '../../core/exploration/protocol.ts';
import { connection, type NativeEnvironment, type ResolvedNativeSession } from './schema.ts';
import {
  assertIosColdReadiness,
  discoverIosDevices,
  matchIosDevices,
  type IosDevice,
} from '../../setup/ios-devices.ts';
import { defaultFetchStatus } from '../../setup-assistant/probes.ts';
import { resolveIosWdaReuse } from '../../setup/ios-wda.ts';

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

export function isLocalAppiumEndpoint(url: string): boolean {
  const host = new URL(url).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export type SessionResolverDependencies = {
  serverReady(url: string, signal?: AbortSignal): Promise<boolean>;
  discoverDevices(platform: NativeEnvironment['platform'], signal?: AbortSignal): Promise<Device[]>;
};

async function defaultServerReady(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const endpoint = new URL(url);
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/status`;
    const status = endpoint;
    const response = await fetch(status, {
      signal: AbortSignal.any([AbortSignal.timeout(3_000), ...(signal ? [signal] : [])]),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const defaults: SessionResolverDependencies = { serverReady: defaultServerReady, discoverDevices };

function iosReadinessRouting(environment: NativeEnvironment) {
  const url = environment.serverUrl ?? 'http://127.0.0.1:4723/';
  const endpoint = connection(url);
  const nested = environment.capabilities['appium:options'];
  if (nested !== undefined && !isRecord(nested))
    throw new Error(
      'IOS_READINESS_UNSUPPORTED: appium:options must be an object; no Session was created.',
    );
  const caps = {
    ...environment.capabilities,
    ...(isRecord(nested)
      ? Object.fromEntries(
          Object.entries(nested).map(([key, value]) => [
            key.startsWith('appium:') ? key : `appium:${key}`,
            value,
          ]),
        )
      : {}),
  };
  const connectionBooleans: Record<string, boolean> = {
    'appium:useNewWDA': false,
    'appium:usePrebuiltWDA': true,
    'appium:usePreinstalledWDA': false,
    'appium:autoAcceptAlerts': false,
    'appium:autoDismissAlerts': false,
    'appium:prebuildWDA': false,
    'appium:useSimpleBuildTest': false,
    'appium:useXctestrunFile': false,
    'appium:allowProvisioningUpdates': false,
    'appium:allowProvisioningDeviceRegistration': false,
    'appium:launchWithIDB': false,
    'appium:autoWebview': false,
  };
  const alternateInputs = [
    'agentPath',
    'bootstrapPath',
    'xcodeConfigFile',
    'prebuiltWDAPath',
    'keychainPath',
    'keychainPassword',
    'wdaBindingIP',
    'initialDeeplinkUrl',
    'safariInitialUrl',
    'app',
    'appPackage',
    'appActivity',
    'bundleId',
  ];
  if (
    environment.platform !== 'ios' ||
    !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(endpoint.hostname!) ||
    (environment.device?.kind !== undefined && environment.device.kind !== 'device') ||
    caps['appium:webDriverAgentUrl'] !== undefined ||
    (caps['appium:wdaBaseUrl'] !== undefined && caps['appium:wdaBaseUrl'] !== 'http://localhost') ||
    (caps['appium:automationName'] !== undefined && caps['appium:automationName'] !== 'XCUITest') ||
    caps['appium:updatedWDABundleIdSuffix'] !== undefined ||
    Object.entries(connectionBooleans).some(
      ([key, expected]) => caps[key] !== undefined && caps[key] !== expected,
    ) ||
    alternateInputs.some((key) => caps[`appium:${key}`] !== undefined) ||
    (caps.browserName !== undefined && caps.browserName !== '') ||
    (caps['appium:browserName'] !== undefined && caps['appium:browserName'] !== '')
  )
    throw new Error(
      'IOS_READINESS_UNSUPPORTED: connection requires a local physical iPhone and a base Session with device-bound, verified prebuilt WDA. App launch/navigation, automatic builds/signing, alerts and alternate WDA routing or build inputs are not permitted; no configuration was changed.',
    );
  return { url, caps };
}

export async function resolveIosReadinessSession(
  environment: NativeEnvironment,
  signal?: AbortSignal,
  dependencies: {
    serverReady(url: string, signal?: AbortSignal): Promise<boolean>;
    devices(signal?: AbortSignal): Promise<IosDevice[]>;
    checkColdLock(udid: string, signal?: AbortSignal): Promise<void>;
    prepareWda(
      environment: NativeEnvironment,
      allowInstallation: boolean,
      signal?: AbortSignal,
    ): Promise<Record<string, unknown>>;
  } = {
    serverReady: defaultFetchStatus,
    devices: discoverIosDevices,
    checkColdLock: assertIosColdReadiness,
    prepareWda: (environment, allowInstallation, signal) =>
      resolveIosWdaReuse(
        { device: environment.device, capabilities: environment.capabilities, signal },
        allowInstallation,
      ),
  },
  currentTarget?: ResolvedNativeSession,
  allowWdaInstallation = false,
): Promise<ResolvedNativeSession> {
  signal?.throwIfAborted();
  const { url, caps } = iosReadinessRouting(environment);
  const current = currentTarget
    ? iosReadinessRouting({
        ...currentTarget.environment,
        capabilities: currentTarget.capabilities,
      })
    : undefined;
  if (!(await dependencies.serverReady(url, signal)))
    throw new Error(
      'APPIUM_SERVER_UNAVAILABLE: the selected Appium endpoint did not respond; no other service was selected.',
    );
  signal?.throwIfAborted();
  const devices = await dependencies.devices(signal);
  signal?.throwIfAborted();
  const matches = matchIosDevices(devices, environment.device);
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? 'IOS_DEVICE_SELECTION_REQUIRED: select one physical iPhone; no Session was created.'
        : 'IOS_DEVICE_MISSING: the selected iPhone is unavailable; no other device was selected.',
    );
  const device = matches[0]!;
  if (!device.connected || device.paired !== true)
    throw new Error('IOS_DEVICE_UNAVAILABLE: connect and trust the selected iPhone, then recheck.');
  if (device.developerMode !== 'enabled')
    throw new Error(
      'IOS_DEVELOPER_MODE_REQUIRED: confirm Developer Mode on the selected iPhone before connection.',
    );
  if (
    (caps['appium:udid'] !== undefined && caps['appium:udid'] !== device.id) ||
    (caps['appium:deviceName'] !== undefined && caps['appium:deviceName'] !== device.name)
  )
    throw new Error(
      'IOS_READINESS_UNSUPPORTED: capabilities conflict with the selected iPhone; no other device was selected.',
    );
  if (currentTarget && current) {
    if (
      new URL(current.url).href !== new URL(url).href ||
      currentTarget.environment.device?.kind !== 'device' ||
      current.caps['appium:udid'] !== device.id ||
      current.caps['appium:deviceName'] !== device.name
    )
      throw new Error(
        'IOS_READINESS_UNSUPPORTED: the running Session cannot be bound to the selected physical iPhone and endpoint; no Session was rebuilt.',
      );
  }
  let wdaCapabilities: Record<string, unknown> = {};
  if (!currentTarget) {
    await dependencies.checkColdLock(device.id, signal);
    wdaCapabilities = await dependencies.prepareWda(
      {
        ...environment,
        device: { kind: 'device', name: device.name },
        capabilities: { ...caps, 'appium:udid': device.id },
      },
      allowWdaInstallation,
      signal,
    );
  }
  signal?.throwIfAborted();
  const resolvedCapabilities: Record<string, unknown> = {
    ...caps,
    ...wdaCapabilities,
    'appium:udid': device.id,
    'appium:deviceName': device.name,
  };
  delete resolvedCapabilities['appium:options'];
  return {
    environment: { ...environment, serverUrl: url, device: { kind: 'device', name: device.name } },
    capabilities: resolvedCapabilities,
  };
}

/** Shared Android cold execution/readiness: exact local endpoint/selector, no recovery. */
export async function resolveAndroidReadinessSession(
  environment: NativeEnvironment,
  signal?: AbortSignal,
  connectAdb?: () => Socket,
): Promise<ResolvedNativeSession> {
  signal?.throwIfAborted();
  const url = environment.serverUrl ?? 'http://127.0.0.1:4723/';
  connection(url);
  const host = new URL(url).hostname;
  const options = environment.capabilities['appium:options'];
  const caps = {
    ...environment.capabilities,
    ...(isRecord(options)
      ? Object.fromEntries(
          Object.entries(options).map(([key, value]) => [
            key.startsWith('appium:') ? key : `appium:${key}`,
            value,
          ]),
        )
      : {}),
  };
  if (
    environment.platform !== 'android' ||
    !['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) ||
    (!environment.device &&
      (caps['appium:deviceName'] !== undefined || caps['appium:udid'] !== undefined)) ||
    caps['appium:avd'] !== undefined ||
    caps['appium:remoteAdbHost'] !== undefined ||
    (caps['appium:automationName'] !== undefined &&
      caps['appium:automationName'] !== 'UiAutomator2') ||
    (caps['appium:adbPort'] !== undefined && caps['appium:adbPort'] !== 5037) ||
    ['ADB_SERVER_SOCKET', 'ADB_SERVER_PORT', 'ANDROID_ADB_SERVER_PORT'].some(
      (key) => process.env[key] && process.env[key] !== '5037',
    )
  )
    throw new Error(
      'ANDROID_READINESS_COLD_UNSUPPORTED: cold Android execution requires a provable local device on the existing local ADB daemon; remote or ambiguous routing is unsupported. Select the local device and recheck.',
    );
  const resolved = await resolveAppiumSession(
    environment,
    {
      serverReady: (candidate, checkSignal) =>
        candidate === url ? defaultServerReady(candidate, checkSignal) : Promise.resolve(false),
      discoverDevices: async (_platform, checkSignal) => {
        const devices = await discoverAndroidReadinessDevices(checkSignal, connectAdb);
        if (matchDevices(devices, environment.device).length !== 1)
          throw new Error(
            'ANDROID_DEVICE_LOCK_STATE_UNKNOWN: the selected local device is unavailable or ambiguous; no other device was selected. Check the connection then recheck.',
          );
        return devices;
      },
    },
    signal,
  );
  // Nested provider capabilities must not override the identity we just resolved.
  if (
    caps['appium:udid'] !== undefined &&
    caps['appium:udid'] !== resolved.capabilities['appium:udid']
  )
    throw new Error(
      'ANDROID_READINESS_COLD_UNSUPPORTED: cold Android execution cannot prove this Session targets the selected local device.',
    );
  await assertAndroidColdReadiness(resolved, signal, connectAdb);
  return resolved;
}

export async function resolveAppiumSession(
  environment: NativeEnvironment,
  dependencies: SessionResolverDependencies = defaults,
  signal?: AbortSignal,
): Promise<ResolvedNativeSession> {
  signal?.throwIfAborted();
  const configuredUrl = environment.serverUrl;
  const candidates =
    environment.platform === 'ios' && configuredUrl && !isLocalAppiumEndpoint(configuredUrl)
      ? [configuredUrl]
      : [
          ...new Set(
            [configuredUrl, 'http://127.0.0.1:4723/'].filter((value): value is string =>
              Boolean(value),
            ),
          ),
        ];
  let serverUrl: string | undefined;
  const notices: string[] = [];
  for (const candidate of candidates) {
    connection(candidate);
    const ready = await dependencies.serverReady(candidate, signal);
    signal?.throwIfAborted();
    if (ready) {
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
  if (!isLocalAppiumEndpoint(serverUrl)) {
    throw new SessionSetupError(
      'no-device',
      'Remote Appium requires a deviceName or another provider-specific routing capability.',
    );
  }

  const available = await dependencies.discoverDevices(environment.platform, signal);
  signal?.throwIfAborted();
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
