import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname } from 'node:os';
import { connect, type Socket } from 'node:net';
import { assertAdbServerCompatible, resolveAndroidTools } from './android-tools.ts';
import type {
  NativeDeviceKind,
  NativePlatform,
  NativeEnvironment,
  ResolvedNativeSession,
} from '../platforms/appium/schema.ts';
const exec = promisify(execFile);
export type Device = { id: string; name: string; kind: NativeDeviceKind };

export function matchDevices(devices: Device[], selector?: NativeEnvironment['device']): Device[] {
  return devices.filter(
    (device) =>
      (!selector?.kind || device.kind === selector.kind) &&
      (!selector?.name ||
        device.name.localeCompare(selector.name, undefined, { sensitivity: 'accent' }) === 0),
  );
}

export function parseAndroidDevices(text: string): Device[] {
  return text.split('\n').flatMap((line) => {
    const match = /^(\S+)\s+device(?:\s+(.*))?$/.exec(line);
    if (!match || match[1] === 'List') return [];
    const kind = match[1].startsWith('emulator-') ? 'emulator' : 'device';
    return [
      {
        id: match[1],
        name:
          /model:(\S+)/.exec(match[2] ?? '')?.[1] ??
          (kind === 'emulator' ? 'Android emulator' : 'Android device'),
        kind,
      },
    ];
  });
}

const coldReadinessUnknown =
  'ANDROID_DEVICE_LOCK_STATE_UNKNOWN: could not verify the local phone before Session initialization; check the existing ADB connection and unlock/wake yourself then recheck.';

// Only the already-running local daemon is used. No CLI, daemon start, helper or key command.
// The connector is source-internal injection for offline protocol tests, not a routing setting.
function readReadinessAdb(
  query: 'devices' | 'power' | 'policy',
  serial: string | undefined,
  signal?: AbortSignal,
  connectAdb: () => Socket = () => connect({ host: '127.0.0.1', port: 5037 }),
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = connectAdb();
    let buffer = Buffer.alloc(0);
    let received = 0;
    let output = '';
    let stderr = '';
    let phase: 'host-status' | 'devices' | 'shell-status' | 'shell' = 'host-status';
    let settled = false;
    const finish = (error?: unknown, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => finish(signal?.reason ?? new Error(coldReadinessUnknown));
    const timer = setTimeout(
      () => finish(new Error(`${coldReadinessUnknown} ADB preflight timed out.`)),
      3_000,
    );
    const send = (service: string) =>
      socket.write(Buffer.byteLength(service).toString(16).padStart(4, '0') + service);
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('connect', () =>
      send(query === 'devices' ? 'host:devices-l' : `host:transport:${serial}`),
    );
    socket.on('error', () => finish(new Error(`${coldReadinessUnknown} ADB daemon unavailable.`)));
    socket.on('end', () => finish(new Error(`${coldReadinessUnknown} Incomplete ADB response.`)));
    socket.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > 512 * 1024)
        return finish(new Error(`${coldReadinessUnknown} ADB output exceeded its limit.`));
      buffer = Buffer.concat([buffer, chunk]);
      while (!settled) {
        if (phase === 'host-status' || phase === 'shell-status') {
          if (buffer.length < 4) return;
          if (buffer.toString('ascii', 0, 4) !== 'OKAY')
            return finish(new Error(`${coldReadinessUnknown} ADB request rejected.`));
          buffer = buffer.subarray(4);
          if (phase === 'shell-status') phase = 'shell';
          else if (query === 'devices') phase = 'devices';
          else {
            phase = 'shell-status';
            send(`shell,v2,raw:dumpsys ${query === 'power' ? 'power' : 'window policy'}`);
          }
        } else if (phase === 'devices') {
          if (buffer.length < 4) return;
          const lengthText = buffer.toString('ascii', 0, 4);
          if (!/^[0-9a-f]{4}$/i.test(lengthText))
            return finish(new Error(`${coldReadinessUnknown} Invalid ADB response.`));
          const length = Number.parseInt(lengthText, 16);
          if (buffer.length < length + 4) return;
          return finish(undefined, buffer.toString('utf8', 4, length + 4));
        } else {
          if (buffer.length < 5) return;
          const id = buffer[0];
          const length = buffer.readUInt32LE(1);
          if (length > 512 * 1024)
            return finish(new Error(`${coldReadinessUnknown} Invalid ADB shell frame.`));
          if (buffer.length < length + 5) return;
          const payload = buffer.subarray(5, length + 5);
          buffer = buffer.subarray(length + 5);
          if (id === 1) output += payload.toString('utf8');
          else if (id === 2) stderr += payload.toString('utf8');
          else if (id === 3) {
            if (length !== 1 || payload[0] !== 0 || stderr.trim())
              return finish(new Error(`${coldReadinessUnknown} ADB shell command failed.`));
            return finish(undefined, output);
          } else return finish(new Error(`${coldReadinessUnknown} Invalid ADB shell frame.`));
        }
      }
    });
    if (signal?.aborted) abort();
  });
}

/** Cold Android ready only; unlike normal discovery, never starts an ADB daemon. */
export async function discoverAndroidReadinessDevices(
  signal?: AbortSignal,
  connectAdb?: () => Socket,
): Promise<Device[]> {
  return parseAndroidDevices(await readReadinessAdb('devices', undefined, signal, connectAdb));
}

/** Require affirmative awake/unlocked evidence on the exact resolved local device, before POST. */
export async function assertAndroidColdReadiness(
  target: ResolvedNativeSession,
  signal?: AbortSignal,
  connectAdb?: () => Socket,
): Promise<void> {
  const serial = target.capabilities['appium:udid'];
  if (typeof serial !== 'string' || !serial || serial.length > 256 || /[\s\0]/.test(serial))
    throw new Error(coldReadinessUnknown);
  const power = await readReadinessAdb('power', serial, signal, connectAdb);
  const policy = await readReadinessAdb('policy', serial, signal, connectAdb);
  signal?.throwIfAborted();
  const wakefulness = [...power.matchAll(/^\s*mWakefulness=(\w+)\s*$/gm)];
  if (wakefulness.length !== 1) throw new Error(coldReadinessUnknown);
  const lines = policy.split(/\r?\n/);
  const headers = lines.flatMap((line, index) =>
    /\b(?:KeyguardServiceDelegate|KeyguardDelegate|mKeyguardDelegate)\b/.test(line) ? [index] : [],
  );
  const showing: string[] = [];
  if (headers.length === 1) {
    const start = headers[0]!;
    const indent = lines[start]!.search(/\S/);
    for (const line of lines.slice(start + 1)) {
      if (line.trim() && line.search(/\S/) <= indent) break;
      const match = /^\s*showing=(true|false)\s*$/.exec(line);
      if (match) showing.push(match[1]!);
    }
  }
  if (
    ['Asleep', 'Dozing', 'Dreaming'].includes(wakefulness[0]![1]!) ||
    showing.includes('true') ||
    /\b(?:screenState=SCREEN_STATE_OFF|mScreenOnFully=false)\b/.test(policy)
  )
    throw new Error(
      'ANDROID_DEVICE_LOCKED: phone locked or screen off; unlock/wake yourself then recheck.',
    );
  if (wakefulness[0]![1] !== 'Awake' || showing.length !== 1 || showing[0] !== 'false')
    throw new Error(coldReadinessUnknown);
}

export function parseIosDevices(text: string): Device[] {
  let section = '';
  return text.split('\n').flatMap((line) => {
    const heading = /^== (.+) ==$/.exec(line.trim());
    if (heading) {
      section = heading[1]!;
      return [];
    }
    if (section !== 'Devices' && section !== 'Simulators') return [];
    const match = /^(.+?) \(([^)]+)\) \(([A-Fa-f0-9-]{20,})\)$/.exec(line.trim());
    if (!match) return [];
    return [
      {
        id: match[3]!,
        name: match[1]!.replace(/ Simulator$/, ''),
        kind: section === 'Simulators' ? ('simulator' as const) : ('device' as const),
      },
    ];
  });
}

export async function discoverDevices(
  platform: NativePlatform,
  signal?: AbortSignal,
  dependencies: {
    resolveAndroidTools: typeof resolveAndroidTools;
    assertAdbServerCompatible: typeof assertAdbServerCompatible;
    command(
      file: string,
      args: string[],
      options: { timeout: number; signal?: AbortSignal },
    ): Promise<{ stdout: string }>;
  } = { resolveAndroidTools, assertAdbServerCompatible, command: exec },
): Promise<Device[]> {
  signal?.throwIfAborted();
  if (platform === 'macos') {
    if (process.platform !== 'darwin') throw new Error('Local macOS automation requires macOS.');
    return [{ id: 'local', name: hostname(), kind: 'host' }];
  }
  if (platform === 'android') {
    const tools = await dependencies.resolveAndroidTools({ signal });
    if (!tools.adbPath)
      throw new Error('ADB_MISSING: prepare Android tools before device discovery.');
    await dependencies.assertAdbServerCompatible(tools.adbPath, signal);
    return parseAndroidDevices(
      (await dependencies.command(tools.adbPath, ['devices', '-l'], { timeout: 10_000, signal }))
        .stdout,
    );
  }
  if (process.platform !== 'darwin')
    throw new Error('Local iOS discovery requires Xcode on macOS.');
  const { stdout } = await exec('xcrun', ['xctrace', 'list', 'devices'], {
    timeout: 20_000,
    signal,
  });
  // Xcode may place the offline section before simulators; parse named sections.
  return parseIosDevices(stdout);
}

export async function resolveDevice(
  environment: NativeEnvironment,
  signal?: AbortSignal,
): Promise<ResolvedNativeSession> {
  signal?.throwIfAborted();
  // A stable selector opts into local discovery even when Appium itself is on localhost.
  // Without one, an explicit server URL is treated as externally managed.
  if (environment.serverUrl && !environment.device) {
    if (environment.platform === 'macos' || environment.capabilities['appium:deviceName'])
      return { environment, capabilities: { ...environment.capabilities } };
    throw new Error(
      'Remote Appium does not define device discovery. Configure deviceName or udid once for this project.',
    );
  }
  const discovered = await discoverDevices(environment.platform, signal);
  signal?.throwIfAborted();
  const selector = environment.device;
  const devices = matchDevices(discovered, selector);
  if (!devices.length && selector)
    throw new Error(
      `No device matches ${JSON.stringify(selector)}. Available: ${JSON.stringify(discovered)}`,
    );
  if (devices.length !== 1)
    throw new Error(
      devices.length
        ? `Choose a device once: ${JSON.stringify(devices)}`
        : 'No online device. Connect/unlock a device or start a simulator.',
    );
  return {
    environment,
    capabilities: {
      ...environment.capabilities,
      ...(environment.platform === 'macos' ? {} : { 'appium:udid': devices[0].id }),
      'appium:deviceName': devices[0].name,
    },
  };
}
