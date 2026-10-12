import { isRecord } from '../core/exploration/protocol.ts';
import { matchDevices, type Device } from './devices.ts';
import { defaultCommand, type SetupCommandResult } from '../setup-assistant/probes.ts';
import type { NativeDeviceSelector } from '../platforms/appium/schema.ts';

export type IosDevice = Device & {
  connected: boolean;
  paired: boolean | undefined;
  developerMode: 'enabled' | 'disabled' | 'unknown';
};

export function parseIosDeviceList(text: string): IosDevice[] {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || !isRecord(data.result) || !Array.isArray(data.result.devices))
    throw new Error('IOS_DEVICE_CHECK_FAILED: invalid CoreDevice device list.');
  return data.result.devices.flatMap((item: unknown) => {
    if (!isRecord(item)) throw new Error('IOS_DEVICE_CHECK_FAILED: invalid device metadata.');
    const properties = isRecord(item.properties) ? item.properties : {};
    const hardware = isRecord(properties.hardware) ? properties.hardware : item.hardwareProperties;
    if (!isRecord(hardware))
      throw new Error('IOS_DEVICE_CHECK_FAILED: missing device hardware metadata.');
    if (hardware.platform !== 'iOS' || hardware.reality === 'simulated') return [];
    const state = isRecord(properties.state) ? properties.state : item.deviceProperties;
    const legacyState = isRecord(item.deviceProperties) ? item.deviceProperties : {};
    const connection = isRecord(properties.connection)
      ? properties.connection
      : item.connectionProperties;
    const connected = isRecord(connection)
      ? (connection.state ?? connection.tunnelState)
      : undefined;
    if (
      hardware.reality !== 'physical' ||
      typeof hardware.udid !== 'string' ||
      !hardware.udid.trim() ||
      !isRecord(state) ||
      typeof state.name !== 'string' ||
      !state.name.trim() ||
      !isRecord(connection) ||
      !['connected', 'disconnected', 'unavailable'].includes(String(connected))
    )
      throw new Error('IOS_DEVICE_CHECK_FAILED: incomplete physical device metadata.');
    const mode = state.developerModeStatus ?? legacyState.developerModeStatus;
    const developerMode =
      mode === 'enabled' || (isRecord(mode) && 'enabled' in mode)
        ? 'enabled'
        : mode === 'disabled' || (isRecord(mode) && 'disabled' in mode)
          ? 'disabled'
          : 'unknown';
    return [
      {
        id: hardware.udid,
        name: state.name,
        kind: 'device' as const,
        connected: connected === 'connected',
        paired:
          connection.pairingState === 'paired'
            ? true
            : connection.pairingState === 'unpaired'
              ? false
              : undefined,
        developerMode,
      },
    ];
  });
}

export function matchIosDevices(
  devices: IosDevice[],
  selector?: NativeDeviceSelector,
): IosDevice[] {
  const matches = matchDevices(devices, selector ?? { kind: 'device' });
  const candidates = devices.filter((device) => matches.some((match) => match.id === device.id));
  return selector?.name ? candidates : candidates.filter((device) => device.connected);
}

export async function discoverIosDevices(signal?: AbortSignal): Promise<IosDevice[]> {
  if (process.platform !== 'darwin')
    throw new Error('IOS_HOST_UNSUPPORTED: local iPhone preparation requires macOS and Xcode.');
  const result = await defaultCommand(
    'xcrun',
    ['devicectl', 'list', 'devices', '--quiet', '--json-output', '-'],
    signal,
  );
  signal?.throwIfAborted();
  if (result.exitCode !== 0)
    throw new Error(
      `IOS_DEVICE_CHECK_FAILED: CoreDevice discovery ${result.failure ?? 'failed'}; connect and trust the phone, then recheck.`,
    );
  return parseIosDeviceList(result.stdout);
}

export async function assertIosColdReadiness(
  udid: string,
  signal?: AbortSignal,
  command: (
    file: string,
    args: string[],
    signal?: AbortSignal,
  ) => Promise<SetupCommandResult> = defaultCommand,
): Promise<void> {
  signal?.throwIfAborted();
  const result = await command(
    'xcrun',
    [
      'devicectl',
      'device',
      'info',
      'lockState',
      '--device',
      udid,
      '--quiet',
      '--timeout',
      '5',
      '--json-output',
      '-',
    ],
    signal,
  );
  signal?.throwIfAborted();
  if (result.exitCode !== 0)
    throw new Error(
      `IOS_DEVICE_LOCK_STATE_UNKNOWN: read-only lock check ${result.failure ?? 'failed'}; connect, wake and unlock the phone yourself, then recheck.`,
    );
  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error('IOS_DEVICE_LOCK_STATE_UNKNOWN: CoreDevice returned invalid lock data.', {
      cause: error,
    });
  }
  const lock = isRecord(data) && isRecord(data.result) ? data.result : undefined;
  if (
    !isRecord(lock) ||
    typeof lock.passcodeRequired !== 'boolean' ||
    typeof lock.unlockedSinceBoot !== 'boolean'
  )
    throw new Error(
      'IOS_DEVICE_LOCK_STATE_UNKNOWN: CoreDevice did not return usable passcode and boot-unlock facts.',
    );
  if (lock.passcodeRequired || !lock.unlockedSinceBoot)
    throw new Error('IOS_DEVICE_LOCKED: wake and unlock the phone yourself, then recheck.');
  // These are only cold lock hints. The Worker must still obtain a live WDA lock result.
}
