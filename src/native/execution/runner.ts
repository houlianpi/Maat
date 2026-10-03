import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { findSpecs, resolveCaseSpec, type CaseSelection } from '../../cases/case-runner.ts';

async function runSpec(root: string, selection: CaseSelection, selectedSpec: string, signal: AbortSignal | undefined, validate: boolean): Promise<number> {
  const args = { spec: [selectedSpec], ...(selection.mode === 'tag' || selection.mode === 'suite' ? { mochaOpts: { grep: (selection.mode === 'suite' ? '@suite:' : '@') + selection.value } } : {}) };
  const directory = path.resolve(root, '../../artifacts/native', path.basename(root), 'runs', randomUUID());
  await mkdir(directory, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./run-wdio.ts', import.meta.url)), path.join(root, 'wdio.conf.ts'), JSON.stringify(args)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MAAT_NATIVE_RUN_DIR: directory } });
    let output = '';
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-2_000_000); if (!validate) process.stdout.write(chunk); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const abort = () => child.kill('SIGINT');
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => { signal?.removeEventListener('abort', abort); reject(error); });
    child.once('exit', code => {
      signal?.removeEventListener('abort', abort);
      void writeFile(path.join(directory, 'wdio.log'), output).then(() => {
        if (signal?.aborted) reject(new Error('WDIO validation aborted.'));
        else if (validate && code !== 0) reject(new Error(`WDIO validation failed. Log: ${directory}/wdio.log\n${output.slice(-4000)}`));
        else resolve(code ?? 1);
      }, reject);
    });
  });
}

export async function runNativeProject(root: string, selection: CaseSelection, spec?: string, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  if (spec) return runSpec(root, selection, path.resolve(spec), signal, true);
  const specs = selection.mode === 'case' ? [await resolveCaseSpec(root, selection.value)] : await findSpecs(path.join(root, 'cases'));
  let status = 0;
  for (const selected of specs) if (await runSpec(root, selection, path.resolve(selected), signal, false) !== 0) status = 1;
  return status;
}
