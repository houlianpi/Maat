import type { CaseSelection } from './testing/case-selection.ts';
import type { CaseDraft } from './cases/types.ts';
import { saveCase } from './cases/save-case.ts';
import { runMaatTests } from './testing/runner.ts';
import type { PlatformAdapter } from './platforms/contracts.ts';
import { PlatformRegistry } from './platforms/registry.ts';

export class MaatHarness {
  readonly registry: PlatformRegistry;
  readonly root: string;

  constructor(registry: PlatformRegistry, root: string) {
    this.registry = registry;
    this.root = root;
  }

  get adapter(): PlatformAdapter {
    return this.registry.current;
  }
  get current() {
    return { name: this.adapter.id, platform: this.adapter.id, root: this.root };
  }

  async select(platform: string) {
    await this.registry.select(platform);
    return this.status();
  }
  status() {
    return this.adapter.status();
  }
  execute(code: string, signal?: AbortSignal) {
    return this.adapter.execute(code, signal);
  }
  save(draft: CaseDraft, signal?: AbortSignal) {
    if (draft.rootDirectory !== this.root)
      throw new Error('Draft belongs to a different Maat test root.');
    return saveCase(draft, this.root, signal);
  }
  async run(
    selection: CaseSelection,
    options?: { browser?: string; headed?: boolean; adapterId?: string },
    signal?: AbortSignal,
  ) {
    return (await runMaatTests(this.root, selection, signal, undefined, options)).exitCode;
  }

  async configureSession(
    input: Parameters<NonNullable<PlatformAdapter['configureSession']>>[0],
  ): Promise<void> {
    if (!this.adapter.configureSession)
      throw new Error(`${this.adapter.label} does not accept Session hints.`);
    await this.adapter.configureSession(input);
  }
  async inspectSetup(
    request: Parameters<NonNullable<PlatformAdapter['inspectSetup']>>[0],
  ): Promise<unknown> {
    if (!this.adapter.inspectSetup)
      throw new Error(`${this.adapter.label} does not support this setup inspection.`);
    return this.adapter.inspectSetup(request);
  }

  async close(): Promise<void> {
    await this.registry.close();
  }
}
