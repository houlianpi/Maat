import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  parseDeviceBinding,
  type DeviceBinding,
  type DeviceBindingParseResult,
} from '../contracts/device.ts';

type ParseFailure = Exclude<DeviceBindingParseResult, { status: 'valid' }>;
type ErrorCategory = ParseFailure['status'] | 'read-failed' | 'write-failed';
type Stage = 'read' | 'parse' | 'mkdir' | 'open' | 'write' | 'close' | 'rename';
type CleanupFailure = 'close-failed' | 'remove-failed';

const summaries: Record<ErrorCategory, string> = {
  'invalid-format': 'Invalid device binding format.',
  'unsupported-version': 'Unsupported device binding version.',
  'read-failed': 'Device binding read failed.',
  'write-failed': 'Device binding write failed.',
};

/** Source-internal diagnostics contain no original input, filesystem error or path. */
export class BindingStoreError extends Error {
  readonly category: ErrorCategory;
  readonly stage: Stage;
  readonly cleanupFailures: readonly CleanupFailure[];

  constructor(category: ErrorCategory, stage: Stage, cleanupFailures: CleanupFailure[] = []) {
    super(summaries[category]);
    this.name = 'BindingStoreError';
    this.category = category;
    this.stage = stage;
    this.cleanupFailures = Object.freeze([...cleanupFailures]);
  }
}

export type BindingStoreReadResult =
  | { status: 'absent' }
  | { status: 'valid'; binding: DeviceBinding };

type BindingFileHandle = {
  writeFile(text: string): Promise<void>;
  close(): Promise<void>;
};

/** Narrow primitive seam for fault tests; the default implementation uses the real filesystem. */
type BindingStoreFs = {
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  mkdir(directory: string, options: { recursive: true; mode: number }): Promise<unknown>;
  open(file: string, flags: 'wx', mode: number): Promise<BindingFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
};

function isMissing(error: unknown): boolean {
  try {
    return (
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    );
  } catch {
    return false;
  }
}

/**
 * Private, versioned binding persistence; no defaults, discovery or constructor I/O.
 * The caller supplies a private directory and owns confirmation, writer coordination
 * and rebind exclusion. A valid write proves neither user consent nor endpoint policy.
 * Binding lifetime is independent of jobs/Sessions; there is no lifecycle delete hook.
 * Atomic replacement is not a promise of power-loss durability or concurrent write order.
 */
export class BindingStore {
  private readonly file: string;
  private readonly fs: BindingStoreFs;

  constructor(file: string, primitives: Partial<BindingStoreFs> = {}) {
    this.file = file;
    this.fs = { readFile, mkdir, open, rename, unlink, ...primitives };
  }

  async read(): Promise<BindingStoreReadResult> {
    let text: string;
    try {
      text = await this.fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (isMissing(error)) return { status: 'absent' };
      throw new BindingStoreError('read-failed', 'read');
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new BindingStoreError('invalid-format', 'parse');
    }
    const parsed = parseDeviceBinding(value);
    if (parsed.status !== 'valid') throw new BindingStoreError(parsed.status, 'parse');
    return parsed;
  }

  async write(value: unknown): Promise<void> {
    // Parse once before any I/O. Only the parser's detached snapshot is serialized.
    const parsed = parseDeviceBinding(value);
    if (parsed.status !== 'valid') throw new BindingStoreError(parsed.status, 'parse');
    const text = `${JSON.stringify(parsed.binding, null, 2)}\n`;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let handle: BindingFileHandle | undefined;
    let ownedTemporary = false;
    let stage: Stage = 'mkdir';
    let failed = false;
    const cleanupFailures: CleanupFailure[] = [];
    try {
      // Mode applies only to newly created directories; existing directories are not chmod'd.
      await this.fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      stage = 'open';
      handle = await this.fs.open(temporary, 'wx', 0o600);
      ownedTemporary = true;
      stage = 'write';
      await handle.writeFile(text);
      stage = 'close';
      await handle.close();
      handle = undefined;
      stage = 'rename';
      await this.fs.rename(temporary, this.file);
      ownedTemporary = false; // Commit point; no fallible post-commit work.
    } catch {
      failed = true;
    } finally {
      // Retry only owned-handle cleanup, never the write or rename.
      if (handle) {
        try {
          await handle.close();
        } catch {
          cleanupFailures.push('close-failed');
        }
      }
      if (ownedTemporary) {
        try {
          await this.fs.unlink(temporary);
        } catch (error) {
          if (!isMissing(error)) cleanupFailures.push('remove-failed');
        }
      }
    }
    if (failed) throw new BindingStoreError('write-failed', stage, cleanupFailures);
  }
}
