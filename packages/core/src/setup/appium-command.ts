import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export type ResolvedAppiumCommand = { file: string; args: string[] };

function invalid() {
  return Object.assign(
    new Error('APPIUM_CLI_INVALID: installed Appium npm entrypoint could not be resolved.'),
    { code: 'APPIUM_CLI_INVALID' },
  );
}

/**
 * Resolve the installed Appium CLI only. Never parses or executes npm shim text.
 * Windows .cmd files cannot be passed to execFile/spawn without a shell; use the
 * manifest's JS bin via the current Node executable instead.
 */
export async function resolveAppiumCommand(
  options: { signal?: AbortSignal } = {},
  // Source-internal injection for filesystem tests, not host routing configuration.
  dependencies = {
    platform: process.platform,
    env: { ...process.env },
    nodePath: process.execPath,
  },
): Promise<ResolvedAppiumCommand> {
  options.signal?.throwIfAborted();
  if (dependencies.platform !== 'win32') return { file: 'appium', args: [] };
  for (const folder of (dependencies.env.PATH ?? dependencies.env.Path ?? '').split(';')) {
    if (!folder) continue;
    let shimPresent = false;
    try {
      shimPresent = (await stat(path.join(folder, 'appium.cmd'))).isFile();
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw invalid();
    }
    options.signal?.throwIfAborted();
    if (!shimPresent) continue;
    const root =
      path.basename(folder).toLowerCase() === '.bin'
        ? path.resolve(folder, '..', 'appium')
        : path.join(folder, 'node_modules', 'appium');
    try {
      const metadata: unknown = JSON.parse(
        await readFile(path.join(root, 'package.json'), {
          encoding: 'utf8',
          signal: options.signal,
        }),
      );
      if (
        !metadata ||
        typeof metadata !== 'object' ||
        !('name' in metadata) ||
        metadata.name !== 'appium' ||
        !('bin' in metadata)
      )
        throw invalid();
      const bin: unknown =
        typeof metadata.bin === 'string'
          ? metadata.bin
          : metadata.bin && typeof metadata.bin === 'object' && 'appium' in metadata.bin
            ? metadata.bin.appium
            : undefined;
      if (typeof bin !== 'string' || !/\.(?:c|m)?js$/.test(bin) || path.isAbsolute(bin))
        throw invalid();
      const directory = await realpath(root);
      const entry = await realpath(path.resolve(directory, bin));
      const relative = path.relative(directory, entry);
      if (
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        !(await stat(entry)).isFile()
      )
        throw invalid();
      options.signal?.throwIfAborted();
      return { file: dependencies.nodePath, args: [entry] };
    } catch {
      options.signal?.throwIfAborted();
      throw invalid();
    }
  }
  throw Object.assign(new Error('APPIUM_CLI_MISSING: Appium CLI is not available on PATH.'), {
    code: 'APPIUM_CLI_MISSING',
  });
}
