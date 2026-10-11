import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { crc32, deflateRawSync } from 'node:zlib';
import yauzl, { type ZipFile } from 'yauzl';
import {
  androidToolArtifacts,
  assertAdbServerCompatible,
  extractAndroidToolsArchive,
  prepareAndroidTools,
  resolveAndroidTools,
  type AndroidToolsDependencies,
} from '../packages/core/src/setup/android-tools.ts';
import { discoverDevices } from '../packages/core/src/setup/devices.ts';
import { discoverApplications } from '../packages/core/src/setup/applications.ts';
import {
  defaultCommand,
  defaultSdkTools,
  detectAndroidSetup,
} from '../packages/core/src/setup-assistant/android-detector.ts';
import type { NativeEnvironment } from '../packages/core/src/platforms/appium/schema.ts';
import { resolveAppiumCommand } from '../packages/core/src/setup/appium-command.ts';

const pin = 'platform-tools-37.0.1_aapt2-8.9.0-12782657';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const adbArchive = 'verified adb archive fixture';
const aaptArchive = 'verified aapt archive fixture';
const adbNative = 'fixture adb client';
const aaptNative = 'fixture aapt native';
const notice = 'fixture Apache 2.0 NOTICE';
const exec = promisify(execFile);

test('Windows Appium npm global and local shims resolve to Node plus manifest JS without a shell', async (t) => {
  const f = await fixture(t);
  for (const local of [false, true]) {
    const folder = local
      ? path.join(f.root, 'project', 'node_modules', '.bin')
      : path.join(f.root, 'npm global prefix');
    const root = local
      ? path.join(folder, '..', 'appium')
      : path.join(folder, 'node_modules', 'appium');
    await file(
      path.join(folder, 'appium.cmd'),
      'untrusted shim text must never be parsed or executed',
    );
    await file(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'appium',
        bin: { appium: './build/lib/main.js' },
      }),
    );
    const entry = path.join(root, 'build', 'lib', 'main.js');
    await file(entry, 'fixture JS entry');
    const command = await resolveAppiumCommand(
      {},
      {
        platform: 'win32',
        env: { PATH: folder },
        nodePath: process.execPath,
      },
    );
    assert.deepEqual(command, { file: process.execPath, args: [await realpath(entry)] });
    const calls: Array<{ file: string; args: string[] }> = [];
    const result = await defaultCommand(
      'appium',
      ['--version'],
      undefined,
      resolveAndroidTools,
      async (file, args) => {
        calls.push({ file, args });
        return { stdout: '3.7.0\n', stderr: '' };
      },
      async () => command,
    );
    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls, [
      { file: process.execPath, args: [await realpath(entry), '--version'] },
    ]);
  }
});

test('Appium resolution preserves non-Windows PATH semantics and distinguishes missing from broken Windows installs', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await resolveAppiumCommand(
      {},
      {
        platform: 'darwin',
        env: { PATH: '' },
        nodePath: process.execPath,
      },
    ),
    { file: 'appium', args: [] },
  );
  const folder = path.join(f.root, 'npm');
  const resolveWindows: typeof resolveAppiumCommand = (options) =>
    resolveAppiumCommand(options, {
      platform: 'win32',
      env: { PATH: folder },
      nodePath: process.execPath,
    });
  const command = async () => {
    throw new Error('No shell or CLI should run');
  };
  assert.equal(
    (
      await defaultCommand(
        'appium',
        ['--version'],
        undefined,
        resolveAndroidTools,
        command,
        resolveWindows,
      )
    ).failure,
    'not-found',
  );
  await file(path.join(folder, 'appium.cmd'), 'do not execute');
  assert.equal(
    (
      await defaultCommand(
        'appium',
        ['--version'],
        undefined,
        resolveAndroidTools,
        command,
        resolveWindows,
      )
    ).failure,
    'failed',
  );
  await file(
    path.join(folder, 'node_modules', 'appium', 'package.json'),
    JSON.stringify({
      name: 'appium',
      bin: { appium: '../../outside.js' },
    }),
  );
  await file(path.join(folder, 'outside.js'), 'do not execute');
  await assert.rejects(resolveWindows(), { code: 'APPIUM_CLI_INVALID' });
});

// ZIP writer for synthetic test data only. Parsing/extraction remains entirely in yauzl.
function zipFixture(entries: Array<{ name: string; data: Buffer; mode?: number }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const compressed = deflateRawSync(entry.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(entry.data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50);
    index.writeUInt16LE((3 << 8) | 20, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt16LE(8, 10);
    index.writeUInt32LE(crc32(entry.data), 16);
    index.writeUInt32LE(compressed.length, 20);
    index.writeUInt32LE(entry.data.length, 24);
    index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(((entry.mode ?? 0o100755) << 16) >>> 0, 38);
    index.writeUInt32LE(offset, 42);
    central.push(index, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test('real compressed ZIP stream drains its buffered tail and settles in a fresh Node process', async (t) => {
  const f = await fixture(t);
  const payload = Buffer.alloc(4 * 1024 * 1024);
  let random = 123456789;
  for (let offset = 0; offset < payload.length; offset += 32768) {
    for (let index = 0; index < 4096; index++) {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      payload[offset + index] = random & 255;
    }
    for (let repeat = 1; repeat < 8; repeat++)
      payload.copy(payload, offset + repeat * 4096, offset, offset + 4096);
  }
  const archive = path.join(f.root, 'compressed.jar');
  await writeFile(
    archive,
    zipFixture([
      { name: 'aapt2-fixture', data: payload },
      { name: 'NOTICE', data: Buffer.from(notice) },
    ]),
  );
  const output = path.join(f.root, 'extracted');
  const module = new URL('../packages/core/src/setup/android-tools.ts', import.meta.url).href;
  const { stdout } = await exec(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `import {extractAndroidToolsArchive} from ${JSON.stringify(module)};
     await extractAndroidToolsArchive(process.argv[1], process.argv[2], new AbortController().signal);
     console.log('extraction settled');`,
      archive,
      output,
    ],
    { timeout: 15_000, maxBuffer: 128 * 1024 },
  );
  assert.equal(stdout.trim(), 'extraction settled');
  assert.ok((await readFile(path.join(output, 'aapt2-fixture'))).equals(payload));
  assert.equal(await readFile(path.join(output, 'NOTICE'), 'utf8'), notice);
});

test('real extractor rejects malformed ZIPs, traversal and symlinks without changing surrounding files', async (t) => {
  const f = await fixture(t);
  const sentinel = path.join(f.root, 'keep');
  await writeFile(sentinel, 'untouched');
  for (const [index, contents] of [
    Buffer.from('not a ZIP'),
    zipFixture([{ name: '../keep', data: Buffer.from('overwrite') }]),
    zipFixture([{ name: 'symlink', data: Buffer.from('../keep'), mode: 0o120777 }]),
  ].entries()) {
    const archive = path.join(f.root, `invalid-${index}.zip`);
    await writeFile(archive, contents);
    await assert.rejects(
      extractAndroidToolsArchive(
        archive,
        path.join(f.root, `out-${index}`),
        new AbortController().signal,
      ),
    );
  }
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
});

test('archive opening observes Abort/deadline, closes a late owned handle, and cleans prepare staging', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const scenario of ['abort-late-handle', 'abort-late-error', 'deadline-no-callback']) {
    const f = await fixture(t);
    const controller = new AbortController();
    const reason = new Error('host cancelled pending archive open');
    let callback!: (error: Error | null, zip: ZipFile) => void;
    let started!: () => void;
    const opening = new Promise<void>((resolve) => {
      started = resolve;
    });
    const mock = t.mock.method(
      yauzl,
      'open',
      (_file: string, _options: unknown, done: typeof callback) => {
        callback = done;
        started();
      },
    );
    f.deps.extract = extractAndroidToolsArchive;
    const preparing = prepareAndroidTools(
      { ...f.options, acceptSdkLicense: true, signal: controller.signal },
      f.deps,
    );
    await opening;
    if (scenario === 'deadline-no-callback') t.mock.timers.tick(30_001);
    else controller.abort(reason);
    if (scenario === 'deadline-no-callback')
      await assert.rejects(preparing, { code: 'ANDROID_TOOLS_EXTRACT_TIMEOUT' });
    else await assert.rejects(preparing, (error) => error === reason);
    assert.deepEqual(await readdir(f.options.cacheDirectory), []);
    if (scenario === 'abort-late-handle') {
      let closes = 0;
      const lateZip = Object.assign(new EventEmitter(), {
        readEntry: () => assert.fail('Cancelled opening must not read an entry'),
        close: () => {
          closes++;
          queueMicrotask(() => lateZip.emit('error', new Error('late owned close error')));
        },
      });
      callback(null, lateZip as unknown as ZipFile);
      await Promise.resolve();
      assert.equal(closes, 1);
    } else if (scenario === 'abort-late-error') {
      callback(new Error('late open callback error'), undefined as unknown as ZipFile);
      await Promise.resolve();
    }
    mock.mock.restore();
  }
});

test('asynchronous archive close errors propagate directly after success but never replace a primary error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const broken of [false, true]) {
    const f = await fixture(t);
    const primary = new Error('original entry failure');
    const closeError = new Error('underlying descriptor close failed');
    let closes = 0;
    const zip = Object.assign(new EventEmitter(), {
      readEntry: () => queueMicrotask(() => zip.emit(broken ? 'error' : 'end', primary)),
      close: () => {
        closes++;
        queueMicrotask(() => zip.emit('error', closeError));
      },
    });
    const mock = t.mock.method(
      yauzl,
      'open',
      (_file: string, _options: unknown, callback: (error: Error | null, value: ZipFile) => void) =>
        callback(null, zip as unknown as ZipFile),
    );
    await assert.rejects(
      extractAndroidToolsArchive(
        path.join(f.root, 'fixture.zip'),
        path.join(f.root, 'output'),
        new AbortController().signal,
      ),
      (error) => error === (broken ? primary : closeError),
    );
    assert.equal(closes, 1);
    mock.mock.restore();
  }
});

test('a non-settling ZIP reader hits an explicit extraction deadline rather than exit 13', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const zip = Object.assign(new EventEmitter(), {
    readEntry: () => started(),
    close: () => zip.emit('close'),
  });
  t.mock.method(
    yauzl,
    'open',
    (_file: string, _options: unknown, callback: (error: Error | null, value: ZipFile) => void) =>
      callback(null, zip as unknown as ZipFile),
  );
  const extracting = extractAndroidToolsArchive(
    path.join(f.root, 'fixture.zip'),
    path.join(f.root, 'output'),
    new AbortController().signal,
  );
  await reading;
  t.mock.timers.tick(30_001);
  await assert.rejects(extracting, { code: 'ANDROID_TOOLS_EXTRACT_TIMEOUT' });
});

test('prepare deadline rejects explicitly and removes its own lock and staging', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started!: () => void;
  const extracting = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.deps.extract = async (_file, _directory, signal) => {
    started();
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  };
  const preparing = prepareAndroidTools({ ...f.options, acceptSdkLicense: true }, f.deps);
  await extracting;
  t.mock.timers.tick(180_001);
  await assert.rejects(preparing, { code: 'ANDROID_TOOLS_PREPARE_TIMEOUT' });
  assert.deepEqual(await readdir(f.options.cacheDirectory), []);
});

test('archive close is bounded and cannot replace the primary extraction error', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const broken of [false, true]) {
    let started!: () => void;
    const closing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const primary = new Error('original extraction failure');
    const zip = Object.assign(new EventEmitter(), {
      readEntry: () => zip.emit(broken ? 'error' : 'end', primary),
      close: () => started(),
    });
    const mock = t.mock.method(
      yauzl,
      'open',
      (_file: string, _options: unknown, callback: (error: Error | null, value: ZipFile) => void) =>
        callback(null, zip as unknown as ZipFile),
    );
    const extracting = extractAndroidToolsArchive(
      path.join(f.root, 'fixture.zip'),
      path.join(f.root, `output-${broken}`),
      new AbortController().signal,
    );
    await closing;
    t.mock.timers.tick(3_001);
    if (broken) await assert.rejects(extracting, (error) => error === primary);
    else await assert.rejects(extracting, { code: 'ANDROID_TOOLS_ARCHIVE_CLOSE_FAILED' });
    mock.mock.restore();
  }
});

async function file(name: string, contents: string) {
  await mkdir(path.dirname(name), { recursive: true });
  await writeFile(name, contents);
  await chmod(name, 0o755);
}

async function fixture(t: TestContext, platform: NodeJS.Platform = 'darwin', arch = 'arm64') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'maat-android-tools-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDirectory = path.join(root, 'cache');
  const home = path.join(root, 'home');
  const downloads: string[] = [];
  const probes: string[] = [];
  const extractions: string[] = [];
  const artifacts = {
    adb: { url: 'https://fixture.invalid/adb.zip', sha256: hash(adbArchive) },
    aapt2: {
      url: 'https://fixture.invalid/aapt2.jar',
      sha256: hash(aaptArchive),
      binarySha256: hash(aaptNative),
    },
    noticeSha256: hash(notice),
  };
  const suffix = platform === 'win32' ? '.exe' : '';
  const deps: AndroidToolsDependencies = {
    env: { PATH: '' },
    home,
    platform,
    arch,
    artifacts: { darwin: artifacts, linux: artifacts, win32: artifacts },
    fetch: async (url) => {
      downloads.push(String(url));
      return new Response(String(url).endsWith('adb.zip') ? adbArchive : aaptArchive);
    },
    probe: async (name, tool) => {
      probes.push(name);
      return (await readFile(name, 'utf8')) === (tool === 'adb' ? adbNative : aaptNative);
    },
    extract: async (archive, directory, signal) => {
      signal.throwIfAborted();
      extractions.push(archive);
      if ((await readFile(archive, 'utf8')) === adbArchive) {
        await file(path.join(directory, 'platform-tools', `adb${suffix}`), adbNative);
        await file(
          path.join(directory, 'platform-tools', 'source.properties'),
          'Pkg.Revision=37.0.1\n',
        );
        await file(path.join(directory, 'platform-tools', 'NOTICE.txt'), 'Google archive notice');
        await file(path.join(directory, 'platform-tools', 'AdbWinApi.dll'), 'companion fixture');
      } else {
        await file(path.join(directory, `aapt2${suffix}`), aaptNative);
        await file(path.join(directory, 'NOTICE'), notice);
      }
    },
  };
  const options = { cacheDirectory };
  const sdk = path.join(cacheDirectory, pin);
  const localSdk = async (directory = path.join(root, 'local-sdk')) => {
    await file(path.join(directory, 'platform-tools', `adb${suffix}`), adbNative);
    await file(path.join(directory, 'platform-tools', 'companion-library'), 'keep this library');
    await file(path.join(directory, 'build-tools', '35.0.0', `aapt2${suffix}`), aaptNative);
    return directory;
  };
  return { root, home, sdk, options, deps, downloads, probes, extractions, localSdk, suffix };
}

test('resolve is read-only; license gate precedes network/filesystem writes and has a stable code', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await resolveAndroidTools(f.options, f.deps), { source: 'missing' });
  await assert.rejects(prepareAndroidTools(f.options, f.deps), {
    code: 'ANDROID_SDK_LICENSE_REQUIRED',
  });
  assert.deepEqual(f.downloads, []);
  assert.deepEqual(await readdir(f.root), []);
});

test('no SDK env or PATH: explicit prepare publishes a verified managed SDK visible on the next resolve', async (t) => {
  const f = await fixture(t);
  const parentEnvironment = { ...process.env };
  const inputEnvironment = { ...f.deps.env };
  const progress: unknown[] = [];
  const prepared = await prepareAndroidTools(
    { ...f.options, acceptSdkLicense: true, onProgress: (event) => progress.push(event) },
    f.deps,
  );
  assert.equal(prepared.source, 'managed');
  assert.equal(prepared.sdkRoot, f.sdk);
  assert.equal(prepared.adbPath, path.join(f.sdk, 'platform-tools', 'adb'));
  assert.equal(prepared.aapt2Path, path.join(f.sdk, 'build-tools', '8.9.0', 'aapt2'));
  assert.deepEqual(Object.keys(prepared.environment!).sort(), [
    'ANDROID_HOME',
    'ANDROID_SDK_ROOT',
    'PATH',
  ]);
  assert.equal(prepared.environment!.ANDROID_HOME, f.sdk);
  assert.equal(prepared.environment!.ANDROID_SDK_ROOT, f.sdk);
  assert.equal(await readFile(path.join(f.sdk, 'build-tools', '8.9.0', 'NOTICE'), 'utf8'), notice);
  assert.deepEqual(await resolveAndroidTools(f.options, f.deps), prepared);
  assert.deepEqual(f.deps.env, inputEnvironment);
  assert.ok(
    Object.keys(process.env).length === Object.keys(parentEnvironment).length &&
      Object.entries(parentEnvironment).every(([key, value]) => process.env[key] === value),
    'Parent environment must remain unchanged',
  );
  assert.deepEqual(progress, [
    { tool: 'adb', phase: 'download' },
    { tool: 'aapt2', phase: 'download' },
    { tool: 'adb', phase: 'ready' },
    { tool: 'aapt2', phase: 'ready' },
  ]);
  const again = await prepareAndroidTools(f.options, f.deps);
  assert.deepEqual(again, prepared);
  assert.equal(f.downloads.length, 2);
  assert.deepEqual(await readdir(f.options.cacheDirectory), [pin]);
});

test('valid explicit SDK is authoritative and reused without network or license acceptance', async (t) => {
  const f = await fixture(t);
  const root = await f.localSdk();
  f.deps.env = { ANDROID_HOME: root, ANDROID_SDK_ROOT: root, PATH: 'original-path' };
  const tools = await resolveAndroidTools(f.options, f.deps);
  assert.equal(tools.source, 'environment');
  assert.equal(tools.sdkRoot, root);
  assert.equal(tools.environment!.PATH.endsWith(':original-path'), true);
  assert.deepEqual(await prepareAndroidTools(f.options, f.deps), tools);
  assert.deepEqual(f.downloads, []);
});

test('invalid/conflicting inherited SDKs warn and reuse verified cache without mutating parent env', async (t) => {
  const f = await fixture(t);
  await prepareAndroidTools({ ...f.options, acceptSdkLicense: true }, f.deps);
  f.deps.env.ANDROID_HOME = path.join(f.root, 'private-user', 'invalid');
  f.deps.env.ANDROID_SDK_ROOT = path.join(f.root, 'other');
  const conflictEnv = { ...f.deps.env };
  const conflict = await resolveAndroidTools(f.options, f.deps);
  assert.equal(conflict.source, 'managed');
  assert.equal(conflict.warnings?.[0]?.code, 'ANDROID_SDK_ROOT_CONFLICT');
  assert.deepEqual(f.deps.env, conflictEnv);
  delete f.deps.env.ANDROID_SDK_ROOT;
  const parentEnv = { ...process.env };
  const inputEnv = { ...f.deps.env };
  for (const action of [resolveAndroidTools, prepareAndroidTools]) {
    const tools = await action(f.options, f.deps);
    assert.equal(tools.source, 'managed');
    assert.equal(tools.warnings?.[0]?.code, 'ANDROID_SDK_INVALID');
    assert.equal(JSON.stringify(tools.warnings).includes(f.root), false);
    assert.equal(tools.environment?.ANDROID_HOME, f.sdk);
    assert.equal(tools.environment?.ANDROID_SDK_ROOT, f.sdk);
    assert.deepEqual(f.deps.env, inputEnv);
    assert.equal(JSON.stringify({ ...process.env }) === JSON.stringify(parentEnv), true);
  }
  assert.equal(f.downloads.length, 2);
});

test('invalid inherited SDK without cache still permits licensed preparation; explicit sdkRoot stays strict', async (t) => {
  const f = await fixture(t);
  const invalid = path.join(f.root, 'private-user', 'bad-sdk');
  f.deps.env.ANDROID_HOME = invalid;
  const inputEnv = { ...f.deps.env };
  await assert.rejects(prepareAndroidTools(f.options, f.deps), {
    code: 'ANDROID_SDK_LICENSE_REQUIRED',
  });
  assert.deepEqual(f.downloads, []);
  for (const action of [resolveAndroidTools, prepareAndroidTools]) {
    await assert.rejects(
      action({ ...f.options, sdkRoot: invalid, acceptSdkLicense: true }, f.deps),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ANDROID_SDK_INVALID/);
        assert.equal(error.message.includes(f.root), false);
        return true;
      },
    );
  }
  const tools = await prepareAndroidTools({ ...f.options, acceptSdkLicense: true }, f.deps);
  assert.equal(tools.source, 'managed');
  assert.equal(tools.warnings?.[0]?.code, 'ANDROID_SDK_INVALID');
  assert.deepEqual(f.deps.env, inputEnv);
  const valid = await f.localSdk();
  assert.equal(
    (await resolveAndroidTools({ ...f.options, sdkRoot: valid }, f.deps)).sdkRoot,
    valid,
  );
});

test('inherited SDK inspection failure falls back, but corrupt managed bytes cannot bypass verification via env or PATH', async (t) => {
  const f = await fixture(t);
  await prepareAndroidTools({ ...f.options, acceptSdkLicense: true }, f.deps);
  const root = await f.localSdk();
  f.deps.env.ANDROID_HOME = root;
  const probe = f.deps.probe;
  f.deps.probe = async (file, tool, signal) => {
    if (file.startsWith(root))
      throw Object.assign(new Error('private SDK inspection failed'), {
        code: 'ANDROID_TOOLS_ACCESS_FAILED',
      });
    return probe(file, tool, signal);
  };
  const resolved = await resolveAndroidTools(f.options, f.deps);
  assert.equal(resolved.source, 'managed');
  assert.equal(resolved.warnings?.[0]?.code, 'ANDROID_SDK_INVALID');
  assert.equal(JSON.stringify(resolved.warnings).includes(root), false);
  f.deps.env = {
    ANDROID_HOME: f.sdk,
    PATH: path.join(f.sdk, 'platform-tools'),
  };
  await writeFile(path.join(f.sdk, 'platform-tools', 'adb'), 'corrupt adb');
  const before = f.probes.length;
  assert.equal((await resolveAndroidTools(f.options, f.deps)).source, 'missing');
  assert.equal(f.probes.length, before);
  await assert.rejects(resolveAndroidTools({ ...f.options, sdkRoot: f.sdk }, f.deps), {
    code: 'ANDROID_SDK_INVALID',
  });
});

test('inherited common SDK readdir failure and PATH reinference warn then reuse a verified cache', async (t) => {
  const f = await fixture(t);
  await prepareAndroidTools({ ...f.options, acceptSdkLicense: true }, f.deps);
  const common = await f.localSdk(path.join(f.home, 'Library', 'Android', 'sdk'));
  // Deterministic inspection failure even as root: stat succeeds, readdir fails.
  // This exercises the same SDK access error boundary as an unreadable directory.
  await rm(path.join(common, 'build-tools'), { recursive: true });
  await writeFile(path.join(common, 'build-tools'), 'not a directory');
  f.deps.env = { ANDROID_HOME: common, PATH: path.join(common, 'platform-tools') };
  const inputEnv = { ...f.deps.env };
  const parentEnv = { ...process.env };
  for (const action of [resolveAndroidTools, prepareAndroidTools]) {
    const tools = await action(f.options, f.deps);
    assert.equal(tools.source, 'managed');
    assert.equal(tools.sdkRoot, f.sdk);
    assert.deepEqual(
      tools.warnings?.map(({ code }) => code),
      ['ANDROID_SDK_INVALID', 'ANDROID_SDK_INVALID', 'ANDROID_SDK_INVALID'],
    );
    assert.match(tools.warnings![0]!.summary, /Inherited SDK could not be inspected/);
    assert.match(tools.warnings![1]!.summary, /Common SDK candidate could not be inspected/);
    assert.match(tools.warnings![2]!.summary, /PATH-inferred SDK could not be inspected/);
    assert.equal(JSON.stringify(tools.warnings).includes(f.root), false);
    assert.deepEqual(f.deps.env, inputEnv);
    assert.equal(JSON.stringify({ ...process.env }) === JSON.stringify(parentEnv), true);
  }
  assert.equal(f.downloads.length, 2);
  await assert.rejects(resolveAndroidTools({ ...f.options, sdkRoot: common }, f.deps), {
    code: 'ANDROID_TOOLS_ACCESS_FAILED',
  });

  // Unknown implementation errors must not be hidden as candidate inspection failures.
  const probe = f.deps.probe;
  const unexpected = new Error('unexpected candidate implementation failure');
  f.deps.env = { PATH: '' };
  f.deps.probe = async (file, tool, signal) => {
    if (file.startsWith(common)) throw unexpected;
    return probe(file, tool, signal);
  };
  await assert.rejects(resolveAndroidTools(f.options, f.deps), (error) => error === unexpected);
  const controller = new AbortController();
  const reason = new Error('cancelled common SDK inspection');
  f.deps.probe = async (file, tool, signal) => {
    if (file.startsWith(common)) {
      controller.abort(reason);
      throw Object.assign(new Error('candidate inspection failed'), {
        code: 'ANDROID_TOOLS_ACCESS_FAILED',
      });
    }
    return probe(file, tool, signal);
  };
  await assert.rejects(
    resolveAndroidTools({ ...f.options, signal: controller.signal }, f.deps),
    (error) => error === reason,
  );
});

test('inherited common SDK readdir failure without cache permits authorized preparation with or without PATH', async (t) => {
  for (const onPath of [false, true]) {
    const f = await fixture(t);
    const common = await f.localSdk(path.join(f.home, 'Library', 'Android', 'sdk'));
    await rm(path.join(common, 'build-tools'), { recursive: true });
    await writeFile(path.join(common, 'build-tools'), 'not a directory');
    f.deps.env = { ANDROID_HOME: common, PATH: onPath ? path.join(common, 'platform-tools') : '' };
    const inputEnv = { ...f.deps.env };
    const parentEnv = { ...process.env };
    const tools = await prepareAndroidTools({ ...f.options, acceptSdkLicense: true }, f.deps);
    assert.equal(tools.source, 'managed');
    assert.equal(tools.sdkRoot, f.sdk);
    assert.equal(tools.environment?.ANDROID_HOME, f.sdk);
    assert.equal(tools.environment?.ANDROID_SDK_ROOT, f.sdk);
    assert.equal(tools.warnings?.length, onPath ? 3 : 2);
    assert.ok(tools.warnings?.every(({ code }) => code === 'ANDROID_SDK_INVALID'));
    assert.equal(JSON.stringify(tools.warnings).includes(f.root), false);
    assert.deepEqual(await resolveAndroidTools(f.options, f.deps), tools);
    assert.deepEqual(f.deps.env, inputEnv);
    assert.equal(JSON.stringify({ ...process.env }) === JSON.stringify(parentEnv), true);
    assert.equal(f.downloads.length, onPath ? 1 : 2);
    assert.equal(await readFile(path.join(common, 'build-tools'), 'utf8'), 'not a directory');
  }
});

test('common SDK roots and a PATH entry into an SDK are reused without exports', async (t) => {
  const f = await fixture(t);
  const common = await f.localSdk(path.join(f.home, 'Library', 'Android', 'sdk'));
  assert.equal((await resolveAndroidTools(f.options, f.deps)).sdkRoot, common);
  await rm(common, { recursive: true });
  const sdk = await f.localSdk();
  f.deps.env.PATH = path.join(sdk, 'platform-tools');
  const resolved = await resolveAndroidTools(f.options, f.deps);
  assert.equal(resolved.source, 'system');
  assert.equal(resolved.sdkRoot, sdk);
  assert.deepEqual(await prepareAndroidTools(f.options, f.deps), resolved);
  assert.deepEqual(f.downloads, []);
});

test('local ADB alone permits discovery but is not a complete SDK; prepare retains its whole directory', async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.root, 'local-platform-tools');
  await file(path.join(directory, 'adb'), adbNative);
  await file(path.join(directory, 'libadb.dylib'), 'companion library');
  f.deps.env.PATH = directory;
  const partial = await resolveAndroidTools(f.options, f.deps);
  assert.equal(partial.adbPath, path.join(directory, 'adb'));
  assert.equal(partial.source, 'system');
  assert.equal(partial.sdkRoot, undefined);
  assert.equal(partial.environment, undefined);
  const prepared = await prepareAndroidTools(f.options, f.deps);
  assert.equal(prepared.source, 'managed');
  assert.deepEqual(f.downloads, ['https://fixture.invalid/aapt2.jar']);
  assert.equal(await realpath(path.dirname(prepared.adbPath!)), directory);
  assert.equal(
    await readFile(path.join(f.sdk, 'platform-tools', 'libadb.dylib'), 'utf8'),
    'companion library',
  );
  assert.deepEqual(await resolveAndroidTools(f.options, f.deps), prepared);
});

test('pinned standalone local AAPT plus NOTICE is reused without any downloads', async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.root, 'tools');
  await file(path.join(directory, 'adb'), adbNative);
  await file(path.join(directory, 'aapt2'), aaptNative);
  await file(path.join(directory, 'NOTICE'), notice);
  f.deps.env.PATH = directory;
  const result = await prepareAndroidTools(f.options, f.deps);
  assert.equal(result.source, 'managed');
  assert.deepEqual(f.downloads, []);
});

test('fixed artifacts support only verified OS/CPU pairs, including Windows executable names', async (t) => {
  for (const [platform, arch] of [
    ['darwin', 'x64'],
    ['linux', 'x64'],
    ['win32', 'x64'],
  ] as const) {
    const f = await fixture(t, platform, arch);
    const result = await prepareAndroidTools({ ...f.options, acceptSdkLicense: true }, f.deps);
    assert.ok(result.adbPath!.endsWith(`adb${f.suffix}`));
    assert.ok(result.aapt2Path!.endsWith(`aapt2${f.suffix}`));
    assert.equal(result.environment!.PATH.includes(platform === 'win32' ? ';' : ':'), true);
  }
  for (const [platform, arch] of [
    ['linux', 'arm64'],
    ['win32', 'arm64'],
    ['freebsd', 'x64'],
  ] as const) {
    const f = await fixture(t, platform, arch);
    await assert.rejects(prepareAndroidTools({ ...f.options, acceptSdkLicense: true }, f.deps), {
      code: 'ANDROID_TOOLS_UNSUPPORTED_PLATFORM',
    });
    assert.deepEqual(f.downloads, []);
    assert.deepEqual(await readdir(f.root), []);
  }
  for (const artifacts of Object.values(androidToolArtifacts)) {
    assert.match(artifacts.adb.url, /^https:\/\/dl\.google\.com\/.*37\.0\.1/);
    assert.match(artifacts.aapt2.url, /^https:\/\/dl\.google\.com\/.*8\.9\.0-12782657/);
    assert.match(artifacts.adb.sha256, /^[0-9a-f]{64}$/);
    assert.match(artifacts.aapt2.sha256, /^[0-9a-f]{64}$/);
    assert.match(artifacts.aapt2.binarySha256!, /^[0-9a-f]{64}$/);
  }
});

test('download HTTP/network/hash/size failures are bounded, sanitized, and clean only owned staging', async (t) => {
  const cases = [
    {
      response: () => new Response('error', { status: 503 }),
      code: 'ANDROID_TOOLS_DOWNLOAD_FAILED',
    },
    { response: () => new Response('wrong hash'), code: 'ANDROID_TOOLS_HASH_MISMATCH' },
    {
      response: () =>
        new Response('small', { headers: { 'content-length': String(65 * 1024 * 1024) } }),
      code: 'ANDROID_TOOLS_DOWNLOAD_TOO_LARGE',
    },
    {
      response: () => {
        throw new Error('/Users/private-user/secret-network-error');
      },
      code: 'ANDROID_TOOLS_PREPARE_FAILED',
    },
    {
      response: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(33 * 1024 * 1024));
              controller.enqueue(new Uint8Array(33 * 1024 * 1024));
              controller.close();
            },
          }),
        ),
      code: 'ANDROID_TOOLS_DOWNLOAD_TOO_LARGE',
    },
  ];
  for (const { response, code } of cases) {
    const f = await fixture(t);
    f.deps.fetch = async () => response();
    const sentinel = path.join(f.root, 'user-sdk', 'keep');
    await file(sentinel, 'untouched');
    await assert.rejects(
      prepareAndroidTools({ ...f.options, acceptSdkLicense: true }, f.deps),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal('code' in error ? error.code : undefined, code);
        assert.doesNotMatch(error.message, /private-user|secret-network-error/);
        return true;
      },
    );
    assert.deepEqual(f.extractions, []);
    assert.deepEqual(await readdir(f.options.cacheDirectory), []);
    assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
  }
});

test('Abort before prepare or during a stalled download preserves the original cancellation and cleans staging', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const reason = new Error('cancelled by host');
  controller.abort(reason);
  await assert.rejects(
    prepareAndroidTools({ ...f.options, signal: controller.signal }, f.deps),
    (error) => error === reason,
  );
  assert.deepEqual(await readdir(f.root), []);
  const active = new AbortController();
  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.deps.fetch = async () => {
    started();
    return new Response(new ReadableStream());
  };
  const preparing = prepareAndroidTools(
    { ...f.options, acceptSdkLicense: true, signal: active.signal },
    f.deps,
  );
  await start;
  active.abort(reason);
  await assert.rejects(preparing, (error) => error === reason);
  assert.deepEqual(await readdir(f.options.cacheDirectory), []);
});

test('invalid extracted version, native bytes, NOTICE, or executable never publish a success', async (t) => {
  for (const broken of ['version', 'native', 'notice', 'executable']) {
    const f = await fixture(t);
    const original = f.deps.extract;
    f.deps.extract = async (archive, directory, signal) => {
      await original(archive, directory, signal);
      if (archive.endsWith('platform-tools.zip') && broken === 'version')
        await file(
          path.join(directory, 'platform-tools', 'source.properties'),
          'Pkg.Revision=0.0.0\n',
        );
      if (archive.endsWith('aapt2.jar') && broken === 'native')
        await file(path.join(directory, 'aapt2'), 'corrupt native');
      if (archive.endsWith('aapt2.jar') && broken === 'notice')
        await rm(path.join(directory, 'NOTICE'));
    };
    if (broken === 'executable') f.deps.probe = async () => false;
    await assert.rejects(prepareAndroidTools({ ...f.options, acceptSdkLicense: true }, f.deps));
    assert.deepEqual(await readdir(f.options.cacheDirectory), []);
    if (broken === 'native' || broken === 'notice') assert.deepEqual(f.probes, []);
  }
});

test('incomplete cache cannot report ready; failed repair preserves it and successful repair is atomic', async (t) => {
  const f = await fixture(t);
  await prepareAndroidTools({ ...f.options, acceptSdkLicense: true }, f.deps);
  const cacheNotice = path.join(f.sdk, 'build-tools', '8.9.0', 'NOTICE');
  await writeFile(cacheNotice, 'broken notice');
  assert.equal((await resolveAndroidTools(f.options, f.deps)).source, 'missing');
  const original = f.deps.fetch;
  f.deps.fetch = async () => new Response('HTTP error', { status: 500 });
  await assert.rejects(prepareAndroidTools({ ...f.options, acceptSdkLicense: true }, f.deps));
  assert.equal(await readFile(cacheNotice, 'utf8'), 'broken notice');
  assert.deepEqual(await readdir(f.options.cacheDirectory), [pin]);
  f.deps.fetch = original;
  // Reuse ADB from the previous cache without publishing a self-referential symlink.
  f.deps.env.PATH = path.join(f.sdk, 'platform-tools');
  const repaired = await prepareAndroidTools(f.options, f.deps);
  assert.equal(repaired.source, 'managed');
  assert.equal(await readFile(cacheNotice, 'utf8'), notice);
  assert.deepEqual(await resolveAndroidTools(f.options, f.deps), repaired);
});

test('an unmarked reserved directory is not silently overwritten', async (t) => {
  const f = await fixture(t);
  await file(path.join(f.sdk, 'keep-user-file'), 'user asset');
  await assert.rejects(prepareAndroidTools({ ...f.options, acceptSdkLicense: true }, f.deps), {
    code: 'ANDROID_TOOLS_CACHE_INCOMPLETE',
  });
  assert.deepEqual(f.downloads, []);
  assert.equal(await readFile(path.join(f.sdk, 'keep-user-file'), 'utf8'), 'user asset');
});

test('concurrent preparation downloads once; an aborted waiter does not cancel the owner or remove its lock', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = f.deps.fetch;
  f.deps.fetch = async (...args) => {
    if (String(args[0]).endsWith('adb.zip')) {
      entered();
      await gate;
    }
    return original(...args);
  };
  const owner = prepareAndroidTools({ ...f.options, acceptSdkLicense: true }, f.deps);
  await started;
  const controller = new AbortController();
  const waiting = prepareAndroidTools(
    { ...f.options, acceptSdkLicense: true, signal: controller.signal },
    f.deps,
  );
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  const second = prepareAndroidTools({ ...f.options, acceptSdkLicense: true }, f.deps);
  release();
  assert.deepEqual(await owner, await second);
  assert.equal(f.downloads.length, 2);
  assert.deepEqual(await readdir(f.options.cacheDirectory), [pin]);
});

test('progress errors cannot replace a successful prepare result', async (t) => {
  const f = await fixture(t);
  const result = await prepareAndroidTools(
    {
      ...f.options,
      acceptSdkLicense: true,
      onProgress: () => {
        throw new Error('logger failed');
      },
    },
    f.deps,
  );
  assert.equal(result.source, 'managed');
});

test('the same doctor dependencies see a shell-prepared cache with env unset and do not expose paths', async (t) => {
  const f = await fixture(t);
  const commands: Array<{ file: string; args: string[] }> = [];
  const resolveTools: typeof resolveAndroidTools = (options) =>
    resolveAndroidTools({ ...options, ...f.options }, f.deps);
  const execute = async (file: string, args: string[]) => {
    commands.push({ file, args });
    const stdout = file.endsWith('adb')
      ? 'Android Debug Bridge version 1.0.41\nVersion 37.0.1\n'
      : file.endsWith('aapt2')
        ? 'Android Asset Packaging Tool (aapt) 2.19-12782657\n'
        : args.includes('driver')
          ? '{"uiautomator2":{"version":"8.7.0"}}'
          : '3.7.0\n';
    return { stdout, stderr: '' };
  };
  const dependencies = {
    command: (file: string, args: string[], signal?: AbortSignal) =>
      defaultCommand(file, args, signal, resolveTools, execute),
    sdkTools: (signal?: AbortSignal) => defaultSdkTools(signal, resolveTools),
    fetchStatus: async () => true,
    adbDevices: async () => 'fixture-serial device model:Fixture\n',
  };
  const before = await detectAndroidSetup({}, dependencies);
  assert.equal(before.canContinue, false);
  assert.equal(before.technicalDetails?.androidToolsSource, 'missing');
  await prepareAndroidTools({ ...f.options, acceptSdkLicense: true }, f.deps);
  const after = await detectAndroidSetup({}, dependencies);
  assert.equal(after.canContinue, true);
  assert.equal(after.technicalDetails?.androidToolsSource, 'managed');
  assert.equal(
    commands.some(({ file }) => file === path.join(f.sdk, 'platform-tools', 'adb')),
    true,
  );
  assert.equal(
    commands.some(({ args }) => args.includes('devices') || args.includes('start-server')),
    false,
  );
  assert.equal(JSON.stringify(after).includes(f.root), false);
  assert.deepEqual(f.deps.env, { PATH: '' });
  f.deps.env = { ...f.deps.env, ANDROID_HOME: path.join(f.root, 'invalid-explicit-sdk') };
  const invalid = await detectAndroidSetup({}, dependencies);
  assert.equal(invalid.canContinue, true);
  assert.equal(invalid.technicalDetails?.androidToolsReason, 'complete');
  assert.equal(invalid.technicalDetails?.androidToolsSource, 'managed');
  assert.equal(invalid.capabilities.find((item) => item.id === 'adb')?.status, 'ready');
  assert.equal(invalid.capabilities.find((item) => item.id === 'androidSdk')?.status, 'ready');
  assert.deepEqual(
    (invalid.technicalDetails?.androidToolsWarnings as Array<{ code: string }>).map(
      (item) => item.code,
    ),
    ['ANDROID_SDK_INVALID'],
  );
  assert.equal(JSON.stringify(invalid).includes(f.root), false);
});

test('runtime input validation rejects invalid options before preparation', async (t) => {
  const f = await fixture(t);
  for (const options of [null, [], { cacheDirectory: ' ' }, { signal: {} }, { sdkRoot: ' ' }]) {
    await assert.rejects(resolveAndroidTools(options as never, f.deps), {
      code: 'ANDROID_TOOLS_INVALID_INPUT',
    });
  }
  for (const options of [{ acceptSdkLicense: 'true' }, { onProgress: 'log' }]) {
    await assert.rejects(prepareAndroidTools(options as never, f.deps), {
      code: 'ANDROID_TOOLS_INVALID_INPUT',
    });
  }
  assert.deepEqual(f.downloads, []);
});

function adbSocket(response: string | Error, requests: string[]): Socket {
  const socket = new Socket();
  socket.write = ((data: string) => {
    requests.push(data);
    queueMicrotask(() => {
      if (response instanceof Error) socket.emit('error', response);
      else socket.emit('data', Buffer.from(response));
    });
    return true;
  }) as typeof socket.write;
  queueMicrotask(() => socket.emit('connect'));
  return socket;
}

test('existing ADB host compatibility is read-only and rejects a mismatch without any daemon commands', async () => {
  for (const [server, client, matches] of [
    ['0029', '41', true],
    ['0028', '41', false],
  ] as const) {
    const requests: string[] = [];
    const commands: string[] = [];
    const checking = assertAdbServerCompatible('/fixture/adb', undefined, {
      connectAdb: () => adbSocket(`OKAY0004${server}`, requests),
      clientVersion: async (file) => {
        commands.push(file);
        return `Android Debug Bridge version 1.0.${client}\n`;
      },
    });
    if (matches) await checking;
    else await assert.rejects(checking, { code: 'ADB_SERVER_VERSION_MISMATCH' });
    assert.deepEqual(requests, ['000chost:version']);
    assert.deepEqual(commands, ['/fixture/adb']);
  }
  const requests: string[] = [];
  await assertAdbServerCompatible('/fixture/adb', undefined, {
    connectAdb: () =>
      adbSocket(Object.assign(new Error('not running'), { code: 'ECONNREFUSED' }), requests),
    clientVersion: async () => {
      throw new Error('Should not query absent server');
    },
  });
});

test('ADB compatibility rejects malformed host responses and preserves cancellation without invoking CLI', async () => {
  for (const response of ['FAIL0004oops', 'OKAY0004zzzz', 'OKAY000500029']) {
    const requests: string[] = [];
    await assert.rejects(
      assertAdbServerCompatible('/fixture/adb', undefined, {
        connectAdb: () => adbSocket(response, requests),
        clientVersion: async () => {
          throw new Error('A rejected host response must never invoke CLI');
        },
      }),
      { code: 'ADB_SERVER_CHECK_FAILED' },
    );
    assert.deepEqual(requests, ['000chost:version']);
  }
  const controller = new AbortController();
  const reason = new Error('host cancelled ADB check');
  const checking = assertAdbServerCompatible('/fixture/adb', controller.signal, {
    connectAdb: () => new Socket(),
    clientVersion: async () => {
      throw new Error('Cancellation must not invoke CLI');
    },
  });
  controller.abort(reason);
  await assert.rejects(checking, (error) => error === reason);
});

test('Core device and Android app consumers use resolved paths and gate CLI on server compatibility', async (t) => {
  const f = await fixture(t);
  const tools = await prepareAndroidTools({ ...f.options, acceptSdkLicense: true }, f.deps);
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const order: string[] = [];
  const command = async (file: string, args: readonly string[]) => {
    order.push('command');
    calls.push({ file, args });
    return {
      stdout: args.includes('packages')
        ? 'package:org.example.app\n'
        : 'fixture-serial device model:Fixture\n',
      stderr: '',
    };
  };
  const dependencies = {
    resolveAndroidTools: async () => tools,
    assertAdbServerCompatible: async (file: string) => {
      assert.equal(file, tools.adbPath);
      order.push('compatibility');
    },
    command,
  };
  const devices = await discoverDevices('android', undefined, dependencies);
  assert.deepEqual(devices, [{ id: 'fixture-serial', name: 'Fixture', kind: 'device' }]);
  const environment: NativeEnvironment = { platform: 'android', capabilities: {} };
  const apps = await discoverApplications(environment, 'example', {
    ...dependencies,
    resolveDevice: async () => ({ environment, capabilities: { 'appium:udid': 'fixture-serial' } }),
  });
  assert.deepEqual(apps, [{ name: 'org.example.app', id: 'org.example.app' }]);
  assert.equal(
    calls.every(({ file }) => file === tools.adbPath),
    true,
  );
  assert.deepEqual(order, ['compatibility', 'command', 'compatibility', 'command']);
  await assert.rejects(
    discoverDevices('android', undefined, {
      ...dependencies,
      assertAdbServerCompatible: async () => {
        throw new Error('ADB_SERVER_VERSION_MISMATCH');
      },
    }),
    /ADB_SERVER_VERSION_MISMATCH/,
  );
  assert.equal(calls.length, 2);
});
