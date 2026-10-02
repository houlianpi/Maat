import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolveCaseSpec, type CaseSelection } from '../cases/case-runner.ts';

export async function runNativeProject(root: string, selection: CaseSelection, spec?: string, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  const args = {
    ...(spec ? { spec: [spec] } : selection.mode === 'case' ? { spec: [await resolveCaseSpec(root, selection.value)] } : {}),
    ...(selection.mode === 'tag' || selection.mode === 'suite' ? { mochaOpts: { grep: (selection.mode === 'suite' ? '@suite:' : '@') + selection.value } } : {}),
  };
  const directory = path.resolve(root, '../../artifacts/native', path.basename(root), 'runs', randomUUID());
  await mkdir(directory, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./run-wdio.ts', import.meta.url)), path.join(root, 'wdio.conf.ts'), JSON.stringify(args)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MAAT_NATIVE_RUN_DIR: directory } });
    let output = '';
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-2_000_000); if (!spec) process.stdout.write(chunk); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const abort = () => child.kill('SIGINT');
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => { signal?.removeEventListener('abort', abort); reject(error); });
    child.once('exit', (code) => {
      signal?.removeEventListener('abort', abort);
      void writeFile(path.join(directory, 'wdio.log'), output).then(() => {
        if (signal?.aborted) reject(new Error('WDIO validation aborted.'));
        else if (spec && code !== 0) reject(new Error(`WDIO validation failed. Log: ${directory}/wdio.log\n${output.slice(-4000)}`));
        else resolve(code ?? 1);
      }, reject);
    });
  });
}
