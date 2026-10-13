import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import test from 'node:test';

import {
  acquireDeviceLock,
  DeviceLockUnavailableError,
} from '../packages/core/src/mobile/devices/device-lock.ts';
import { identityFromLocalFact } from '../packages/core/src/mobile/contracts/device.ts';
import { MobileBusyError } from '../packages/core/src/mobile/devices/coordinator.ts';

const childFixture = path.join(import.meta.dirname, 'fixtures', 'device-lock-child.ts');
const secretName = 'machine-secret';
const fictionalSerial = 'FICTIONAL-SERIAL-9d73';

function identity(routingId = fictionalSerial) {
  return identityFromLocalFact({
    source: 'local-adb',
    platform: 'android',
    device: { id: routingId, name: 'Fictional test phone', kind: 'device' },
  });
}

const readers = new WeakMap<ChildProcessWithoutNullStreams, Interface>();

async function line(child: ChildProcessWithoutNullStreams, timeoutMs = 3_000) {
  let reader = readers.get(child);
  if (!reader) {
    reader = createInterface({ input: child.stdout });
    readers.set(child, reader);
  }
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for device-lock child response.')),
      timeoutMs,
    );
    reader!.once('line', (text) => {
      clearTimeout(timeout);
      resolve(JSON.parse(text) as Record<string, unknown>);
    });
    reader!.once('close', () => {
      clearTimeout(timeout);
      reject(new Error('Device-lock child exited without a response.'));
    });
  });
}

function child(stateDirectory: string, routingId: string, behavior = 'hold', cwd?: string) {
  return spawn(
    process.execPath,
    ['--experimental-strip-types', childFixture, stateDirectory, routingId, behavior],
    { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

async function stop(childProcess: ChildProcessWithoutNullStreams) {
  if (childProcess.exitCode !== null) return;
  const exit = once(childProcess, 'exit');
  let signalled = false;
  if (childProcess.exitCode === null && childProcess.pid !== undefined) {
    try {
      process.kill(childProcess.pid, 'SIGKILL');
      signalled = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  if (signalled && childProcess.exitCode === null) await exit;
}

async function exited(childProcess: ChildProcessWithoutNullStreams) {
  if (childProcess.exitCode === null) await once(childProcess, 'exit');
}

test('cross-process lock is nonblocking across workspaces and independent per device', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-device-lock-'));
  const otherCwd = await mkdtemp(path.join(tmpdir(), 'maat-device-lock-cwd-'));
  const owner = child(root, fictionalSerial, 'hold', root);
  try {
    assert.deepEqual(await line(owner), { status: 'acquired' });
    const started = performance.now();
    const contender = child(root, fictionalSerial, 'release', otherCwd);
    const conflict = await line(contender);
    assert.ok(performance.now() - started < 2_000);
    assert.deepEqual(conflict, {
      status: 'error',
      name: 'MobileBusyError',
      code: 'mobile-busy',
      message: 'Another mobile operation is already in progress.',
    });
    await exited(contender);

    const independent = child(root, 'FICTIONAL-SERIAL-other', 'release', otherCwd);
    assert.deepEqual(await line(independent), { status: 'acquired' });
    await exited(independent);

    owner.stdin.write('release\n');
    await exited(owner);
    const afterRelease = child(root, fictionalSerial, 'release');
    assert.deepEqual(await line(afterRelease), { status: 'acquired' });
    await exited(afterRelease);
  } finally {
    await stop(owner);
    await rm(root, { recursive: true, force: true });
    await rm(otherCwd, { recursive: true, force: true });
  }
});

test('process death releases the OS lock while a living uncertain owner retains it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-device-lock-death-'));
  const owner = child(root, fictionalSerial, 'uncertain');
  try {
    assert.deepEqual(await line(owner), { status: 'acquired' });
    owner.stdin.write('uncertain\n');
    const contender = child(root, fictionalSerial, 'release');
    assert.equal((await line(contender)).code, 'mobile-busy');
    await exited(contender);

    await stop(owner);
    const replacement = child(root, fictionalSerial, 'release');
    assert.deepEqual(await line(replacement), { status: 'acquired' });
    await exited(replacement);
  } finally {
    await stop(owner);
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent first use publishes one secret and admits one same-device owner', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-device-lock-race-'));
  const children = Array.from({ length: 8 }, () => child(root, fictionalSerial, 'hold'));
  try {
    const results = await Promise.all(children.map((process) => line(process)));
    assert.equal(results.filter((result) => result.status === 'acquired').length, 1);
    assert.equal(results.filter((result) => result.code === 'mobile-busy').length, 7);
    assert.equal((await readFile(path.join(root, secretName))).byteLength, 32);
  } finally {
    await Promise.all(children.map(stop));
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupt secret files and paths fail closed without replacement', async () => {
  for (const corrupt of [Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33)]) {
    const root = await mkdtemp(path.join(tmpdir(), 'maat-device-lock-corrupt-'));
    await writeFile(path.join(root, secretName), corrupt);
    assert.throws(
      () => acquireDeviceLock(identity(), { stateDirectory: root }),
      DeviceLockUnavailableError,
    );
    assert.deepEqual(await readFile(path.join(root, secretName)), corrupt);
    await rm(root, { recursive: true, force: true });
  }

  const root = await mkdtemp(path.join(tmpdir(), 'maat-device-lock-path-'));
  await rm(root, { recursive: true, force: true });
  await writeFile(root, 'not a directory');
  assert.throws(
    () => acquireDeviceLock(identity(), { stateDirectory: root }),
    DeviceLockUnavailableError,
  );
  assert.equal(await readFile(root, 'utf8'), 'not a directory');
  await rm(root, { force: true });
});

test('lock artifacts and public errors do not disclose device identity or derived keys', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-device-lock-private-'));
  const lease = acquireDeviceLock(identity(), { stateDirectory: root });
  try {
    assert.throws(
      () => acquireDeviceLock(identity(), { stateDirectory: root }),
      (error) => {
        assert.ok(error instanceof MobileBusyError);
        const serialized = JSON.stringify(error);
        assert.doesNotMatch(serialized, new RegExp(fictionalSerial));
        assert.doesNotMatch(serialized, /device-lock|[a-f0-9]{64}|PID|pid/i);
        return true;
      },
    );
  } finally {
    lease.release();
  }

  const entries = await readdir(root, { recursive: true });
  const content: string[] = [];
  for (const entry of entries) {
    const item = path.join(root, entry);
    if ((await stat(item)).isFile()) content.push((await readFile(item)).toString('hex'));
  }
  const serialized = JSON.stringify({ entries, content });
  assert.doesNotMatch(serialized, new RegExp(fictionalSerial));
  assert.doesNotMatch(serialized, /5b312c22616e64726f696422/);
  const lockFiles = entries.filter((entry) => entry.endsWith('.lock'));
  assert.equal(lockFiles.length, 1);
  assert.equal((await readFile(path.join(root, lockFiles[0]!))).byteLength, 0);
  assert.ok(entries.includes(lockFiles[0]!));
  await rm(root, { recursive: true, force: true });
});
