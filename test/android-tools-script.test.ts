import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import test from 'node:test';

const exec = promisify(execFile);
const script = fileURLToPath(
  new URL('../packages/pi/skills/maat-setup/scripts/android-tools.mjs', import.meta.url),
);

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-android-script-'));
  const sdk = path.join(root, 'sdk');
  const bin = path.join(root, 'bin');
  await mkdir(path.join(sdk, 'platform-tools'), { recursive: true });
  await mkdir(path.join(sdk, 'build-tools', '35.0.0'), { recursive: true });
  await mkdir(bin);
  for (const [file, version] of [
    [path.join(sdk, 'platform-tools', 'adb'), 'Android Debug Bridge version 1.0.41'],
    [path.join(sdk, 'build-tools', '35.0.0', 'aapt2'), 'Android Asset Packaging Tool (aapt) 2.19'],
  ]) {
    await writeFile(file, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o700 });
  }
  const appium = path.join(bin, 'appium');
  await writeFile(
    appium,
    `#!${process.execPath}\nconsole.log(JSON.stringify({root:process.env.ANDROID_HOME,sdk:process.env.ANDROID_SDK_ROOT,path:process.env.PATH,args:process.argv.slice(2)}));\n`,
    { mode: 0o700 },
  );
  await chmod(appium, 0o700);
  const environment = {
    ...process.env,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    PATH: [bin, path.dirname(process.execPath)].join(path.delimiter),
  };
  return { root, sdk, bin, environment };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test(
  'bundled Android status and foreground launcher share a resolved tool environment',
  { skip: process.platform === 'win32' },
  async () => {
    const files = await fixture();
    const originalHome = process.env.ANDROID_HOME;
    try {
      const status = await exec(process.execPath, [script, 'status'], {
        env: files.environment,
        timeout: 10_000,
      });
      const summary = JSON.parse(status.stdout) as { toolchainReady: boolean };
      assert.equal(summary.toolchainReady, true);
      assert.doesNotMatch(status.stdout, new RegExp(files.root));
      const prepared = await exec(process.execPath, [script, 'prepare'], {
        env: files.environment,
        timeout: 10_000,
      });
      const reused = JSON.parse(prepared.stdout) as { prepared: boolean; toolchainReady: boolean };
      assert.equal(reused.prepared, true);
      assert.equal(reused.toolchainReady, true);
      assert.doesNotMatch(prepared.stdout, new RegExp(files.root));
      const adb = await exec(process.execPath, [script, 'adb'], {
        env: files.environment,
        timeout: 15_000,
      });
      assert.deepEqual(JSON.parse(adb.stdout), {
        adbConnectionServiceStarted: true,
        phoneReadinessChecked: false,
      });

      const port = await freePort();
      const launched = await exec(process.execPath, [script, 'appium', '--port', String(port)], {
        env: files.environment,
        timeout: 10_000,
      });
      const child = JSON.parse(launched.stdout) as {
        root: string;
        sdk: string;
        path: string;
        args: string[];
      };
      assert.equal(child.root, files.sdk);
      assert.equal(child.sdk, files.sdk);
      assert.equal(child.path.split(path.delimiter)[0], path.join(files.sdk, 'platform-tools'));
      assert.deepEqual(child.args, [
        '--address',
        '127.0.0.1',
        '--port',
        String(port),
        '--log-level',
        'warn',
      ]);
      assert.equal(process.env.ANDROID_HOME, originalHome);
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  },
);

test(
  'the foreground launcher does not replace an unrelated occupied port',
  { skip: process.platform === 'win32' },
  async () => {
    const files = await fixture();
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.end(
          'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}',
        );
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      await assert.rejects(
        exec(process.execPath, [script, 'appium', '--port', String(address.port)], {
          env: files.environment,
          timeout: 10_000,
        }),
        /APPIUM_PORT_IN_USE/,
      );
      assert.equal(server.listening, true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(files.root, { recursive: true, force: true });
    }
  },
);

test('bundled tool preparation rejects unknown actions and unrelated license flags', async () => {
  await assert.rejects(exec(process.execPath, [script, 'unknown'], { timeout: 10_000 }), /Usage:/);
  await assert.rejects(
    exec(process.execPath, [script, 'status', '--accept-sdk-license'], { timeout: 10_000 }),
    /applies only/,
  );
});

test(
  'the launcher preserves an existing ready service without claiming phone readiness',
  { skip: process.platform === 'win32' },
  async () => {
    const files = await fixture();
    const body = JSON.stringify({ value: { ready: true } });
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const result = await exec(
        process.execPath,
        [script, 'appium', '--port', String(address.port)],
        {
          env: files.environment,
          timeout: 10_000,
        },
      );
      assert.deepEqual(JSON.parse(result.stdout), {
        serviceAlreadyRunning: true,
        existingServiceReconfigured: false,
        phoneReadinessChecked: false,
      });
      assert.equal(server.listening, true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(files.root, { recursive: true, force: true });
    }
  },
);
