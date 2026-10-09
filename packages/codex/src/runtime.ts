import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { createMaat, type MaatApi, type MaatRunOptions } from '@houlianpi/maat-core';

export type CodexMaatRuntimeOptions = { workspaceRoot?: string; testsRoot?: string };

export class CodexMaatRuntime {
  workspaceRoot: string;
  maat: MaatApi;
  private readonly testsRoot?: string;

  constructor(options: CodexMaatRuntimeOptions = {}) {
    this.workspaceRoot = path.resolve(
      options.workspaceRoot ?? process.env.MAAT_WORKSPACE_ROOT ?? process.cwd(),
    );
    this.testsRoot = options.testsRoot;
    this.maat = createMaat({
      workspaceRoot: this.workspaceRoot,
      ...(this.testsRoot ? { testsRoot: this.testsRoot } : {}),
    });
  }

  async relocate(workspaceRoot: string): Promise<void> {
    const resolved = path.resolve(workspaceRoot);
    if (resolved === this.workspaceRoot) return;
    await this.maat.close();
    this.workspaceRoot = resolved;
    this.maat = createMaat({
      workspaceRoot: resolved,
      ...(this.testsRoot ? { testsRoot: this.testsRoot } : {}),
    });
  }

  async latestRun(): Promise<{ runDirectory: string; result?: unknown } | undefined> {
    const root = path.join(this.workspaceRoot, 'artifacts', 'maat', 'runs');
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const runDirectory = path.join(root, entry.name);
          const resultPath = path.join(runDirectory, 'result.json');
          const result = await readFile(resultPath, 'utf8').catch(() => undefined);
          const modifiedAt = result ? (await stat(resultPath)).mtimeMs : 0;
          return { runDirectory, result, modifiedAt };
        }),
    );
    const latest = candidates
      .filter((candidate) => candidate.result !== undefined)
      .sort((left, right) => right.modifiedAt - left.modifiedAt)[0];
    if (!latest) return undefined;
    return {
      runDirectory: latest.runDirectory,
      result: JSON.parse(latest.result!),
    };
  }

  async runTests(
    selection: Parameters<MaatApi['tests']['run']>[0],
    options?: MaatRunOptions,
    signal?: AbortSignal,
  ) {
    return this.maat.tests.run(selection, options, signal);
  }

  close(): Promise<void> {
    return this.maat.close();
  }
}
