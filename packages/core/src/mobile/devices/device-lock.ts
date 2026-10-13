import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { canonicalDeviceKey, type DeviceIdentity } from '../contracts/device.ts';
import { MobileBusyError } from './coordinator.ts';

type NativeFileLocks = {
  tryLock(fd: number): boolean;
  unlock(fd: number): void;
};

export type DeviceLockLease = {
  release(): void;
};

export type DeviceLockOptions = {
  /** Internal test seam. Production callers always use the same-user default. */
  stateDirectory?: string;
};

export class DeviceLockUnavailableError extends Error {
  readonly code = 'device-lock-unavailable';

  constructor() {
    super('The local device lock is unavailable; no phone operation was started.');
    this.name = 'DeviceLockUnavailableError';
  }
}

export class DeviceLockHandleCleanupError extends Error {
  readonly code = 'device-lock-handle-cleanup';

  constructor() {
    super('Device lock ownership was released, but the local lock handle could not be closed.');
    this.name = 'DeviceLockHandleCleanupError';
  }
}

export class DeviceLockReleaseUncertainError extends Error {
  readonly code = 'lock-release-uncertain';

  constructor() {
    super(
      'Device lock release could not be confirmed; this process will not start another phone operation.',
    );
    this.name = 'DeviceLockReleaseUncertainError';
  }
}

const require = createRequire(import.meta.url);
const keyContext = Buffer.from('maat/device-lock-key/v1\0', 'utf8');
const secretName = 'machine-secret';
const noFollow = constants.O_NOFOLLOW ?? 0;
let testStateDirectory: string | undefined;
let testUnlockFailure: unknown;
let testCloseFailure: unknown;
let testUnlockCalls = 0;
let testCloseCalls = 0;
let processLockReleaseUncertain = false;

/** Internal admission guard; the process-lifetime barrier deliberately has no clear operation. */
export function assertDeviceLockReleaseCertain(): void {
  if (processLockReleaseUncertain) throw new DeviceLockReleaseUncertainError();
}

/** Internal source-test harness only; not exported from the package entry point. */
export function setDeviceLockStateDirectoryForTests(directory: string | undefined): void {
  testStateDirectory = directory;
}

/** Internal source-test fault injection; production adapter code cannot configure it. */
export function setDeviceLockUnlockFailureForTests(failure: unknown): void {
  testUnlockFailure = failure;
}

/** Internal source-test fault injection; production adapter code cannot configure it. */
export function setDeviceLockCloseFailureForTests(failure: unknown): void {
  testCloseFailure = failure;
}

/** Internal source-test observation; not exported from the package entry point. */
export function deviceLockReleaseCallCountsForTests(): { unlock: number; close: number } {
  return { unlock: testUnlockCalls, close: testCloseCalls };
}

/** Resets only fault injection/counters; the process admission barrier has deliberately no reset. */
export function resetDeviceLockFaultTestState(): void {
  testUnlockFailure = undefined;
  testCloseFailure = undefined;
  testUnlockCalls = 0;
  testCloseCalls = 0;
}

function nativeFileLocks(): NativeFileLocks {
  const candidate: unknown = require('fs-native-extensions');
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !('tryLock' in candidate) ||
    typeof candidate.tryLock !== 'function' ||
    !('unlock' in candidate) ||
    typeof candidate.unlock !== 'function'
  )
    throw new DeviceLockUnavailableError();
  const tryLock = candidate.tryLock as (fd: number) => unknown;
  const unlock = candidate.unlock as (fd: number) => unknown;
  return {
    tryLock: (fd) => {
      const result = tryLock(fd);
      if (typeof result !== 'boolean') fail();
      return result;
    },
    unlock: (fd) => {
      testUnlockCalls++;
      if (testUnlockFailure !== undefined) {
        const failure = testUnlockFailure;
        testUnlockFailure = undefined;
        throw failure;
      }
      unlock(fd);
    },
  };
}

function closeReleasedLockHandle(fd: number): void {
  testCloseCalls++;
  if (testCloseFailure !== undefined) {
    const failure = testCloseFailure;
    testCloseFailure = undefined;
    throw failure;
  }
  closeSync(fd);
}

function isCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function fail(): never {
  throw new DeviceLockUnavailableError();
}

function ensureStateDirectory(directory: string): void {
  try {
    try {
      lstatSync(directory);
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const status = lstatSync(directory);
    if (!status.isDirectory() || status.isSymbolicLink()) fail();
    if (process.platform !== 'win32' && (status.mode & 0o777) !== 0o700) fail();
  } catch (error) {
    if (error instanceof DeviceLockUnavailableError) throw error;
    fail();
  }
}

function readSecret(filename: string): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(filename, constants.O_RDONLY | noFollow);
    const status = fstatSync(fd);
    if (
      !status.isFile() ||
      status.size !== 32 ||
      (process.platform !== 'win32' && (status.mode & 0o777) !== 0o600)
    )
      fail();
    const secret = Buffer.alloc(32);
    let offset = 0;
    while (offset < secret.length) {
      const count = readSync(fd, secret, offset, secret.length - offset, null);
      if (count === 0) fail();
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) fail();
    return secret;
  } catch (error) {
    if (isCode(error, 'ENOENT')) throw error;
    if (error instanceof DeviceLockUnavailableError) throw error;
    fail();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        fail();
      }
    }
  }
  return fail();
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (count <= 0) fail();
    offset += count;
  }
}

function machineSecret(directory: string): Buffer {
  const filename = path.join(directory, secretName);
  try {
    return readSecret(filename);
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error;
    return publishSecret(directory, filename);
  }
}

function publishSecret(directory: string, filename: string): Buffer {
  const secret = randomBytes(32);
  const temporary = path.join(directory, `.machine-secret-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let temporaryExists = false;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    temporaryExists = true;
    writeAll(fd, secret);
    if (fstatSync(fd).size !== secret.length) fail();
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temporary, filename);
    } catch (error) {
      if (!isCode(error, 'EEXIST')) fail();
    }
    unlinkSync(temporary);
    temporaryExists = false;
    const published = readSecret(filename);
    return published;
  } catch (error) {
    if (error instanceof DeviceLockUnavailableError) throw error;
    fail();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The operation is already fail-closed.
      }
    }
    if (temporaryExists) {
      try {
        unlinkSync(temporary);
      } catch {
        // A failed publication remains fail-closed; never replace the winner.
      }
    }
  }
  return fail();
}

class HeldDeviceLock implements DeviceLockLease {
  #state: 'held' | 'released' | 'release-uncertain' = 'held';
  readonly #fd: number;

  constructor(fd: number) {
    this.#fd = fd;
  }

  release(): void {
    if (this.#state === 'released') return;
    if (this.#state === 'release-uncertain') throw new DeviceLockReleaseUncertainError();
    try {
      nativeFileLocks().unlock(this.#fd);
    } catch {
      this.#state = 'release-uncertain';
      processLockReleaseUncertain = true;
      throw new DeviceLockReleaseUncertainError();
    }
    this.#state = 'released';
    try {
      closeReleasedLockHandle(this.#fd);
    } catch {
      throw new DeviceLockHandleCleanupError();
    }
  }
}

export function acquireDeviceLock(
  identity: DeviceIdentity,
  options: DeviceLockOptions = {},
): DeviceLockLease {
  assertDeviceLockReleaseCertain();
  const directory =
    options.stateDirectory ??
    testStateDirectory ??
    path.join(homedir(), '.maat', 'device-lock', 'v1');
  ensureStateDirectory(directory);
  const secret = machineSecret(directory);
  const digest = createHmac('sha256', secret)
    .update(keyContext)
    .update(Buffer.from(canonicalDeviceKey(identity), 'utf8'))
    .digest('hex');
  const filename = path.join(directory, `${digest}.lock`);
  let fd: number | undefined;
  try {
    fd = openSync(filename, constants.O_RDWR | constants.O_CREAT | noFollow, 0o600);
    const status = fstatSync(fd);
    if (
      !status.isFile() ||
      status.size !== 0 ||
      (process.platform !== 'win32' && (status.mode & 0o777) !== 0o600)
    )
      fail();
    const locks = nativeFileLocks();
    if (!locks.tryLock(fd)) {
      closeSync(fd);
      fd = undefined;
      throw new MobileBusyError();
    }
    const lease = new HeldDeviceLock(fd);
    fd = undefined;
    return lease;
  } catch (error) {
    if (error instanceof MobileBusyError || error instanceof DeviceLockUnavailableError)
      throw error;
    fail();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The acquisition is already fail-closed.
      }
    }
  }
  return fail();
}
