import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SetupPreference, SetupProcessFingerprint } from './types.ts';

export function sameFingerprint(
  left: SetupProcessFingerprint,
  right: SetupProcessFingerprint,
): boolean {
  const hasIdentity = Boolean(
    (left.appiumPid && left.appiumStartedAt) || (left.wdaPid && left.wdaStartedAt),
  );
  return (
    hasIdentity &&
    left.appiumPid === right.appiumPid &&
    left.appiumStartedAt === right.appiumStartedAt &&
    left.wdaPid === right.wdaPid &&
    left.wdaStartedAt === right.wdaStartedAt
  );
}

export class SetupPreferenceStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async readAny(): Promise<SetupPreference | undefined> {
    return readFile(this.file, 'utf8')
      .then((text) => {
        try {
          const value = JSON.parse(text) as Partial<SetupPreference>;
          if (
            !Array.isArray(value.skippedCapabilities) ||
            !value.fingerprint ||
            typeof value.fingerprint !== 'object' ||
            typeof value.updatedAt !== 'string'
          )
            return undefined;
          return value as SetupPreference;
        } catch {
          return undefined;
        }
      })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
  }

  async read(fingerprint: SetupProcessFingerprint): Promise<SetupPreference | undefined> {
    const value = await this.readAny();
    return value && sameFingerprint(value.fingerprint, fingerprint) ? value : undefined;
  }

  async write(value: SetupPreference): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
