import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { CaseSelection } from '../../cases/case-runner.ts';
import { findSpecs, resolveCaseSpec } from '../../cases/case-runner.ts';

export type MaatRunResult = { exitCode: number; runDirectory: string };
export type MaatRunOptions = { browser?: string; headed?: boolean; adapterId?: string };

export async function runMaatTests(
  root: string,
  selection: CaseSelection,
  signal?: AbortSignal,
  spec?: string,
  options: MaatRunOptions = {},
): Promise<MaatRunResult> {
  let specs = spec
    ? [path.resolve(spec)]
    : selection.mode === 'case'
      ? [await resolveCaseSpec(root, selection.value)]
      : await findSpecs(path.join(root, 'cases'));
  if (!spec && options.adapterId)
    specs = (
      await Promise.all(
        specs.map(async (filename) => ({ filename, source: await readFile(filename, 'utf8') })),
      )
    )
      .filter((item) => {
        const values =
          /@maat-adapters\s+([^;\n*]+)/.exec(item.source)?.[1]?.trim().split(/\s+/) ?? [];
        return values.includes(options.adapterId!);
      })
      .map((item) => item.filename);
  if (!spec && specs.length === 0) throw new Error(`No Cases use Adapter: ${options.adapterId}`);
  const runDirectory = path.resolve('artifacts/maat/runs', randomUUID());
  await mkdir(runDirectory, { recursive: true });
  const grep =
    selection.mode === 'suite'
      ? `@suite:${selection.value}`
      : selection.mode === 'tag'
        ? `@${selection.value}`
        : undefined;
  const input = { specs, grep, runDirectory };
  const args = [
    '--experimental-strip-types',
    fileURLToPath(new URL('./run-mocha.ts', import.meta.url)),
    JSON.stringify(input),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MAAT_TESTS_ROOT: root,
        MAAT_RUN_DIRECTORY: runDirectory,
        ...(options.browser ? { MAAT_WEB_BROWSER: options.browser } : {}),
        ...(options.headed ? { MAAT_WEB_HEADED: '1' } : {}),
      },
    });
    let output = '';
    const capture = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-2_000_000);
      if (!spec) process.stdout.write(chunk);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const abort = () => child.kill('SIGINT');
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('exit', (code) => {
      signal?.removeEventListener('abort', abort);
      void writeFile(path.join(runDirectory, 'mocha.log'), output).then(() => {
        if (signal?.aborted) reject(new Error('Maat test run aborted.'));
        else if (spec && code !== 0)
          reject(
            new Error(
              `Clean validation failed. Log: ${runDirectory}/mocha.log\n${output.slice(-4000)}`,
            ),
          );
        else resolve({ exitCode: code ?? 1, runDirectory });
      }, reject);
    });
  });
}
