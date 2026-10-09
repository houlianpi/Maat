import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { remote } from 'webdriverio';
import { connection } from '../platforms/appium/schema.ts';
import { aggregateSetup } from './model.ts';
import type { SetupCapability, SetupProcessFingerprint, SetupSnapshot } from './types.ts';

const exec = promisify(execFile);

export type MacosSetupDetectorDependencies = {
  fetchStatus(url: string, signal?: AbortSignal): Promise<boolean>;
  command(
    file: string,
    args?: string[],
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string }>;
  probeSession(
    url: string,
    signal?: AbortSignal,
  ): Promise<{
    accessibility: boolean;
    uiInteraction: boolean;
    screenCapture: boolean;
    screenCaptureEmpty: boolean;
    error?: string;
    screenCaptureError?: string;
  }>;
  fingerprint(
    signal?: AbortSignal,
  ): Promise<SetupProcessFingerprint & { wdaPath?: string; appiumCommand?: string }>;
};

async function defaultFetchStatus(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const endpoint = new URL(url);
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/status`;
    const response = await fetch(endpoint, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(3_000)])
        : AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return false;
  }
}

async function defaultCommand(file: string, args: string[] = [], signal?: AbortSignal) {
  return exec(file, args, { timeout: 20_000, signal }).catch(
    (error: Error & { stdout?: string; stderr?: string }) => {
      if (signal?.aborted) throw signal.reason;
      return { stdout: error.stdout ?? '', stderr: error.stderr ?? error.message };
    },
  );
}

async function defaultFingerprint(signal?: AbortSignal) {
  const { stdout } = await defaultCommand('ps', ['-axo', 'pid,lstart,command'], signal);
  const lines = stdout.split('\n');
  const parse = (line: string | undefined) => {
    if (!line) return {};
    const match = /^\s*(\d+)\s+(.{24})\s+(.+)$/.exec(line);
    return match
      ? { pid: Number(match[1]), startedAt: match[2]!.trim(), command: match[3]!.trim() }
      : {};
  };
  const appium = parse(
    lines.find((line) => /(?:^|[\s/])appium(?:\s|$)/.test(line) && !/driver doctor/.test(line)),
  );
  const wda = parse(lines.find((line) => /WebDriverAgentRunner-Runner/.test(line)));
  return {
    appiumPid: appium.pid,
    appiumStartedAt: appium.startedAt,
    wdaPid: wda.pid,
    wdaStartedAt: wda.startedAt,
    wdaPath: wda.command?.split(' ')[0],
    appiumCommand: appium.command,
  };
}

async function defaultProbeSession(url: string, signal?: AbortSignal) {
  const endpoint = connection(url);
  let driver: Awaited<ReturnType<typeof remote>> | undefined;
  try {
    signal?.throwIfAborted();
    driver = await remote({
      ...endpoint,
      capabilities: { platformName: 'Mac', 'appium:automationName': 'Mac2' },
      logLevel: 'silent',
      connectionRetryCount: 0,
      connectionRetryTimeout: 30_000,
    });
    const source = await driver.getPageSource();
    signal?.throwIfAborted();
    let screenCaptureError: string | undefined;
    const screenshots = await driver.execute('macos: screenshots', {}).then(
      (value) => value as Record<string, { payload?: unknown }>,
      (error: unknown) => {
        screenCaptureError = error instanceof Error ? error.message : String(error);
        return {};
      },
    );
    signal?.throwIfAborted();
    const values = Object.values(screenshots ?? {});
    const screenCapture = values.some(
      (value) => typeof value.payload === 'string' && value.payload.length > 0,
    );
    return {
      accessibility: source.includes('XCUIElementType'),
      uiInteraction: true,
      screenCapture,
      screenCaptureEmpty: !values.length || !screenCapture,
      ...(screenCaptureError ? { screenCaptureError } : {}),
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const message = error instanceof Error ? error.message : String(error);
    return {
      accessibility: !/accessibility|not trusted|permission/i.test(message),
      uiInteraction: false,
      screenCapture: false,
      screenCaptureEmpty: false,
      error: message,
    };
  } finally {
    await driver?.deleteSession().catch(() => undefined);
  }
}

const defaults: MacosSetupDetectorDependencies = {
  fetchStatus: defaultFetchStatus,
  command: defaultCommand,
  probeSession: defaultProbeSession,
  fingerprint: defaultFingerprint,
};

export async function detectMacosSetup(
  input: { serverUrl?: string; signal?: AbortSignal } = {},
  dependencies: MacosSetupDetectorDependencies = defaults,
): Promise<SetupSnapshot> {
  const serverUrl = input.serverUrl ?? 'http://127.0.0.1:4723/';
  input.signal?.throwIfAborted();
  const fingerprint = await dependencies.fingerprint(input.signal);
  const serverReady = await dependencies.fetchStatus(serverUrl, input.signal);
  const capabilities: SetupCapability[] = [];
  capabilities.push(
    serverReady
      ? {
          id: 'appiumServer',
          status: 'ready',
          required: true,
          messageKey: 'capability.appium.ready',
        }
      : {
          id: 'appiumServer',
          status: 'action-required',
          required: true,
          messageKey: 'capability.appium.start',
          errorCode: 'APPIUM_SERVER_UNAVAILABLE',
          action: {
            id: 'start-appium',
            labelKey: 'action.startAppium',
            command: 'appium --address 127.0.0.1 --port 4723',
            estimatedMinutes: 1,
          },
        },
  );

  const driverList = await dependencies.command(
    'appium',
    ['driver', 'list', '--installed', '--json'],
    input.signal,
  );
  let mac2Version: string | undefined;
  try {
    const value = JSON.parse(driverList.stdout) as { mac2?: { version?: string } };
    mac2Version = value.mac2?.version;
  } catch {
    // Actionable capability below covers unreadable/missing Appium driver output.
  }
  capabilities.push(
    mac2Version
      ? {
          id: 'mac2Driver',
          status: 'ready',
          required: true,
          messageKey: 'capability.mac2.ready',
          details: { version: mac2Version },
        }
      : {
          id: 'mac2Driver',
          status: 'action-required',
          required: true,
          messageKey: 'capability.mac2.install',
          errorCode: 'MAC2_DRIVER_MISSING',
          action: {
            id: 'install-mac2',
            labelKey: 'action.installMac2',
            command: 'appium driver install mac2',
            estimatedMinutes: 2,
          },
        },
  );

  const automation = await dependencies.command('automationmodetool', [], input.signal);
  const automationReady = /Automation Mode is ENABLED/i.test(
    `${automation.stdout}\n${automation.stderr}`,
  );
  const requiresAuth = /requires user authentication/i.test(
    `${automation.stdout}\n${automation.stderr}`,
  );
  capabilities.push(
    automationReady && !requiresAuth
      ? {
          id: 'automationMode',
          status: 'ready',
          required: true,
          messageKey: 'capability.automation.ready',
        }
      : {
          id: 'automationMode',
          status: automationReady ? 'action-required' : 'unavailable',
          required: !automationReady,
          messageKey: automationReady
            ? 'capability.automation.auth'
            : 'capability.automation.unavailable',
          errorCode: 'AUTOMATION_MODE_AUTH_REQUIRED',
          action: {
            id: 'authenticate-automation-mode',
            labelKey: 'action.automationMode',
            command: 'automationmodetool enable-automationmode-without-authentication',
            requiresConfirmation: true,
          },
        },
  );

  if (serverReady && mac2Version) {
    const probe = await dependencies.probeSession(serverUrl, input.signal);
    capabilities.push(
      probe.accessibility
        ? {
            id: 'accessibility',
            status: 'ready',
            required: true,
            messageKey: 'capability.accessibility.ready',
          }
        : {
            id: 'accessibility',
            status: 'action-required',
            required: true,
            messageKey: 'capability.accessibility.required',
            errorCode: 'MACOS_ACCESSIBILITY_PERMISSION_REQUIRED',
            action: {
              id: 'open-accessibility',
              labelKey: 'action.openAccessibility',
              settingsUrl:
                'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
              estimatedMinutes: 1,
            },
          },
      probe.uiInteraction
        ? {
            id: 'uiInteraction',
            status: 'ready',
            required: true,
            messageKey: 'capability.interaction.ready',
          }
        : {
            id: 'uiInteraction',
            status: 'action-required',
            required: true,
            messageKey: 'capability.interaction.required',
            errorCode: 'MACOS_ACCESSIBILITY_PERMISSION_REQUIRED',
            details: probe.error ? { error: probe.error } : undefined,
            action: {
              id: 'open-accessibility',
              labelKey: 'action.openAccessibility',
              settingsUrl:
                'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
            },
          },
      probe.screenCapture
        ? {
            id: 'screenCapture',
            status: 'ready',
            required: false,
            messageKey: 'capability.screenshot.ready',
          }
        : {
            id: 'screenCapture',
            status: 'action-required',
            required: false,
            messageKey: 'capability.screenshot.required',
            errorCode: 'MACOS_SCREEN_CAPTURE_PERMISSION_REQUIRED',
            action: {
              id: 'open-screen-recording',
              labelKey: 'action.openScreenRecording',
              settingsUrl:
                'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
              estimatedMinutes: 1,
            },
            details: {
              emptyResult: probe.screenCaptureEmpty,
              ...(probe.screenCaptureError ? { error: probe.screenCaptureError } : {}),
            },
          },
    );
  } else {
    for (const capability of ['accessibility', 'uiInteraction', 'screenCapture'] as const)
      capabilities.push({
        id: capability,
        status: 'unknown',
        required: capability !== 'screenCapture',
        messageKey:
          capability === 'screenCapture'
            ? 'capability.screenshot.unknown'
            : 'capability.interaction.unknown',
      });
  }

  const doctor = await dependencies.command('appium', ['driver', 'doctor', 'mac2'], input.signal);
  const doctorText = `${doctor.stdout}\n${doctor.stderr}`;
  const fullDiskReady = !/Full Disk Access.*(?:missing|required|cannot)/i.test(doctorText);
  capabilities.push({
    id: 'fullDiskAccess',
    status: fullDiskReady ? 'ready' : 'action-required',
    required: false,
    messageKey: fullDiskReady ? 'capability.fullDisk.ready' : 'capability.fullDisk.required',
    ...(fullDiskReady
      ? {}
      : {
          errorCode: 'MACOS_FULL_DISK_ACCESS_REQUIRED' as const,
          action: {
            id: 'open-full-disk-access' as const,
            labelKey: 'action.openFullDiskAccess',
            settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
          },
        }),
  });
  const ffmpeg = await dependencies.command('sh', ['-lc', 'command -v ffmpeg'], input.signal);
  capabilities.push(
    ffmpeg.stdout.trim()
      ? {
          id: 'videoRecording',
          status: 'ready',
          required: false,
          messageKey: 'capability.video.ready',
        }
      : {
          id: 'videoRecording',
          status: 'unavailable',
          required: false,
          messageKey: 'capability.video.unavailable',
          errorCode: 'FFMPEG_MISSING',
          action: {
            id: 'install-ffmpeg',
            labelKey: 'action.installFfmpeg',
            command: 'brew install ffmpeg',
          },
        },
  );

  return aggregateSetup({
    platform: 'macos',
    capabilities,
    fingerprint,
    technicalDetails: {
      serverUrl,
      mac2Version,
      appiumPid: fingerprint.appiumPid,
      appiumCommand: fingerprint.appiumCommand,
      wdaPid: fingerprint.wdaPid,
      wdaPath: fingerprint.wdaPath,
      doctor: doctorText.slice(0, 8_000),
    },
  });
}
