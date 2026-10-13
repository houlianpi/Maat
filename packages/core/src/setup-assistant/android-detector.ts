import { connect } from 'node:net';
import { connection, nativeDeviceKinds } from '../platforms/appium/schema.ts';
import { resolveAndroidTools, type ResolvedAndroidTools } from '../setup/android-tools.ts';
import { matchDevices, type Device } from '../setup/devices.ts';
import { aggregateSetup } from './model.ts';
import { defaultCommand, defaultFetchStatus, type SetupCommandResult } from './probes.ts';
import type { AndroidSetupCheckInput, SetupCapability, SetupSnapshot } from './types.ts';
import {
  setupReadonlyContextSymbol,
  type InternalSetupCheckInput,
} from '../mobile/integration/readonly.ts';

export { defaultCommand } from './probes.ts';
export type AndroidSetupCommandResult = SetupCommandResult;

export type AndroidSetupDetectorDependencies = {
  command(file: string, args: string[], signal?: AbortSignal): Promise<AndroidSetupCommandResult>;
  fetchStatus(url: string, signal?: AbortSignal): Promise<boolean>;
  /** Query an already running local ADB server; undefined means no server is listening. */
  adbDevices(signal?: AbortSignal): Promise<string | undefined>;
  sdkTools(signal?: AbortSignal): Promise<{
    rootConfigured: boolean;
    rootsConflict?: boolean;
    adbPath?: string;
    aapt2Path?: string;
    source?: ResolvedAndroidTools['source'];
    warnings?: ResolvedAndroidTools['warnings'];
    reason?: string;
  }>;
};

// The ADB CLI's `devices` command can start a daemon. Speak the read-only host protocol instead.
async function defaultAdbDevices(signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: 5037 });
    let data = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () =>
      finish(signal?.reason instanceof Error ? signal.reason : new Error('ADB check aborted.'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(3_000, () => finish(new Error('ADB host query timed out.')));
    socket.on('connect', () => socket.write('000ehost:devices-l'));
    socket.on('error', (error: NodeJS.ErrnoException) =>
      error.code === 'ECONNREFUSED' ? finish() : finish(new Error('ADB host query failed.')),
    );
    socket.on('end', () => finish(new Error('ADB host query returned incomplete data.')));
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 512 * 1024) return finish(new Error('ADB host query exceeded its limit.'));
      if (data.length < 8) return;
      if (data.toString('ascii', 0, 4) !== 'OKAY')
        return finish(new Error('ADB host query was rejected.'));
      const lengthText = data.toString('ascii', 4, 8);
      if (!/^[0-9a-f]{4}$/i.test(lengthText))
        return finish(new Error('Invalid ADB host response.'));
      const length = Number.parseInt(lengthText, 16);
      if (data.length >= length + 8) finish(undefined, data.toString('utf8', 8, length + 8));
    });
    if (signal?.aborted) abort();
  });
}

export async function defaultSdkTools(signal?: AbortSignal, resolveTools = resolveAndroidTools) {
  try {
    const tools = await resolveTools({ signal });
    return {
      rootConfigured: Boolean(tools.sdkRoot),
      adbPath: tools.adbPath,
      aapt2Path: tools.aapt2Path,
      source: tools.source,
      warnings: tools.warnings,
      reason: tools.environment ? 'complete' : 'incomplete',
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ANDROID_SDK_ROOT_CONFLICT' || error.code === 'ANDROID_SDK_INVALID')
    )
      return {
        rootConfigured: true,
        rootsConflict: error.code === 'ANDROID_SDK_ROOT_CONFLICT',
        source: 'environment' as const,
        reason: error.code,
      };
    throw error;
  }
}

const defaults: AndroidSetupDetectorDependencies = {
  command: defaultCommand,
  fetchStatus: defaultFetchStatus,
  adbDevices: defaultAdbDevices,
  sdkTools: defaultSdkTools,
};

function unknown(
  id: 'adb' | 'androidSdk' | 'appiumCli' | 'adbServer' | 'uiautomator2Driver' | 'androidDevice',
  required = true,
): SetupCapability {
  const keys = {
    adb: 'capability.adb.unknown',
    androidSdk: 'capability.androidSdk.unknown',
    appiumCli: 'capability.appiumCli.unknown',
    adbServer: 'capability.adbServer.unknown',
    uiautomator2Driver: 'capability.uiautomator2.unknown',
    androidDevice: 'capability.androidDevice.unknown',
  } as const;
  return {
    id,
    required,
    status: 'unknown',
    messageKey: keys[id],
    ...(required
      ? {
          errorCode: 'ANDROID_SETUP_CHECK_FAILED' as const,
          action: { id: 'recheck' as const, labelKey: 'action.recheck' as const },
        }
      : {}),
  };
}

function devices(text: string): Array<Device & { status: 'device' | 'unauthorized' | 'offline' }> {
  return text.split('\n').flatMap((line) => {
    if (!line.trim() || line.startsWith('List of devices attached')) return [];
    const match = /^(\S+)\s+(device|unauthorized|offline)(?:\s+(.*))?$/.exec(line);
    if (!match) throw new Error('Unrecognized ADB device state.');
    return [
      {
        id: match[1]!,
        name: /model:(\S+)/.exec(match[3] ?? '')?.[1] ?? match[1]!,
        kind: match[1]!.startsWith('emulator-') ? ('emulator' as const) : ('device' as const),
        status: match[2] as 'device' | 'unauthorized' | 'offline',
      },
    ];
  });
}

export async function detectAndroidSetup(
  input: AndroidSetupCheckInput = {},
  dependencies: AndroidSetupDetectorDependencies = defaults,
): Promise<SetupSnapshot> {
  input.signal?.throwIfAborted();
  const internalContext = (input as InternalSetupCheckInput)[setupReadonlyContextSymbol];
  const readonlyContext =
    internalContext && !('facade' in internalContext) ? internalContext : undefined;
  const serverUrl = input.serverUrl ?? 'http://127.0.0.1:4723/';
  const endpoint = connection(serverUrl);
  if (
    input.device !== undefined &&
    (!input.device ||
      typeof input.device !== 'object' ||
      Array.isArray(input.device) ||
      (input.device.kind !== undefined && !nativeDeviceKinds.includes(input.device.kind)) ||
      (input.device.name !== undefined &&
        (typeof input.device.name !== 'string' || !input.device.name.trim())))
  )
    throw new Error('Android device selector must contain a valid kind and nonempty name.');
  if (
    input.remoteDeviceConfigured !== undefined &&
    typeof input.remoteDeviceConfigured !== 'boolean'
  )
    throw new Error('Remote Android device routing flag must be a boolean.');
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(endpoint.hostname!);
  const capabilities: SetupCapability[] = [];
  const technicalDetails: Record<string, unknown> = {
    serverScope: local ? 'local' : 'remote',
    preparationOnly: true,
    java: 'APK signing or installation may additionally require Java; not checked for an existing App.',
  };
  const serverReady = readonlyContext
    ? readonlyContext.endpoint.state === 'reachable' &&
      readonlyContext.endpoint.compatibility === 'compatible'
    : await dependencies.fetchStatus(serverUrl, input.signal).catch(() => {
        input.signal?.throwIfAborted();
        return false;
      });
  input.signal?.throwIfAborted();
  capabilities.push(
    serverReady
      ? {
          id: 'appiumServer',
          required: true,
          status: 'ready',
          messageKey: 'capability.appium.ready',
        }
      : {
          id: 'appiumServer',
          required: true,
          status: 'action-required',
          messageKey: 'capability.appium.start',
          errorCode: 'APPIUM_SERVER_UNAVAILABLE',
          action: {
            id: 'start-appium',
            labelKey: 'action.startAppium',
          },
        },
  );
  if (!local) {
    capabilities.push(
      unknown('adb', false),
      unknown('androidSdk', false),
      unknown('appiumCli', false),
      unknown('adbServer', false),
      unknown('uiautomator2Driver', false),
    );
    capabilities.push(
      input.remoteDeviceConfigured
        ? {
            id: 'androidDevice',
            required: true,
            status: 'ready',
            messageKey: 'capability.androidDevice.ready',
            details: { routingConfigured: true, deviceVerified: false },
          }
        : {
            id: 'androidDevice',
            required: true,
            status: 'action-required',
            messageKey: 'capability.androidDevice.select',
            errorCode: 'ANDROID_DEVICE_SELECTION_REQUIRED',
            action: { id: 'select-android-device', labelKey: 'action.selectAndroidDevice' },
          },
    );
    technicalDetails.localChecks = 'not-applicable-to-remote-server';
    return aggregateSetup({ platform: 'android', capabilities, technicalDetails });
  }
  const command = async (file: string, args: string[]) => {
    input.signal?.throwIfAborted();
    try {
      const result = await dependencies.command(file, args, input.signal);
      input.signal?.throwIfAborted();
      return result;
    } catch {
      input.signal?.throwIfAborted();
      return { stdout: '', stderr: '', exitCode: null, failure: 'failed' as const };
    }
  };
  const adb = await command('adb', ['version']);
  const adbReady = adb.exitCode === 0 && /Android Debug Bridge version \d/.test(adb.stdout);
  technicalDetails.adbCheck = adbReady ? 'passed' : (adb.failure ?? 'invalid-output');
  capabilities.push(
    adbReady
      ? {
          id: 'adb',
          required: true,
          status: 'ready',
          messageKey: 'capability.adb.ready',
        }
      : adb.failure === 'not-found'
        ? {
            id: 'adb',
            required: true,
            status: 'action-required',
            messageKey: 'capability.adb.install',
            errorCode: 'ADB_MISSING',
            action: { id: 'install-adb', labelKey: 'action.installAdb' },
          }
        : unknown('adb'),
  );

  try {
    const sdk = await dependencies.sdkTools(input.signal);
    input.signal?.throwIfAborted();
    technicalDetails.sdkRootConfigured = sdk.rootConfigured;
    technicalDetails.sdkRootsConflict = sdk.rootsConflict === true;
    if (sdk.source) technicalDetails.androidToolsSource = sdk.source;
    if (sdk.reason) technicalDetails.androidToolsReason = sdk.reason;
    if (sdk.warnings?.length) technicalDetails.androidToolsWarnings = sdk.warnings;
    technicalDetails.appiumEnvironment =
      'externally-managed; local tools do not verify server environment';
    if (!sdk.rootConfigured || sdk.rootsConflict || !sdk.adbPath || !sdk.aapt2Path) {
      capabilities.push({
        id: 'androidSdk',
        required: true,
        status: 'action-required',
        messageKey: 'capability.androidSdk.required',
        errorCode: 'ANDROID_SDK_REQUIRED',
        action: { id: 'configure-android-sdk', labelKey: 'action.configureAndroidSdk' },
      });
    } else {
      const sdkAdb = await command(sdk.adbPath, ['version']);
      const aapt2 = await command(sdk.aapt2Path, ['version']);
      const usable =
        sdkAdb.exitCode === 0 &&
        /Android Debug Bridge version \d/.test(sdkAdb.stdout) &&
        aapt2.exitCode === 0 &&
        /Android Asset Packaging Tool|aapt2/i.test(`${aapt2.stdout}\n${aapt2.stderr}`);
      technicalDetails.sdkToolsUsable = usable;
      capabilities.push(
        usable
          ? {
              id: 'androidSdk',
              required: true,
              status: 'ready',
              messageKey: 'capability.androidSdk.ready',
            }
          : unknown('androidSdk'),
      );
    }
  } catch {
    input.signal?.throwIfAborted();
    capabilities.push(unknown('androidSdk'));
  }
  const appium = await command('appium', ['--version']);
  const appiumReady = appium.exitCode === 0 && /^\s*\d+\.\d+\.\d+/.test(appium.stdout);
  technicalDetails.appiumCli = appiumReady
    ? 'available'
    : appium.failure === 'not-found'
      ? 'missing'
      : 'unknown';
  technicalDetails.appiumCliCheck = appiumReady ? 'passed' : (appium.failure ?? 'invalid-output');
  const appiumFailure = {
    reason: appium.failure ?? 'invalid-output',
    exitCode: appium.exitCode,
    ...(appium.errorCode ? { processErrorCode: appium.errorCode } : {}),
    summary:
      appium.failure === 'timeout'
        ? 'Appium CLI version check timed out; installation state is unknown.'
        : appium.failure === 'not-found'
          ? 'Appium CLI executable was not found.'
          : `Appium CLI version check failed (${appium.errorCode ?? (appium.exitCode === null ? 'execution failure' : `exit ${appium.exitCode}`)}); installation state is unknown.`,
  };
  if (!appiumReady) technicalDetails.appiumCliError = appiumFailure;
  capabilities.push(
    appiumReady
      ? {
          id: 'appiumCli',
          required: true,
          status: 'ready',
          messageKey: 'capability.appiumCli.ready',
        }
      : appium.failure === 'not-found'
        ? {
            id: 'appiumCli',
            required: true,
            status: 'action-required',
            messageKey: 'capability.appiumCli.install',
            errorCode: 'APPIUM_CLI_MISSING',
            action: { id: 'install-appium', labelKey: 'action.installAppium' },
          }
        : {
            ...unknown('appiumCli'),
            details: appiumFailure,
          },
  );
  if (!appiumReady) capabilities.push(unknown('uiautomator2Driver'));
  else {
    const list = await command('appium', ['driver', 'list', '--installed', '--json']);
    if (list.exitCode !== 0) capabilities.push(unknown('uiautomator2Driver'));
    else {
      try {
        const installed: unknown = JSON.parse(list.stdout);
        if (!installed || typeof installed !== 'object' || Array.isArray(installed))
          throw new Error('Invalid driver list.');
        const driver: unknown = (installed as Record<string, unknown>).uiautomator2;
        if (
          driver !== undefined &&
          (!driver || typeof driver !== 'object' || Array.isArray(driver))
        )
          throw new Error('Invalid driver metadata.');
        capabilities.push(
          driver
            ? {
                id: 'uiautomator2Driver',
                required: true,
                status: 'ready',
                messageKey: 'capability.uiautomator2.ready',
              }
            : {
                id: 'uiautomator2Driver',
                required: true,
                status: 'action-required',
                messageKey: 'capability.uiautomator2.install',
                errorCode: 'UIAUTOMATOR2_DRIVER_MISSING',
                action: {
                  id: 'install-uiautomator2',
                  labelKey: 'action.installUiAutomator2',
                  command: 'appium driver install uiautomator2',
                },
              },
        );
      } catch {
        capabilities.push(unknown('uiautomator2Driver'));
      }
    }
  }
  if (readonlyContext) {
    const facts = readonlyContext.preparation;
    const unauthorized = facts.blockerCategories.includes('android-device-unauthorized');
    const offline = facts.blockerCategories.includes('android-device-offline');
    const ready = facts.compatibility === 'compatible' && !facts.blockerCategories.length;
    technicalDetails.adbServer = 'running';
    technicalDetails.devices = [
      {
        kind: 'device',
        status: ready ? 'device' : unauthorized ? 'unauthorized' : offline ? 'offline' : 'unknown',
        matchesSelector: true,
      },
    ];
    capabilities.push({
      id: 'adbServer',
      required: true,
      status: 'ready',
      messageKey: 'capability.adbServer.ready',
    });
    capabilities.push(
      ready
        ? {
            id: 'androidDevice',
            required: true,
            status: 'ready',
            messageKey: 'capability.androidDevice.ready',
          }
        : unauthorized
          ? {
              id: 'androidDevice',
              required: true,
              status: 'action-required',
              messageKey: 'capability.androidDevice.unauthorized',
              errorCode: 'ANDROID_DEVICE_UNAUTHORIZED',
              action: {
                id: 'authorize-android-device',
                labelKey: 'action.authorizeAndroidDevice',
                requiresConfirmation: true,
              },
            }
          : offline
            ? {
                id: 'androidDevice',
                required: true,
                status: 'action-required',
                messageKey: 'capability.androidDevice.offline',
                errorCode: 'ANDROID_DEVICE_OFFLINE',
                action: {
                  id: 'connect-android-device',
                  labelKey: 'action.connectAndroidDevice',
                },
              }
            : unknown('androidDevice'),
    );
  } else
    try {
      input.signal?.throwIfAborted();
      const output = await dependencies.adbDevices(input.signal);
      input.signal?.throwIfAborted();
      technicalDetails.adbServer = output === undefined ? 'not-running' : 'running';
      capabilities.push(
        output === undefined
          ? {
              id: 'adbServer',
              required: true,
              status: 'action-required',
              messageKey: 'capability.adbServer.start',
              errorCode: 'ADB_SERVER_NOT_RUNNING',
              action: { id: 'start-adb', labelKey: 'action.startAdb' },
            }
          : {
              id: 'adbServer',
              required: true,
              status: 'ready',
              messageKey: 'capability.adbServer.ready',
            },
      );
      if (output === undefined) {
        capabilities.push(unknown('androidDevice'));
        return aggregateSetup({ platform: 'android', capabilities, technicalDetails });
      }
      const available = devices(output ?? '');
      const matches = matchDevices(available, input.device);
      technicalDetails.devices = available.map(({ kind, status, id }) => ({
        kind,
        status,
        matchesSelector: matches.some((device) => device.id === id),
      }));
      const selected =
        matches.length === 1 ? available.find((item) => item.id === matches[0]!.id) : undefined;
      const reason = !matches.length
        ? 'missing'
        : !selected
          ? 'select'
          : selected.status === 'device'
            ? 'ready'
            : selected.status;
      const actions = {
        missing: { id: 'connect-android-device', labelKey: 'action.connectAndroidDevice' },
        select: { id: 'select-android-device', labelKey: 'action.selectAndroidDevice' },
        unauthorized: {
          id: 'authorize-android-device',
          labelKey: 'action.authorizeAndroidDevice',
          requiresConfirmation: true,
        },
        offline: { id: 'connect-android-device', labelKey: 'action.connectAndroidDevice' },
      } as const;
      const codes = {
        missing: 'ANDROID_DEVICE_MISSING',
        select: 'ANDROID_DEVICE_SELECTION_REQUIRED',
        unauthorized: 'ANDROID_DEVICE_UNAUTHORIZED',
        offline: 'ANDROID_DEVICE_OFFLINE',
      } as const;
      capabilities.push({
        id: 'androidDevice',
        required: true,
        status: reason === 'ready' ? 'ready' : 'action-required',
        messageKey: `capability.androidDevice.${reason}`,
        ...(reason === 'ready' ? {} : { errorCode: codes[reason], action: actions[reason] }),
      });
    } catch {
      input.signal?.throwIfAborted();
      technicalDetails.adbServer = 'unknown';
      if (!capabilities.some((item) => item.id === 'adbServer'))
        capabilities.push(unknown('adbServer'));
      capabilities.push(unknown('androidDevice'));
    }
  return aggregateSetup({ platform: 'android', capabilities, technicalDetails });
}
