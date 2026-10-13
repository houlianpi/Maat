import { connection } from '../platforms/appium/schema.ts';
import { isRecord } from '../core/exploration/protocol.ts';
import { discoverIosDevices, matchIosDevices, type IosDevice } from '../setup/ios-devices.ts';
import { aggregateSetup } from './model.ts';
import { defaultCommand, defaultFetchStatus, type SetupCommandResult } from './probes.ts';
import type { IosSetupCheckInput, SetupCapability, SetupSnapshot } from './types.ts';
import {
  setupReadonlyContextSymbol,
  type InternalSetupCheckInput,
} from '../mobile/integration/readonly.ts';

export type IosSetupDetectorDependencies = {
  hostPlatform: NodeJS.Platform;
  command(file: string, args: string[], signal?: AbortSignal): Promise<SetupCommandResult>;
  fetchStatus(url: string, signal?: AbortSignal): Promise<boolean>;
  devices(signal?: AbortSignal): Promise<IosDevice[]>;
};

const defaults: IosSetupDetectorDependencies = {
  hostPlatform: process.platform,
  command: defaultCommand,
  fetchStatus: defaultFetchStatus,
  devices: discoverIosDevices,
};

const unknownKeys = {
  xcode: 'capability.xcode.unknown',
  xcuitestDriver: 'capability.xcuitest.unknown',
  iosDevice: 'capability.iosDevice.unknown',
  iosDeveloperMode: 'capability.iosDeveloperMode.unknown',
  appiumCli: 'capability.appiumCli.unknown',
} as const;

function unknown(id: keyof typeof unknownKeys): SetupCapability {
  return {
    id,
    required: true,
    status: 'unknown',
    messageKey: unknownKeys[id],
    errorCode: 'IOS_SETUP_CHECK_FAILED',
    action: { id: 'recheck', labelKey: 'action.recheck' },
  };
}

export async function detectIosSetup(
  input: IosSetupCheckInput = {},
  dependencies: IosSetupDetectorDependencies = defaults,
): Promise<SetupSnapshot> {
  input.signal?.throwIfAborted();
  const internalContext = (input as InternalSetupCheckInput)[setupReadonlyContextSymbol];
  const readonlyContext =
    internalContext && !('facade' in internalContext) ? internalContext : undefined;
  const url = input.serverUrl ?? 'http://127.0.0.1:4723/';
  const endpoint = connection(url);
  if (
    input.device &&
    (!isRecord(input.device) ||
      (input.device.kind !== undefined && input.device.kind !== 'device') ||
      (input.device.name !== undefined &&
        (typeof input.device.name !== 'string' || !input.device.name.trim())))
  )
    throw new Error(
      'IOS_SETUP_UNSUPPORTED: the preparation workflow requires a physical iPhone selector.',
    );
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(endpoint.hostname!);
  const capabilities: SetupCapability[] = [];
  const facts: Record<string, unknown> = {
    preparationOnly: true,
    serverScope: local ? 'local' : 'remote',
    wda: 'not-verified; connection must inspect a valid signed local build and the selected iPhone installation before reuse',
    currentLockState:
      'unknown; passcode and boot-unlock facts do not prove current screen or lock state',
    initializationAuthorization:
      'normal phone tasks allow necessary connection initialization; live WDA lock checks precede UI; first installation, signing changes and device/service restart require separate authorization',
  };
  if (!local || dependencies.hostPlatform !== 'darwin') {
    capabilities.push({
      id: 'xcode',
      required: true,
      status: 'unavailable',
      messageKey: 'capability.xcode.required',
      errorCode: !local ? 'IOS_SETUP_REMOTE_UNSUPPORTED' : 'IOS_HOST_UNSUPPORTED',
    });
    return aggregateSetup({ platform: 'ios', capabilities, technicalDetails: facts });
  }
  let status: boolean;
  try {
    status = readonlyContext
      ? readonlyContext.endpoint.state === 'reachable' &&
        readonlyContext.endpoint.compatibility === 'compatible'
      : await dependencies.fetchStatus(url, input.signal);
  } catch (error) {
    input.signal?.throwIfAborted();
    throw new Error('IOS_SETUP_CHECK_FAILED: the selected Appium status check failed.', {
      cause: error,
    });
  }
  input.signal?.throwIfAborted();
  capabilities.push(
    status
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
            command: `appium --address ${endpoint.hostname === '[::1]' ? '::1' : endpoint.hostname} --port ${endpoint.port} --base-path '${(endpoint.path ?? '/').replace(/'/g, "'\\''")}'`,
          },
        },
  );
  const probe = async (file: string, args: string[]) => {
    try {
      const result = await dependencies.command(file, args, input.signal);
      input.signal?.throwIfAborted();
      return result;
    } catch (error) {
      input.signal?.throwIfAborted();
      throw new Error('IOS_SETUP_CHECK_FAILED: a preparation command failed to execute.', {
        cause: error,
      });
    }
  };
  const xcode = await probe('xcodebuild', ['-version']);
  const xcodeVersion = /^Xcode (\d+(?:\.\d+)*)\s*$/m.exec(xcode.stdout)?.[1];
  facts.xcodeCheck = xcode.exitCode === 0 && xcodeVersion ? 'passed' : (xcode.failure ?? 'failed');
  if (xcodeVersion && xcode.exitCode === 0) {
    facts.xcodeVersion = xcodeVersion;
    capabilities.push({
      id: 'xcode',
      required: true,
      status: 'ready',
      messageKey: 'capability.xcode.ready',
    });
  } else
    capabilities.push(
      xcode.failure === 'timeout'
        ? unknown('xcode')
        : {
            id: 'xcode',
            required: true,
            status: 'action-required',
            messageKey: 'capability.xcode.required',
            errorCode: 'XCODE_REQUIRED',
            action: { id: 'configure-xcode', labelKey: 'action.configureXcode' },
          },
    );
  const appium = await probe('appium', ['--version']);
  const appiumReady = appium.exitCode === 0 && /^\s*\d+\.\d+\.\d+/.test(appium.stdout);
  facts.appiumCli = appiumReady
    ? 'available'
    : appium.failure === 'not-found'
      ? 'missing'
      : 'unknown';
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
        : unknown('appiumCli'),
  );
  if (appiumReady) {
    const drivers = await probe('appium', ['driver', 'list', '--installed', '--json']);
    let installed: unknown;
    try {
      installed = JSON.parse(drivers.stdout);
    } catch {
      installed = undefined;
    }
    if (
      drivers.exitCode !== 0 ||
      !isRecord(installed) ||
      (installed.xcuitest !== undefined && !isRecord(installed.xcuitest))
    )
      capabilities.push(unknown('xcuitestDriver'));
    else
      capabilities.push(
        isRecord(installed.xcuitest)
          ? {
              id: 'xcuitestDriver',
              required: true,
              status: 'ready',
              messageKey: 'capability.xcuitest.ready',
            }
          : {
              id: 'xcuitestDriver',
              required: true,
              status: 'action-required',
              messageKey: 'capability.xcuitest.install',
              errorCode: 'XCUITEST_DRIVER_MISSING',
              action: { id: 'install-xcuitest', labelKey: 'action.installXcuitest' },
            },
      );
  } else capabilities.push(unknown('xcuitestDriver'));
  if (readonlyContext) {
    const blockers = readonlyContext.preparation.blockerCategories;
    const driverPreparationUnknown = [
      'artifact-incompatible',
      'artifact-compatibility-unknown',
      'signing-required',
      'signing-compatibility-unknown',
      'driver-incompatible',
      'driver-compatibility-unknown',
    ].some((category) => blockers.includes(category));
    if (driverPreparationUnknown) {
      const driverIndex = capabilities.findIndex(({ id }) => id === 'xcuitestDriver');
      if (driverIndex >= 0) capabilities[driverIndex] = unknown('xcuitestDriver');
    }
    const pairingUnknown =
      blockers.includes('pairing-unknown') || blockers.includes('trust-unknown');
    const pairingRequired =
      blockers.includes('pairing-required') || blockers.includes('trust-required');
    const developerUnknown = blockers.includes('developer-mode-unknown');
    const developerRequired = blockers.includes('developer-mode-required');
    facts.devices = [
      {
        connected: true,
        paired: pairingUnknown ? undefined : !pairingRequired,
        developerMode: developerUnknown ? 'unknown' : developerRequired ? 'disabled' : 'enabled',
        matchesSelector: true,
      },
    ];
    capabilities.push(
      pairingUnknown
        ? unknown('iosDevice')
        : pairingRequired
          ? {
              id: 'iosDevice',
              required: true,
              status: 'action-required',
              messageKey: 'capability.iosDevice.trust',
              errorCode: 'IOS_DEVICE_UNPAIRED',
              action: { id: 'trust-ios-device', labelKey: 'action.trustIosDevice' },
            }
          : {
              id: 'iosDevice',
              required: true,
              status: 'ready',
              messageKey: 'capability.iosDevice.ready',
            },
    );
    capabilities.push(
      developerUnknown
        ? unknown('iosDeveloperMode')
        : developerRequired
          ? {
              id: 'iosDeveloperMode',
              required: true,
              status: 'action-required',
              messageKey: 'capability.iosDeveloperMode.required',
              errorCode: 'IOS_DEVELOPER_MODE_REQUIRED',
              action: {
                id: 'enable-ios-developer-mode',
                labelKey: 'action.enableIosDeveloperMode',
                requiresConfirmation: true,
              },
            }
          : {
              id: 'iosDeveloperMode',
              required: true,
              status: 'ready',
              messageKey: 'capability.iosDeveloperMode.ready',
            },
    );
  } else
    try {
      const devices = await dependencies.devices(input.signal);
      input.signal?.throwIfAborted();
      const matches = matchIosDevices(devices, input.device);
      const selected = matches.length === 1 ? matches[0] : undefined;
      facts.devices = devices.map((device) => ({
        connected: device.connected,
        paired: device.paired,
        developerMode: device.developerMode,
        matchesSelector: matches.some((match) => match.id === device.id),
      }));
      const reason = !matches.length
        ? 'missing'
        : !selected
          ? 'select'
          : !selected.connected
            ? 'offline'
            : selected.paired === false
              ? 'trust'
              : selected.paired === undefined
                ? 'unknown'
                : 'ready';
      if (reason === 'unknown') capabilities.push(unknown('iosDevice'));
      else {
        const keys = {
          missing: [
            'capability.iosDevice.missing',
            'IOS_DEVICE_MISSING',
            'connect-ios-device',
            'action.connectIosDevice',
          ],
          select: [
            'capability.iosDevice.select',
            'IOS_DEVICE_SELECTION_REQUIRED',
            'select-ios-device',
            'action.selectIosDevice',
          ],
          offline: [
            'capability.iosDevice.offline',
            'IOS_DEVICE_OFFLINE',
            'connect-ios-device',
            'action.connectIosDevice',
          ],
          trust: [
            'capability.iosDevice.trust',
            'IOS_DEVICE_UNPAIRED',
            'trust-ios-device',
            'action.trustIosDevice',
          ],
        } as const;
        capabilities.push(
          reason === 'ready'
            ? {
                id: 'iosDevice',
                required: true,
                status: 'ready',
                messageKey: 'capability.iosDevice.ready',
              }
            : {
                id: 'iosDevice',
                required: true,
                status: 'action-required',
                messageKey: keys[reason][0],
                errorCode: keys[reason][1],
                action: { id: keys[reason][2], labelKey: keys[reason][3] },
              },
        );
      }
      const mode = selected?.developerMode;
      capabilities.push(
        mode === 'enabled'
          ? {
              id: 'iosDeveloperMode',
              required: true,
              status: 'ready',
              messageKey: 'capability.iosDeveloperMode.ready',
            }
          : mode === 'disabled'
            ? {
                id: 'iosDeveloperMode',
                required: true,
                status: 'action-required',
                messageKey: 'capability.iosDeveloperMode.required',
                errorCode: 'IOS_DEVELOPER_MODE_REQUIRED',
                action: {
                  id: 'enable-ios-developer-mode',
                  labelKey: 'action.enableIosDeveloperMode',
                  requiresConfirmation: true,
                },
              }
            : unknown('iosDeveloperMode'),
      );
    } catch (error) {
      input.signal?.throwIfAborted();
      facts.deviceCheck =
        error instanceof Error && error.message.startsWith('IOS_DEVICE_CHECK_FAILED')
          ? 'IOS_DEVICE_CHECK_FAILED'
          : 'failed';
      capabilities.push(unknown('iosDevice'), unknown('iosDeveloperMode'));
    }
  return aggregateSetup({ platform: 'ios', capabilities, technicalDetails: facts });
}
