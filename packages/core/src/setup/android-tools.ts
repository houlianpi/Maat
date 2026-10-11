import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { constants, createWriteStream } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

const exec = promisify(execFile);
const combination = 'platform-tools-37.0.1_aapt2-8.9.0-12782657';
const buildVersion = '8.9.0';
const noticeHash = '1c0a082e6d1591229d5bc1f93b52bafafa26eb4d0628055f296bd754d26c462c';
const sdkTerms = 'https://developer.android.com/studio/terms';
const maxDownloadBytes = 64 * 1024 * 1024;

type Artifact = { url: string; sha256: string; binarySha256?: string };
type Artifacts = { adb: Artifact; aapt2: Artifact; noticeSha256: string };
const google = 'https://dl.google.com';
const maven = `${google}/dl/android/maven2/com/android/tools/build/aapt2/8.9.0-12782657`;

/** Fixed official artifacts, not a latest-version installer. */
export const androidToolArtifacts: Record<'darwin' | 'linux' | 'win32', Artifacts> = {
  darwin: {
    adb: {
      url: `${google}/android/repository/platform-tools_r37.0.1-darwin.zip`,
      sha256: 'ee39ad5967e95c2a07f04dbcbde96b1a0c916ba376096db5d2f498b7727a5d1d',
    },
    aapt2: {
      url: `${maven}/aapt2-8.9.0-12782657-osx.jar`,
      sha256: '6773e3e7151e499ea01b1a5d684e9f259b8e2f32168c72beeba29287edb0347e',
      binarySha256: '213e3d049e2c85daa930ed777bbd5627c1c5479a8d6698029b8f9c0161ad0a7e',
    },
    noticeSha256: noticeHash,
  },
  linux: {
    adb: {
      url: `${google}/android/repository/platform-tools_r37.0.1-linux.zip`,
      sha256: 'd230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1',
    },
    aapt2: {
      url: `${maven}/aapt2-8.9.0-12782657-linux.jar`,
      sha256: '984ab36459db9eafae460cad648447e3d037aeae7423307364a4f53f093846f2',
      binarySha256: '9fa58e0125a111756f1c26acfe75a95a4fc273513bc2588781ced7b4ee1d2081',
    },
    noticeSha256: noticeHash,
  },
  win32: {
    adb: {
      url: `${google}/android/repository/platform-tools_r37.0.1-win.zip`,
      sha256: '45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99',
    },
    aapt2: {
      url: `${maven}/aapt2-8.9.0-12782657-windows.jar`,
      sha256: '4af08cca3fa6f7196c6cb303bdd73aa7265a730d4a035f184b4e153525fbb6ee',
      binarySha256: 'eac70ec5367c823a96432a1afb9f4f2bcf077148d957ed96935a5b338a1b0392',
    },
    noticeSha256: noticeHash,
  },
};

export type ResolvedAndroidTools = {
  sdkRoot?: string;
  adbPath?: string;
  aapt2Path?: string;
  source: 'environment' | 'system' | 'managed' | 'missing';
  /** Child-process patch only. Never applied to the parent process. */
  environment?: Record<string, string>;
  warnings?: Array<{
    code: 'ANDROID_SDK_INVALID' | 'ANDROID_SDK_ROOT_CONFLICT';
    summary: string;
  }>;
};

export type ResolveAndroidToolsOptions = {
  /** Explicit user intent: this SDK must be usable; never substitute another toolchain. */
  sdkRoot?: string;
  /** Parent directory of the fixed versioned SDK cache. */
  cacheDirectory?: string;
  signal?: AbortSignal;
};
export type PrepareAndroidToolsOptions = ResolveAndroidToolsOptions & {
  acceptSdkLicense?: boolean;
  /** Optional path-free progress for an authorized host shell. */
  onProgress?: (event: { tool: 'adb' | 'aapt2'; phase: 'download' | 'ready' }) => void;
};

// Source-internal seams for offline tests; not exported from the package entrypoint.
export type AndroidToolsDependencies = {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  arch: string;
  fetch: typeof fetch;
  probe(file: string, tool: 'adb' | 'aapt2', signal?: AbortSignal): Promise<boolean>;
  extract(file: string, directory: string, signal: AbortSignal): Promise<void>;
  artifacts: typeof androidToolArtifacts;
};

function failure(code: string, reason: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${reason}`), { code });
}

async function probe(file: string, tool: 'adb' | 'aapt2', signal?: AbortSignal) {
  try {
    const { stdout, stderr } = await exec(file, ['version'], {
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      signal,
    });
    return tool === 'adb'
      ? /Android Debug Bridge version 1\.0\.\d+/.test(stdout)
      : /Android Asset Packaging Tool|aapt2/i.test(`${stdout}\n${stderr}`);
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

function nextZipEntry(zip: ZipFile, signal: AbortSignal): Promise<Entry | undefined> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.removeListener('entry', entry);
      zip.removeListener('end', end);
      signal.removeEventListener('abort', abort);
    };
    const entry = (value: Entry) => {
      cleanup();
      resolve(value);
    };
    const end = () => {
      cleanup();
      resolve(undefined);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    zip.once('entry', entry);
    zip.once('end', end);
    signal.addEventListener('abort', abort, { once: true });
    zip.readEntry();
  });
}

function zipStream(zip: ZipFile, entry: Entry, signal: AbortSignal): Promise<Readable> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    zip.openReadStream(entry, (error, stream) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        stream?.destroy();
        reject(signal.reason);
      } else if (error) reject(error);
      else resolve(stream);
    });
  });
}

function openToolsArchive(file: string, signal: AbortSignal): Promise<ZipFile> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      yauzl.open(
        file,
        {
          lazyEntries: true,
          autoClose: false,
          strictFileNames: true,
          validateEntrySizes: true,
        },
        (error, zip) => {
          signal.removeEventListener('abort', abort);
          if (settled || signal.aborted) {
            // Opening cannot be cancelled inside yauzl. Release a late owned handle
            // without replacing the cancellation already returned to the caller.
            if (zip) {
              zip.on('error', () => {});
              try {
                zip.close();
              } catch {
                // Preserve the original Abort/deadline even if late cleanup fails.
              }
            }
            if (!settled) reject(signal.reason);
            settled = true;
            return;
          }
          settled = true;
          if (error) reject(error);
          else resolve(zip);
        },
      );
    } catch (error) {
      signal.removeEventListener('abort', abort);
      settled = true;
      reject(signal.aborted ? signal.reason : error);
    }
  });
}

// Source-internal export for real compressed-stream regression tests, not a package API.
// yauzl 3 uses _destroy/_cleanup: yauzl 2's fd-slicer marks a buffered stream destroyed
// at EOF, stranding its final buffered compressed bytes under Node 26 backpressure.
export async function extractAndroidToolsArchive(
  file: string,
  directory: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const stop = new AbortController();
  const bounded = AbortSignal.any([signal, stop.signal]);
  // A referenced, rejecting deadline, not an indefinite keepalive. A broken library
  // cannot leave a pending top-level await with no handles and silently exit 13.
  const timer = setTimeout(
    () =>
      stop.abort(
        failure('ANDROID_TOOLS_EXTRACT_TIMEOUT', 'Fixed tool archive extraction timed out.'),
      ),
    30_000,
  );
  let zip: ZipFile;
  try {
    zip = await openToolsArchive(file, bounded);
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
  let complete = false;
  let failed = false;
  const closed = new Promise<void>((resolve, reject) => {
    zip.once('close', resolve);
    zip.once('error', reject);
  });
  // Errors may arrive while entries are being read, before finally awaits close.
  // Observe that rejection now, but still propagate it from close when no primary exists.
  void closed.catch(() => {});
  zip.on('error', (error: unknown) => stop.abort(error));
  zip.on('close', () => {
    if (!complete && !bounded.aborted)
      stop.abort(
        failure('ANDROID_TOOLS_ARCHIVE_INVALID', 'Tool archive closed before completion.'),
      );
  });
  try {
    await mkdir(directory, { recursive: true });
    const root = await realpath(directory);
    let expanded = 0;
    let entries = 0;
    for (;;) {
      const entry = await nextZipEntry(zip, bounded);
      if (!entry) {
        complete = true;
        break;
      }
      expanded += entry.uncompressedSize;
      const mode = entry.externalFileAttributes >>> 16;
      const kind = mode & 0o170000;
      const destination = path.resolve(root, entry.fileName);
      const relative = path.relative(root, destination);
      if (
        ++entries > 2_000 ||
        expanded > 256 * 1024 * 1024 ||
        !Number.isSafeInteger(expanded) ||
        (kind !== 0 && kind !== 0o100000 && kind !== 0o040000) ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        entry.fileName.includes('\0')
      )
        throw failure('ANDROID_TOOLS_ARCHIVE_INVALID', 'Archive exceeds the fixed tool limits.');
      const isDirectory = kind === 0o040000 || entry.fileName.endsWith('/');
      await mkdir(isDirectory ? destination : path.dirname(destination), { recursive: true });
      bounded.throwIfAborted();
      if (isDirectory) continue;
      const input = await zipStream(zip, entry, bounded);
      await pipeline(
        input,
        createWriteStream(destination, {
          flags: 'wx',
          mode: mode & 0o777 || 0o644,
        }),
        { signal: bounded },
      );
    }
    bounded.throwIfAborted();
  } catch (error) {
    failed = true;
    bounded.throwIfAborted();
    throw error;
  } finally {
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      zip.close();
      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          closeTimer = setTimeout(
            () =>
              reject(
                failure(
                  'ANDROID_TOOLS_ARCHIVE_CLOSE_FAILED',
                  'Tool archive did not close in time.',
                ),
              ),
            3_000,
          );
        }),
      ]);
    } catch (error) {
      if (!failed) throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(closeTimer);
    }
  }
}

function defaults(): AndroidToolsDependencies {
  return {
    env: { ...process.env },
    home: homedir(),
    platform: process.platform,
    arch: process.arch,
    fetch: globalThis.fetch,
    probe,
    extract: extractAndroidToolsArchive,
    artifacts: androidToolArtifacts,
  };
}

function cacheRoot(options: ResolveAndroidToolsOptions, deps: AndroidToolsDependencies) {
  if (
    options.cacheDirectory !== undefined &&
    (typeof options.cacheDirectory !== 'string' || !options.cacheDirectory.trim())
  )
    throw failure('ANDROID_TOOLS_INVALID_INPUT', 'cacheDirectory must be a nonempty directory.');
  return path.resolve(options.cacheDirectory ?? path.join(deps.home, '.maat', 'tools', 'android'));
}

function validateOptions(options: ResolveAndroidToolsOptions) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw failure('ANDROID_TOOLS_INVALID_INPUT', 'Android tool options must be an object.');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    throw failure('ANDROID_TOOLS_INVALID_INPUT', 'signal must be an AbortSignal.');
  if (
    options.sdkRoot !== undefined &&
    (typeof options.sdkRoot !== 'string' || !options.sdkRoot.trim())
  )
    throw failure('ANDROID_TOOLS_INVALID_INPUT', 'sdkRoot must be a nonempty directory.');
}

function supported(deps: AndroidToolsDependencies): Artifacts {
  if (
    !(
      (deps.platform === 'darwin' && ['arm64', 'x64'].includes(deps.arch)) ||
      (deps.platform === 'linux' && deps.arch === 'x64') ||
      (deps.platform === 'win32' && deps.arch === 'x64')
    )
  )
    throw failure('ANDROID_TOOLS_UNSUPPORTED_PLATFORM', 'No verified artifacts for this OS/CPU.');
  return deps.artifacts[deps.platform as keyof typeof deps.artifacts];
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw failure('ANDROID_TOOLS_ACCESS_FAILED', 'Could not inspect Android tools.');
  }
}

async function usable(
  file: string,
  tool: 'adb' | 'aapt2',
  deps: AndroidToolsDependencies,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  try {
    if (!(await stat(file)).isFile()) return;
    await access(file, deps.platform === 'win32' ? constants.F_OK : constants.X_OK);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return;
    throw failure('ANDROID_TOOLS_ACCESS_FAILED', 'Could not inspect an Android executable.');
  }
  return (await deps.probe(file, tool, signal)) ? file : undefined;
}

function resolved(
  source: ResolvedAndroidTools['source'],
  deps: AndroidToolsDependencies,
  adbPath?: string,
  aapt2Path?: string,
  sdkRoot?: string,
): ResolvedAndroidTools {
  return {
    source,
    ...(adbPath ? { adbPath } : {}),
    ...(aapt2Path ? { aapt2Path } : {}),
    ...(sdkRoot ? { sdkRoot } : {}),
    ...(sdkRoot && adbPath && aapt2Path
      ? {
          environment: {
            ANDROID_HOME: sdkRoot,
            ANDROID_SDK_ROOT: sdkRoot,
            PATH: [
              path.dirname(adbPath),
              path.dirname(aapt2Path),
              deps.env.PATH ?? deps.env.Path ?? '',
            ].join(deps.platform === 'win32' ? ';' : ':'),
          },
        }
      : {}),
  };
}

async function sdkAt(
  root: string,
  source: ResolvedAndroidTools['source'],
  deps: AndroidToolsDependencies,
  signal?: AbortSignal,
) {
  const suffix = deps.platform === 'win32' ? '.exe' : '';
  const adb = await usable(path.join(root, 'platform-tools', `adb${suffix}`), 'adb', deps, signal);
  const builds = path.join(root, 'build-tools');
  let versions: string[] = [];
  if (await exists(builds)) {
    try {
      versions = await readdir(builds);
    } catch {
      throw failure('ANDROID_TOOLS_ACCESS_FAILED', 'Could not inspect SDK build tools.');
    }
  }
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions.filter((v) => /^\d+(?:\.\d+)+(?:[-\w.]*)$/.test(v))) {
    const aapt = await usable(path.join(builds, version, `aapt2${suffix}`), 'aapt2', deps, signal);
    if (aapt) return resolved(source, deps, adb, aapt, root);
  }
  return resolved(source, deps, adb, undefined, root);
}

const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

async function managedAt(root: string, deps: AndroidToolsDependencies, signal?: AbortSignal) {
  if (!(await exists(root))) return;
  const suffix = deps.platform === 'win32' ? '.exe' : '';
  const aapt = path.join(root, 'build-tools', buildVersion, `aapt2${suffix}`);
  try {
    const artifacts = supported(deps);
    // Verify native bytes and NOTICE before executing anything from the managed cache.
    if (
      digest(await readFile(aapt)) !== artifacts.aapt2.binarySha256 ||
      digest(await readFile(path.join(path.dirname(aapt), 'NOTICE'))) !== artifacts.noticeSha256
    )
      return;
    const metadata: unknown = JSON.parse(
      await readFile(path.join(root, 'maat-tools.json'), 'utf8'),
    );
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      !('version' in metadata) ||
      metadata.version !== combination ||
      !('adbSha256' in metadata) ||
      typeof metadata.adbSha256 !== 'string' ||
      digest(await readFile(path.join(root, 'platform-tools', `adb${suffix}`))) !==
        metadata.adbSha256
    )
      return;
    const adb = await usable(
      path.join(root, 'platform-tools', `adb${suffix}`),
      'adb',
      deps,
      signal,
    );
    const aapt2 = await usable(aapt, 'aapt2', deps, signal);
    return adb && aapt2 ? resolved('managed', deps, adb, aapt2, root) : undefined;
  } catch {
    signal?.throwIfAborted();
    return;
  }
}

/** Read-only and uncached: a later invocation sees newly prepared tools without restarting Pi. */
export async function resolveAndroidTools(
  options: ResolveAndroidToolsOptions = {},
  deps: AndroidToolsDependencies = defaults(),
): Promise<ResolvedAndroidTools> {
  validateOptions(options);
  options.signal?.throwIfAborted();
  const managedRoot = path.join(cacheRoot(options, deps), combination);
  const canonicalManaged = await realpath(managedRoot).catch(() => managedRoot);
  const candidateSdk = async (directory: string, source: ResolvedAndroidTools['source']) => {
    const canonical = await realpath(directory).catch(() => directory);
    return canonical === canonicalManaged
      ? ((await managedAt(managedRoot, deps, options.signal)) ?? resolved('missing', deps))
      : sdkAt(directory, source, deps, options.signal);
  };
  if (options.sdkRoot !== undefined) {
    const tools = await candidateSdk(path.resolve(options.sdkRoot), 'environment');
    if (!tools.environment)
      throw failure('ANDROID_SDK_INVALID', 'Explicit SDK lacks usable, verified adb or aapt2.');
    return tools;
  }
  const warnings: NonNullable<ResolvedAndroidTools['warnings']> = [];
  const withWarnings = (tools: ResolvedAndroidTools): ResolvedAndroidTools =>
    warnings.length ? { ...tools, warnings } : tools;
  const warnInspectionFailure = (error: unknown, summary: string) => {
    options.signal?.throwIfAborted();
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ANDROID_TOOLS_ACCESS_FAILED'
    )
      throw error;
    warnings.push({ code: 'ANDROID_SDK_INVALID', summary });
  };
  const home = deps.env.ANDROID_HOME;
  const root = deps.env.ANDROID_SDK_ROOT;
  if (home || root) {
    const directory = path.resolve(home || root!);
    let conflict = false;
    if (home && root) {
      const left = await realpath(path.resolve(home)).catch(() => path.resolve(home));
      const right = await realpath(path.resolve(root)).catch(() => path.resolve(root));
      conflict = left !== right;
    }
    if (conflict)
      warnings.push({
        code: 'ANDROID_SDK_ROOT_CONFLICT',
        summary: 'Inherited ANDROID_HOME and ANDROID_SDK_ROOT disagree; checking other toolchains.',
      });
    else {
      let inspectionFailed = false;
      try {
        const tools = await candidateSdk(directory, 'environment');
        if (tools.environment) return tools;
      } catch (error) {
        warnInspectionFailure(
          error,
          'Inherited SDK could not be inspected; checking other toolchains.',
        );
        // The inspection warning already explains this candidate's failure.
        inspectionFailed = true;
      }
      if (!inspectionFailed)
        warnings.push({
          code: 'ANDROID_SDK_INVALID',
          summary: 'Inherited SDK is unusable; checking other toolchains.',
        });
    }
  }
  const candidates =
    deps.platform === 'darwin'
      ? [path.join(deps.home, 'Library', 'Android', 'sdk')]
      : deps.platform === 'win32'
        ? [
            path.join(
              deps.env.LOCALAPPDATA ?? path.join(deps.home, 'AppData', 'Local'),
              'Android',
              'Sdk',
            ),
          ]
        : [path.join(deps.home, 'Android', 'Sdk'), '/opt/android-sdk', '/usr/lib/android-sdk'];
  let local: ResolvedAndroidTools | undefined;
  for (const candidate of candidates) {
    try {
      if (!(await exists(candidate))) continue;
      const tools = await candidateSdk(candidate, 'system');
      if (tools.adbPath && tools.aapt2Path) return withWarnings(tools);
      if (tools.adbPath) local ??= tools;
    } catch (error) {
      warnInspectionFailure(
        error,
        'Common SDK candidate could not be inspected; checking other toolchains.',
      );
    }
  }
  const suffix = deps.platform === 'win32' ? '.exe' : '';
  let adb = local?.adbPath;
  let aapt: string | undefined;
  for (const folder of (deps.env.PATH ?? deps.env.Path ?? '').split(
    deps.platform === 'win32' ? ';' : ':',
  )) {
    if (!folder) continue;
    const canonical = await realpath(folder).catch(() => path.resolve(folder));
    const relative = path.relative(canonicalManaged, canonical);
    // Managed cache entries must pass native/NOTICE checks before even probing.
    if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
      // A partially damaged cache may still supply its hash-verified ADB for repair.
      if (!adb && canonical === path.join(canonicalManaged, 'platform-tools')) {
        try {
          const metadata = JSON.parse(
            await readFile(path.join(managedRoot, 'maat-tools.json'), 'utf8'),
          );
          const file = path.join(canonical, `adb${suffix}`);
          if (
            metadata.version === combination &&
            digest(await readFile(file)) === metadata.adbSha256
          )
            adb = await usable(file, 'adb', deps, options.signal);
        } catch {
          options.signal?.throwIfAborted();
        }
      }
      continue;
    }
    adb ??= await usable(path.join(folder, `adb${suffix}`), 'adb', deps, options.signal);
    aapt ??= await usable(path.join(folder, `aapt2${suffix}`), 'aapt2', deps, options.signal);
  }
  // A PATH entry inside a real SDK is a toolchain, not just a standalone executable.
  if (adb) {
    const actual = await realpath(adb).catch(() => {
      throw failure('ANDROID_TOOLS_ACCESS_FAILED', 'Local ADB changed during resolution; recheck.');
    });
    if (path.basename(path.dirname(actual)) === 'platform-tools') {
      const inferredRoot = path.dirname(path.dirname(actual));
      // PATH must not bypass the pinned native/NOTICE checks for a managed SDK.
      if (inferredRoot !== canonicalManaged) {
        try {
          const sdk = await candidateSdk(inferredRoot, 'system');
          if (sdk.adbPath && sdk.aapt2Path) return withWarnings(sdk);
        } catch (error) {
          warnInspectionFailure(
            error,
            'PATH-inferred SDK could not be inspected; checking other toolchains.',
          );
        }
      }
    }
  }
  const managed = await managedAt(managedRoot, deps, options.signal);
  if (managed) return withWarnings(managed);
  return withWarnings(resolved(adb || aapt ? 'system' : 'missing', deps, adb, aapt));
}

async function download(
  artifact: Artifact,
  file: string,
  deps: AndroidToolsDependencies,
  signal: AbortSignal,
) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const response = await deps.fetch(artifact.url, { signal: bounded, redirect: 'error' });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw failure(
      'ANDROID_TOOLS_DOWNLOAD_FAILED',
      'Official tool download returned an HTTP error.',
    );
  }
  const length = Number(response.headers.get('content-length'));
  if (length > maxDownloadBytes) {
    await response.body.cancel().catch(() => {});
    throw failure(
      'ANDROID_TOOLS_DOWNLOAD_TOO_LARGE',
      'Official tool archive exceeds the size limit.',
    );
  }
  const handle = await open(file, 'wx', 0o600);
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let bytes = 0;
  const abort = () => void reader.cancel().catch(() => {});
  bounded.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      bounded.throwIfAborted();
      const chunk = await reader.read();
      bounded.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxDownloadBytes)
        throw failure(
          'ANDROID_TOOLS_DOWNLOAD_TOO_LARGE',
          'Official tool archive exceeds the size limit.',
        );
      hash.update(chunk.value);
      await handle.writeFile(chunk.value);
    }
    if (hash.digest('hex') !== artifact.sha256)
      throw failure('ANDROID_TOOLS_HASH_MISMATCH', 'Official tool archive checksum did not match.');
  } finally {
    bounded.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    await handle.close().catch(() => {});
  }
}

function progress(
  options: PrepareAndroidToolsOptions,
  tool: 'adb' | 'aapt2',
  phase: 'download' | 'ready',
) {
  // Progress is supplemental; a host's logger must not turn a successful publish into failure.
  try {
    options.onProgress?.({ tool, phase });
  } catch {
    // No paths, stderr, or environment are logged here.
  }
}

async function pinnedLocalAapt(
  file: string | undefined,
  artifacts: Artifacts,
): Promise<{ binary: string; notice: string } | undefined> {
  if (!file) return;
  try {
    const binary = await realpath(file);
    const notice = path.join(path.dirname(binary), 'NOTICE');
    if (
      digest(await readFile(binary)) === artifacts.aapt2.binarySha256 &&
      digest(await readFile(notice)) === artifacts.noticeSha256
    )
      return { binary, notice };
  } catch {
    // A local standalone executable without its original NOTICE is not a reusable artifact.
  }
}

/** Explicit network/filesystem action. Never installs Studio, Java, or changes global environment. */
export async function prepareAndroidTools(
  options: PrepareAndroidToolsOptions = {},
  deps: AndroidToolsDependencies = defaults(),
): Promise<ResolvedAndroidTools> {
  validateOptions(options);
  if (options.acceptSdkLicense !== undefined && typeof options.acceptSdkLicense !== 'boolean')
    throw failure('ANDROID_TOOLS_INVALID_INPUT', 'acceptSdkLicense must be boolean.');
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function')
    throw failure('ANDROID_TOOLS_INVALID_INPUT', 'onProgress must be a function.');
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        failure('ANDROID_TOOLS_PREPARE_TIMEOUT', 'Android tool preparation timed out.'),
      ),
    180_000,
  );
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), deadline.signal]);
  try {
    return await preparePinnedAndroidTools(options, deps, signal);
  } finally {
    clearTimeout(timer);
  }
}

async function preparePinnedAndroidTools(
  options: PrepareAndroidToolsOptions,
  deps: AndroidToolsDependencies,
  signal: AbortSignal,
): Promise<ResolvedAndroidTools> {
  signal.throwIfAborted();
  const artifacts = supported(deps);
  const initial = await resolveAndroidTools({ ...options, signal }, deps);
  if (initial.environment) return initial;
  if (!initial.adbPath && options.acceptSdkLicense !== true)
    throw failure(
      'ANDROID_SDK_LICENSE_REQUIRED',
      `Accept the Google SDK license explicitly: ${sdkTerms}`,
    );
  const parent = cacheRoot(options, deps);
  const target = path.join(parent, combination);
  const lock = path.join(parent, `.${combination}.lock`);
  let locked = false;
  let staging: string | undefined;
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    while (!locked) {
      signal.throwIfAborted();
      try {
        await mkdir(lock, { mode: 0o700 });
        locked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // Cross-process contenders wait, never remove another process's lock or staging.
        await delay(50, undefined, { signal });
      }
    }
    const current = await resolveAndroidTools({ ...options, signal }, deps);
    if (current.environment) return current;
    if (!current.adbPath && options.acceptSdkLicense !== true)
      throw failure(
        'ANDROID_SDK_LICENSE_REQUIRED',
        `Accept the Google SDK license explicitly: ${sdkTerms}`,
      );
    if (await exists(target)) {
      const metadata = await readFile(path.join(target, 'maat-tools.json'), 'utf8')
        .then((text): unknown => JSON.parse(text))
        .catch(() => undefined);
      if (
        !metadata ||
        typeof metadata !== 'object' ||
        !('version' in metadata) ||
        metadata.version !== combination
      )
        throw failure(
          'ANDROID_TOOLS_CACHE_INCOMPLETE',
          'Reserved cache directory is not a verified Maat cache; inspect it explicitly before preparing.',
        );
    }
    staging = await mkdtemp(path.join(parent, '.prepare-'));
    const sdk = path.join(staging, 'sdk');
    await mkdir(sdk);
    const suffix = deps.platform === 'win32' ? '.exe' : '';
    const platformTools = path.join(sdk, 'platform-tools');
    if (current.adbPath) {
      const actual = await realpath(current.adbPath);
      const directory = path.dirname(actual);
      if (path.basename(actual) !== `adb${suffix}`)
        throw failure(
          'ANDROID_ADB_LAYOUT_UNSUPPORTED',
          'Local ADB target must retain its original executable name.',
        );
      // Keep accompanying macOS libraries and Windows DLLs, not just the executable.
      const canonicalTarget = await realpath(target).catch(() => target);
      const relative = path.relative(canonicalTarget, actual);
      if (
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      ) {
        // Repair must not publish a link into the old cache that will be moved away.
        await cp(directory, platformTools, { recursive: true, dereference: true });
      } else {
        try {
          await symlink(directory, platformTools, deps.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
          if (!['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? ''))
            throw error;
          if (path.basename(directory) !== 'platform-tools')
            throw failure(
              'ANDROID_ADB_LAYOUT_UNSUPPORTED',
              'Cannot safely copy a standalone ADB directory; allow local directory linking.',
            );
          await cp(directory, platformTools, { recursive: true, dereference: true });
        }
      }
    } else {
      progress(options, 'adb', 'download');
      const archive = path.join(staging, 'platform-tools.zip');
      await download(artifacts.adb, archive, deps, signal);
      await deps.extract(archive, sdk, signal);
      const properties = await readFile(path.join(platformTools, 'source.properties'), 'utf8');
      if (!/^Pkg\.Revision\s*=\s*37\.0\.1\s*$/m.test(properties))
        throw failure(
          'ANDROID_TOOLS_VERSION_MISMATCH',
          'Platform-tools metadata does not match the pin.',
        );
      await writeFile(
        path.join(sdk, 'SDK-LICENSE.txt'),
        `Google Android SDK terms: ${sdkTerms}\nExplicitly accepted for this download.\n`,
      );
    }
    let localAapt = await pinnedLocalAapt(current.aapt2Path, artifacts);
    if (!localAapt) {
      progress(options, 'aapt2', 'download');
      const archive = path.join(staging, 'aapt2.jar');
      await download(artifacts.aapt2, archive, deps, signal);
      const unpacked = path.join(staging, 'aapt2');
      await deps.extract(archive, unpacked, signal);
      localAapt = {
        binary: path.join(unpacked, `aapt2${suffix}`),
        notice: path.join(unpacked, 'NOTICE'),
      };
    }
    const { binary, notice } = localAapt;
    if (
      digest(await readFile(binary)) !== artifacts.aapt2.binarySha256 ||
      digest(await readFile(notice)) !== artifacts.noticeSha256
    )
      throw failure(
        'ANDROID_TOOLS_HASH_MISMATCH',
        'AAPT native executable or NOTICE did not match.',
      );
    const build = path.join(sdk, 'build-tools', buildVersion);
    await mkdir(build, { recursive: true });
    await copyFile(binary, path.join(build, `aapt2${suffix}`));
    await copyFile(notice, path.join(build, 'NOTICE'));
    if (deps.platform !== 'win32') await chmod(path.join(build, 'aapt2'), 0o755);
    await writeFile(path.join(build, 'source.properties'), `Pkg.Revision=${buildVersion}\n`);
    const adbFile = path.join(platformTools, `adb${suffix}`);
    await writeFile(
      path.join(sdk, 'maat-tools.json'),
      JSON.stringify({
        version: combination,
        adbSha256: digest(await readFile(adbFile)),
        adbOrigin: current.adbPath ? 'local' : 'google',
        aapt2Version: '8.9.0-12782657',
      }),
    );
    const checked = await managedAt(sdk, deps, signal);
    if (!checked)
      throw failure(
        'ANDROID_TOOLS_PREPARE_FAILED',
        'Prepared toolchain is incomplete or not executable.',
      );
    signal.throwIfAborted();
    // Only replace an incomplete Maat-owned cache, and only after the new SDK is verified.
    const previous = path.join(staging, 'previous');
    const hadPrevious = await exists(target);
    if (hadPrevious) await rename(target, previous);
    try {
      await rename(sdk, target);
    } catch (error) {
      if (hadPrevious) {
        try {
          await rename(previous, target);
        } catch {
          // Do not delete the previous cache if an OS/filesystem failure blocks rollback.
          staging = undefined;
          throw failure(
            'ANDROID_TOOLS_PUBLISH_FAILED',
            'Cache publish and rollback failed; previous cache was preserved in the preparation directory.',
          );
        }
      }
      throw error;
    }
    progress(options, 'adb', 'ready');
    progress(options, 'aapt2', 'ready');
    return {
      ...resolved(
        'managed',
        deps,
        path.join(target, 'platform-tools', `adb${suffix}`),
        path.join(target, 'build-tools', buildVersion, `aapt2${suffix}`),
        target,
      ),
      ...(current.warnings ? { warnings: current.warnings } : {}),
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && 'code' in error && String(error.code).startsWith('ANDROID_'))
      throw error;
    throw failure(
      'ANDROID_TOOLS_PREPARE_FAILED',
      'Could not prepare the fixed Android tool cache.',
    );
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (locked) await rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A CLI client can kill/restart an incompatible existing daemon. Check host:version first.
 * No daemon management; no device commands. Cold readiness uses its own raw protocol unchanged.
 */
export async function assertAdbServerCompatible(
  adbPath: string,
  signal?: AbortSignal,
  dependencies: {
    connectAdb?: () => Socket;
    clientVersion?: (file: string, signal?: AbortSignal) => Promise<string>;
  } = {},
): Promise<void> {
  if (process.env.ADB_SERVER_SOCKET || process.env.ANDROID_ADB_SERVER_PORT)
    throw failure(
      'ADB_SERVER_CONFIGURATION_UNSUPPORTED',
      'Use the configured ADB server directly; local CLI safety cannot be verified.',
    );
  const version = await new Promise<string | undefined>((resolve, reject) => {
    signal?.throwIfAborted();
    const socket = dependencies.connectAdb
      ? dependencies.connectAdb()
      : connect({ host: '127.0.0.1', port: 5037 });
    let data = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: unknown, value?: string) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const abort = () =>
      finish(
        signal?.reason ?? failure('ADB_SERVER_CHECK_ABORTED', 'ADB compatibility check aborted.'),
      );
    signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(3_000, () =>
      finish(failure('ADB_SERVER_CHECK_FAILED', 'ADB host query timed out.')),
    );
    socket.on('connect', () => socket.write('000chost:version'));
    socket.on('error', (error: NodeJS.ErrnoException) =>
      error.code === 'ECONNREFUSED'
        ? finish()
        : finish(failure('ADB_SERVER_CHECK_FAILED', 'ADB host query failed.')),
    );
    socket.on('end', () =>
      finish(failure('ADB_SERVER_CHECK_FAILED', 'Incomplete ADB host response.')),
    );
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 64)
        return finish(failure('ADB_SERVER_CHECK_FAILED', 'Invalid ADB host response.'));
      if (data.length < 12) return;
      if (!/^OKAY0004[0-9a-f]{4}$/i.test(data.toString('ascii')))
        return finish(failure('ADB_SERVER_CHECK_FAILED', 'Invalid ADB host response.'));
      finish(undefined, data.toString('ascii', 8, 12));
    });
    if (signal?.aborted) abort();
  });
  if (version === undefined) return;
  try {
    const stdout = dependencies.clientVersion
      ? await dependencies.clientVersion(adbPath, signal)
      : (await exec(adbPath, ['version'], { timeout: 5_000, maxBuffer: 128 * 1024, signal }))
          .stdout;
    const client = /Android Debug Bridge version 1\.0\.(\d+)/.exec(stdout);
    if (!client || Number(client[1]) !== Number.parseInt(version, 16))
      throw failure(
        'ADB_SERVER_VERSION_MISMATCH',
        'Existing ADB server is incompatible; do not automatically restart it.',
      );
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && 'code' in error && error.code === 'ADB_SERVER_VERSION_MISMATCH')
      throw error;
    throw failure('ADB_SERVER_CHECK_FAILED', 'Could not safely verify the ADB client version.');
  }
}
