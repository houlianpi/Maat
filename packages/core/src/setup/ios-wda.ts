import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isRecord } from '../core/exploration/protocol.ts';
import { errorWithCleanupFailure } from '../core/exploration/runtime.ts';
import { discoverIosDevices, matchIosDevices, type IosDevice } from './ios-devices.ts';
import { resolveAppiumCommand } from './appium-command.ts';
import type { NativeDeviceSelector } from '../platforms/appium/schema.ts';

export type IosWdaInspection = {
  state: 'ready' | 'missing' | 'expired' | 'needs-signing';
  summary: string;
  signingConfigured: boolean;
  profile?: {
    createdAt: string;
    expiresAt: string;
    expired: boolean;
    includesSelectedDevice: boolean;
  };
  certificate?: { expiresAt: string; expired: boolean };
  /** Internal Session configuration. Never render raw paths or signing identity in diagnostics. */
  capabilities?: Record<string, unknown>;
};

export type IosWdaInput = {
  device?: NativeDeviceSelector;
  capabilities?: Record<string, unknown>;
  signal?: AbortSignal;
};

type CommandOptions = { timeout: number; signal?: AbortSignal };
type Dependencies = {
  hostPlatform: NodeJS.Platform;
  devices(signal?: AbortSignal): Promise<IosDevice[]>;
  command(file: string, args: string[], options: CommandOptions): Promise<string>;
  project(signal?: AbortSignal): Promise<string>;
  now(): number;
  cacheRoot: string;
};

export async function runIosWdaCommand(
  file: string,
  args: string[],
  options: CommandOptions,
): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          failure = errorWithCleanupFailure(
            failure ?? new Error('IOS_WDA_PREPARATION_FAILED: preparation failed.'),
            new Error('IOS_WDA_CLEANUP_FAILED: the preparation process could not be stopped.'),
          );
      }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      kill('SIGTERM');
      escalation = setTimeout(() => {
        kill('SIGKILL');
        reject(failure);
      }, 1000);
    };
    const abort = () =>
      stop(
        new Error('IOS_WDA_PREPARATION_CANCELLED: preparation was cancelled.', {
          cause: options.signal?.reason,
        }),
      );
    const deadline = setTimeout(
      () => stop(new Error('IOS_WDA_PREPARATION_TIMEOUT: preparation timed out.')),
      options.timeout,
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    const append = (data: Buffer, stream: 'stdout' | 'stderr') => {
      bytes += data.length;
      if (bytes > 2 * 1024 * 1024)
        return stop(new Error('IOS_WDA_OUTPUT_LIMIT: preparation output exceeded its limit.'));
      if (stream === 'stdout') stdout += data.toString();
      else stderr += data.toString();
    };
    child.stdout.on('data', (data) => append(data, 'stdout'));
    child.stderr.on('data', (data) => append(data, 'stderr'));
    child.once('error', () => {
      failure ??= new Error(
        'IOS_WDA_COMMAND_FAILED: a required preparation command could not start.',
      );
    });
    child.once('close', (code) => {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', abort);
      // A parent close does not prove that its owned process group has exited.
      if (failure && escalation) return;
      if (failure) reject(failure);
      else if (code !== 0) {
        const signing =
          /no accounts|authentication|not logged in|no profiles|requires a development team|signing certificate|session has expired/i.test(
            stderr,
          );
        reject(
          new Error(
            signing
              ? 'IOS_WDA_SIGNING_REQUIRED: complete Xcode account and existing Team signing yourself, then retry.'
              : `IOS_WDA_COMMAND_FAILED: preparation command exited with ${code ?? 'no exit status'}; no automatic retry was attempted.`,
          ),
        );
      } else resolve(stdout);
    });
    if (options.signal?.aborted) abort();
  });
}

async function defaultProject(signal?: AbortSignal) {
  const appium = await resolveAppiumCommand({ signal });
  const data: unknown = JSON.parse(
    await runIosWdaCommand(
      appium.file,
      [...appium.args, 'driver', 'list', '--installed', '--json'],
      { timeout: 10_000, signal },
    ),
  );
  if (!isRecord(data) || !isRecord(data.xcuitest) || typeof data.xcuitest.installPath !== 'string')
    throw new Error(
      'XCUITEST_DRIVER_MISSING: install the compatible iOS automation driver before WDA preparation.',
    );
  const require = createRequire(path.join(data.xcuitest.installPath, 'package.json'));
  const manifest = require.resolve('appium-webdriveragent/package.json');
  return path.join(path.dirname(manifest), 'WebDriverAgent.xcodeproj');
}

const defaults: Dependencies = {
  hostPlatform: process.platform,
  devices: discoverIosDevices,
  command: runIosWdaCommand,
  project: defaultProject,
  now: Date.now,
  cacheRoot: path.join(homedir(), '.maat', 'tools', 'ios', 'wda'),
};

type Context = {
  phone: IosDevice;
  project: string;
  team: string;
  bundle: string;
  buildRoot: string;
  app: string;
  inspection?: IosWdaInspection;
};

async function context(
  input: IosWdaInput,
  deps: Dependencies,
): Promise<Context | IosWdaInspection> {
  input.signal?.throwIfAborted();
  if (deps.hostPlatform !== 'darwin')
    throw new Error(
      'IOS_HOST_UNSUPPORTED: iPhone signing preparation requires macOS and full Xcode.',
    );
  if (input.device?.kind !== undefined && input.device.kind !== 'device')
    throw new Error('IOS_WDA_DEVICE_REQUIRED: preparation requires the selected physical iPhone.');
  const phones = matchIosDevices(await deps.devices(input.signal), input.device);
  if (phones.length !== 1 || !phones[0]?.connected || phones[0].paired !== true)
    throw new Error(
      'IOS_WDA_DEVICE_REQUIRED: connect and select exactly one paired physical iPhone; no other device was substituted.',
    );
  if (
    input.capabilities?.['appium:udid'] !== undefined &&
    input.capabilities['appium:udid'] !== phones[0].id
  )
    throw new Error('IOS_WDA_IDENTITY_CONFLICT: the selected phone changed during WDA inspection.');
  const project = await deps.project(input.signal);
  const settings = await deps.command(
    'xcodebuild',
    [
      '-project',
      project,
      '-scheme',
      'WebDriverAgentRunner',
      '-sdk',
      'iphoneos',
      '-destination',
      'generic/platform=iOS',
      '-showBuildSettings',
    ],
    { timeout: 30_000, signal: input.signal },
  );
  const runner = settings
    .split('Build settings for action build and target ')
    .find((block) => block.startsWith('WebDriverAgentRunner:'));
  const team = /^[ \t]*DEVELOPMENT_TEAM = (\S+)[ \t]*$/m.exec(runner ?? '')?.[1];
  const bundle = /^[ \t]*PRODUCT_BUNDLE_IDENTIFIER = (\S+)[ \t]*$/m.exec(runner ?? '')?.[1];
  if (!team || !bundle)
    return {
      state: 'needs-signing',
      signingConfigured: false,
      summary:
        'Choose your existing signing Team in the WDA Runner Xcode project. No account, Team or bundle identifier was selected or changed automatically.',
    };
  const caps = input.capabilities ?? {};
  const options = isRecord(caps['appium:options']) ? caps['appium:options'] : {};
  const org = options.xcodeOrgId ?? options['appium:xcodeOrgId'] ?? caps['appium:xcodeOrgId'];
  const requestedBundle =
    options.updatedWDABundleId ??
    options['appium:updatedWDABundleId'] ??
    caps['appium:updatedWDABundleId'];
  if (
    (org !== undefined && org !== team) ||
    (requestedBundle !== undefined && requestedBundle !== bundle)
  )
    throw new Error(
      'IOS_WDA_IDENTITY_CONFLICT: Session hints conflict with the existing signing Team or WDA identifier.',
    );
  const configured =
    caps['appium:derivedDataPath'] ?? options.derivedDataPath ?? options['appium:derivedDataPath'];
  if (configured !== undefined && (typeof configured !== 'string' || !path.isAbsolute(configured)))
    throw new Error(
      'IOS_WDA_BUILD_PATH_INVALID: the configured build path must be an absolute directory.',
    );
  const key = createHash('sha256')
    .update(`${project}\0${team}\0${bundle}`)
    .digest('hex')
    .slice(0, 20);
  const buildRoot = typeof configured === 'string' ? configured : path.join(deps.cacheRoot, key);
  const base: Context = {
    phone: phones[0],
    project,
    team,
    bundle,
    buildRoot,
    app: path.join(
      buildRoot,
      'Build',
      'Products',
      'Debug-iphoneos',
      'WebDriverAgentRunner-Runner.app',
    ),
  };
  if (configured !== undefined) return base;
  const buildDirectory = /^[ \t]*BUILD_DIR = (.+)$/m.exec(runner ?? '')?.[1]?.trim();
  const candidates = [
    ...new Set([
      buildRoot,
      ...(buildDirectory && path.isAbsolute(buildDirectory)
        ? [path.resolve(buildDirectory, '..', '..')]
        : []),
    ]),
  ];
  let fallback: Context | undefined;
  for (const candidate of candidates) {
    const ctx: Context = {
      ...base,
      buildRoot: candidate,
      app: path.join(
        candidate,
        'Build',
        'Products',
        'Debug-iphoneos',
        'WebDriverAgentRunner-Runner.app',
      ),
    };
    ctx.inspection = await inspect(ctx, input, deps);
    if (ctx.inspection.state === 'ready') return ctx;
    if (!fallback || fallback.inspection?.state === 'missing') fallback = ctx;
  }
  return fallback ?? base;
}

function configuration(ctx: Context): Record<string, unknown> {
  return {
    'appium:usePrebuiltWDA': true,
    'appium:usePreinstalledWDA': false,
    'appium:derivedDataPath': ctx.buildRoot,
    'appium:updatedWDABundleId': ctx.bundle,
    'appium:useNewWDA': false,
    'appium:prebuildWDA': false,
    'appium:useSimpleBuildTest': false,
    'appium:useXctestrunFile': false,
    'appium:allowProvisioningUpdates': false,
    'appium:allowProvisioningDeviceRegistration': false,
    'appium:wdaStartupRetries': 1,
  };
}

function isoDate(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new Error('IOS_WDA_PROFILE_INVALID: provisioning dates could not be read.');
  return new Date(value).toISOString();
}

async function inspect(
  ctx: Context,
  input: IosWdaInput,
  deps: Dependencies,
): Promise<IosWdaInspection> {
  const profileFile = path.join(ctx.app, 'embedded.mobileprovision');
  try {
    await access(profileFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      state: 'missing',
      signingConfigured: true,
      summary:
        'No signed WDA build exists at the selected build location. Existing signing settings will be preserved.',
    };
  }
  await deps.command('codesign', ['--verify', '--deep', '--strict', ctx.app], {
    timeout: 15_000,
    signal: input.signal,
  });
  const info: unknown = JSON.parse(
    await deps.command(
      'plutil',
      ['-convert', 'json', '-o', '-', path.join(ctx.app, 'Info.plist')],
      { timeout: 5000, signal: input.signal },
    ),
  );
  if (!isRecord(info) || info.CFBundleIdentifier !== `${ctx.bundle}.xctrunner`)
    throw new Error(
      'IOS_WDA_IDENTITY_CONFLICT: the existing build does not match the configured WDA identifier; no signing or deployment was changed.',
    );
  const xml = await deps.command('security', ['cms', '-D', '-i', profileFile], {
    timeout: 10_000,
    signal: input.signal,
  });
  // Keep the complete profile private; extracting public facts avoids a second plist dependency.
  const dictionary = /<plist\b[^>]*>\s*<dict>([\s\S]*)<\/dict>\s*<\/plist>/.exec(xml)?.[1];
  const value = (key: string, tag: string) =>
    new RegExp(`<key>${key}</key>\\s*<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(dictionary ?? '')?.[1];
  const createdAt = isoDate(value('CreationDate', 'date'));
  const expiresAt = isoDate(value('ExpirationDate', 'date'));
  const devices = value('ProvisionedDevices', 'array');
  const identifiers = devices
    ? [...devices.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]!)
    : [];
  const enterprise = /<key>ProvisionsAllDevices<\/key>\s*<true\s*\/>/.test(dictionary ?? '');
  const applicationIdentifier = value('application-identifier', 'string');
  const prefixes = value('ApplicationIdentifierPrefix', 'array');
  const teams = value('TeamIdentifier', 'array');
  if (
    !prefixes ||
    ![...prefixes.matchAll(/<string>([^<]*)<\/string>/g)].some(
      (match) => applicationIdentifier === `${match[1]}.${ctx.bundle}.xctrunner`,
    ) ||
    !teams ||
    ![...teams.matchAll(/<string>([^<]*)<\/string>/g)].some((match) => match[1] === ctx.team)
  )
    throw new Error(
      'IOS_WDA_IDENTITY_CONFLICT: the profile does not match the existing signing Team and WDA identifier.',
    );
  const includesSelectedDevice = enterprise || identifiers.includes(ctx.phone.id);
  if (!includesSelectedDevice)
    return {
      state: 'needs-signing',
      signingConfigured: true,
      summary:
        'The existing provisioning profile does not include the selected iPhone. Complete device provisioning with your existing Xcode Team.',
      profile: {
        createdAt,
        expiresAt,
        expired: Date.parse(expiresAt) <= deps.now(),
        includesSelectedDevice,
      },
    };
  const temporary = await mkdtemp(path.join(tmpdir(), 'maat-wda-certificate-'));
  let certificate: IosWdaInspection['certificate'];
  let certificateFailure: unknown;
  try {
    const prefix = path.join(temporary, 'certificate');
    await deps.command('codesign', ['-d', `--extract-certificates=${prefix}`, ctx.app], {
      timeout: 10_000,
      signal: input.signal,
    });
    const leaf = new X509Certificate(await readFile(`${prefix}0`));
    const certificates = value('DeveloperCertificates', 'array');
    if (
      !certificates ||
      ![...certificates.matchAll(/<data>([\s\S]*?)<\/data>/g)].some((match) =>
        Buffer.from(match[1]!.replace(/\s/g, ''), 'base64').equals(leaf.raw),
      )
    )
      throw new Error(
        'IOS_WDA_IDENTITY_CONFLICT: the build certificate does not belong to its provisioning profile.',
      );
    const expires = isoDate(leaf.validTo);
    certificate = { expiresAt: expires, expired: Date.parse(expires) <= deps.now() };
  } catch (error) {
    certificateFailure = error;
  } finally {
    try {
      await rm(temporary, { recursive: true, force: true });
    } catch (error) {
      certificateFailure = certificateFailure
        ? errorWithCleanupFailure(certificateFailure, error)
        : error;
    }
  }
  if (certificateFailure) throw certificateFailure;
  if (!certificate)
    throw new Error('IOS_WDA_CERTIFICATE_INVALID: no valid build certificate was found.');
  input.signal?.throwIfAborted();
  const profile = {
    createdAt,
    expiresAt,
    expired: Date.parse(expiresAt) <= deps.now(),
    includesSelectedDevice,
  };
  const expired = profile.expired || certificate.expired;
  return {
    state: expired ? 'expired' : 'ready',
    signingConfigured: true,
    profile,
    certificate,
    summary: expired
      ? 'The existing WDA certificate or provisioning profile has expired. Renew only WDA with the existing signing configuration after authorization.'
      : 'The existing signed WDA build is current and matches the selected iPhone. Reuse it; this does not prove phone control or developer-profile trust.',
    ...(expired ? {} : { capabilities: configuration(ctx) }),
  };
}

export async function inspectIosWda(
  input: IosWdaInput = {},
  deps: Dependencies = defaults,
): Promise<IosWdaInspection> {
  const ctx = await context(input, deps);
  return 'state' in ctx ? ctx : (ctx.inspection ?? inspect(ctx, input, deps));
}

/** Read-only cold connection checks; only the driver performs an explicitly permitted deployment. */
export async function resolveIosWdaReuse(
  input: IosWdaInput,
  allowInstallation = false,
  deps: Dependencies = defaults,
): Promise<Record<string, unknown>> {
  const ctx = await context(input, deps);
  const result = 'state' in ctx ? ctx : (ctx.inspection ?? (await inspect(ctx, input, deps)));
  if ('state' in ctx || result.state !== 'ready' || !result.capabilities)
    throw new Error(
      'IOS_WDA_SIGNING_REQUIRED: prepare a current device-matching WDA build with your existing Team. Signing or renewal requires explicit authorization; no Session was created.',
    );
  let data: unknown;
  try {
    data = JSON.parse(
      await deps.command(
        'xcrun',
        [
          'devicectl',
          'device',
          'info',
          'apps',
          '--device',
          ctx.phone.id,
          '--quiet',
          '--timeout',
          '5',
          '--json-output',
          '-',
        ],
        { timeout: 10_000, signal: input.signal },
      ),
    );
  } catch (error) {
    input.signal?.throwIfAborted();
    throw new Error(
      'IOS_WDA_INSPECTION_FAILED: installed control-component state could not be read; no installation or Session was started.',
      { cause: error },
    );
  }
  if (!isRecord(data) || !isRecord(data.result) || !Array.isArray(data.result.apps))
    throw new Error(
      'IOS_WDA_INSPECTION_FAILED: CoreDevice returned an invalid installed-app list.',
    );
  const identifiers = data.result.apps.map((app: unknown) => {
    if (
      !isRecord(app) ||
      typeof app.bundleIdentifier !== 'string' ||
      !app.bundleIdentifier.trim() ||
      typeof app.name !== 'string' ||
      !app.name.trim()
    )
      throw new Error('IOS_WDA_INSPECTION_FAILED: CoreDevice returned invalid App metadata.');
    return { id: app.bundleIdentifier, name: app.name };
  });
  const bundleId = `${ctx.bundle}.xctrunner`;
  if (
    identifiers.some(
      (app) =>
        app.id !== bundleId &&
        (/WebDriverAgentRunner/i.test(app.name) || app.id.endsWith('.xctrunner')),
    )
  )
    throw new Error(
      'IOS_WDA_CONFIGURATION_CONFLICT: another test Runner is installed. Startup cleanup cannot be safely scoped; choose a safe configuration explicitly. No App was removed.',
    );
  if (!identifiers.some((app) => app.id === bundleId) && !allowInstallation)
    throw new Error(
      'IOS_WDA_INSTALLATION_AUTHORIZATION_REQUIRED: the selected iPhone does not have this control component. Explain the first installation and obtain user authorization before allowing it; no Session was created.',
    );
  input.signal?.throwIfAborted();
  return result.capabilities;
}

export async function prepareIosWda(
  input: IosWdaInput & { signingAuthorized: boolean },
  deps: Dependencies = defaults,
): Promise<IosWdaInspection> {
  if (typeof input.signingAuthorized !== 'boolean')
    throw new Error('IOS_WDA_AUTHORIZATION_INVALID: signing authorization must be a boolean.');
  const ctx = await context(input, deps);
  if ('state' in ctx) return ctx;
  const existing = ctx.inspection ?? (await inspect(ctx, input, deps));
  if (existing.state === 'ready') return existing;
  if (!input.signingAuthorized)
    throw new Error(
      'IOS_WDA_SIGNING_AUTHORIZATION_REQUIRED: authorize this build or renewal with the existing signing configuration; no changes were made.',
    );
  if (existing.state === 'needs-signing') return existing;
  const projectFile = path.join(ctx.project, 'project.pbxproj');
  const fingerprint = async () =>
    createHash('sha256')
      .update(await readFile(projectFile))
      .digest('hex');
  const before = await fingerprint();
  await deps.command(
    'xcodebuild',
    [
      '-project',
      ctx.project,
      '-scheme',
      'WebDriverAgentRunner',
      '-configuration',
      'Debug',
      '-sdk',
      'iphoneos',
      '-destination',
      `id=${ctx.phone.id}`,
      '-derivedDataPath',
      ctx.buildRoot,
      '-allowProvisioningUpdates',
      'CODE_SIGN_STYLE=Automatic',
      'build-for-testing',
      '-quiet',
    ],
    { timeout: 240_000, signal: input.signal },
  );
  if (before !== (await fingerprint()))
    throw new Error(
      'IOS_WDA_SIGNING_CHANGED: Xcode changed the project unexpectedly; no Session configuration was applied.',
    );
  const result = await inspect(ctx, input, deps);
  if (result.state !== 'ready')
    throw new Error(
      'IOS_WDA_BUILD_INVALID: the build did not produce a current device-matching signed WDA.',
    );
  return result;
}
