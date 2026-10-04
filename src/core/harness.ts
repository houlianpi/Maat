import type { CaseSelection } from './testing/case-selection.ts';
import type { CaseDraft } from './cases/types.ts';
import { saveCase } from './cases/save-case.ts';
import { runMaatTests } from './testing/runner.ts';
import type { PlatformAdapter } from './platforms/contracts.ts';
import { PlatformRegistry } from './platforms/registry.ts';

export class MaatHarness {
  readonly registry: PlatformRegistry;
  readonly workspaceRoot: string;

  constructor(registry: PlatformRegistry, root: string) {
    this.registry = registry;
    this.workspaceRoot = root;
  }

  get adapter(): PlatformAdapter {
    return this.registry.current;
  }
  get current() {
    return { name: this.adapter.id, platform: this.adapter.id, root: this.adapter.root };
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
    const owner = this.registry.list().find((adapter) => adapter.root === draft.rootDirectory);
    if (!owner) throw new Error('Draft belongs to an unregistered platform root.');
    return saveCase(draft, owner.root, signal);
  }
  async run(
    selection: CaseSelection,
    options?: { browser?: string; headed?: boolean },
    signal?: AbortSignal,
  ) {
    return (
      await runMaatTests(this.adapter.root, selection, signal, undefined, {
        ...options,
        workspaceRoot: this.workspaceRoot,
      })
    ).exitCode;
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
