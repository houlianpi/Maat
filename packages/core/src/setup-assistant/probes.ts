import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveAndroidTools } from '../setup/android-tools.ts';
import { resolveAppiumCommand } from '../setup/appium-command.ts';
import { isRecord } from '../core/exploration/protocol.ts';

const exec = promisify(execFile);

export type SetupCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  failure?: 'not-found' | 'timeout' | 'failed';
  errorCode?: string;
};

export async function defaultCommand(
  file: string,
  args: string[],
  signal?: AbortSignal,
  resolveTools = resolveAndroidTools,
  command: (
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer: number; signal?: AbortSignal },
  ) => Promise<{ stdout: string; stderr: string }> = exec,
  resolveAppium = resolveAppiumCommand,
): Promise<SetupCommandResult> {
  try {
    if (file === 'adb') {
      const tools = await resolveTools({ signal });
      if (!tools.adbPath) return { stdout: '', stderr: '', exitCode: null, failure: 'not-found' };
      file = tools.adbPath;
    }
    if (file === 'appium') {
      const resolved = await resolveAppium({ signal });
      file = resolved.file;
      args = [...resolved.args, ...args];
    }
    const result = await command(file, args, { timeout: 5_000, maxBuffer: 512 * 1024, signal });
    return { ...result, exitCode: 0 };
  } catch (error) {
    signal?.throwIfAborted();
    const failure = error as Omit<NodeJS.ErrnoException, 'code'> & {
      code?: string | number;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      exitCode: typeof failure.code === 'number' ? failure.code : null,
      ...(typeof failure.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code)
        ? { errorCode: failure.code }
        : {}),
      failure:
        failure.code === 'ENOENT' || failure.code === 'APPIUM_CLI_MISSING'
          ? 'not-found'
          : failure.killed
            ? 'timeout'
            : 'failed',
    };
  }
}

export async function inspectAppiumEndpointStatus(
  url: string,
  signal?: AbortSignal,
): Promise<
  | { state: 'reachable'; compatibility: 'compatible' | 'incompatible' | 'unknown' }
  | { state: 'unreachable'; errorCategory: string }
> {
  const endpoint = new URL(url);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/status`;
  try {
    const response = await fetch(endpoint, {
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(3_000)]),
    });
    if (!response.ok) return { state: 'reachable', compatibility: 'incompatible' };
    const body: unknown = await response.json();
    if (!isRecord(body) || !isRecord(body.value))
      return { state: 'reachable', compatibility: 'incompatible' };
    return {
      state: 'reachable',
      compatibility:
        body.value.ready === true
          ? 'compatible'
          : body.value.ready === false
            ? 'unknown'
            : 'incompatible',
    };
  } catch {
    signal?.throwIfAborted();
    return { state: 'unreachable', errorCategory: 'service-unavailable' };
  }
}

export async function defaultFetchStatus(url: string, signal?: AbortSignal): Promise<boolean> {
  const status = await inspectAppiumEndpointStatus(url, signal);
  return status.state === 'reachable' && status.compatibility === 'compatible';
}
