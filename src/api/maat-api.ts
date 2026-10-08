import type { BeginCaseInput } from '../core/cases/draft-manager.ts';
import { CaseDraftManager } from '../core/cases/draft-manager.ts';
import { saveCase } from '../core/cases/save-case.ts';
import type { CaseSelection } from '../core/testing/case-selection.ts';
import { runMaatTests, type MaatRunOptions } from '../core/testing/runner.ts';
import type { SessionSetup, SetupInspection } from '../core/platforms/contracts.ts';
import { PlatformRegistry } from '../core/platforms/registry.ts';

/** Stable, host-neutral product API. Agent hosts translate this API into their own tools and UI. */
export class MaatApi {
  readonly workspaceRoot: string;
  readonly registry: PlatformRegistry;
  readonly drafts = new CaseDraftManager();

  constructor(registry: PlatformRegistry, workspaceRoot: string) {
    this.registry = registry;
    this.workspaceRoot = workspaceRoot;
  }

  readonly platforms = {
    current: () => this.registry.current,
    list: () => this.registry.list(),
    select: async (id: string) => {
      await this.registry.select(id);
      return this.registry.current.status();
    },
    status: () => this.registry.current.status(),
    configure: async (configuration: Record<string, unknown>) => {
      const adapter = this.registry.current;
      if (!adapter.configure) throw new Error(`${adapter.label} is not configurable.`);
      return adapter.configure(configuration);
    },
    configureSession: async (setup: SessionSetup) => {
      const adapter = this.registry.current;
      if (!adapter.configureSession) {
        throw new Error(`${adapter.label} does not accept Session hints.`);
      }
      await adapter.configureSession(setup);
    },
    inspectSetup: async (request: SetupInspection) => {
      const adapter = this.registry.current;
      if (!adapter.inspectSetup) {
        throw new Error(`${adapter.label} does not support this setup inspection.`);
      }
      return adapter.inspectSetup(request);
    },
  };

  readonly exploration = {
    executeJavaScript: (code: string, signal?: AbortSignal) =>
      this.registry.current.execute(code, signal),
    context: () => this.registry.current.codeContext,
    execution: () => ({
      adapterId: this.registry.current.id,
      bindings: this.registry.current.codeContext.globals.map((item) => item.name),
      requirement: this.registry.current.runtimeRequirement(),
    }),
  };

  readonly cases = {
    begin: (input: BeginCaseInput) =>
      this.drafts.begin({
        ...input,
        rootDirectory: input.rootDirectory ?? this.registry.current.root,
      }),
    current: () => this.drafts.current,
    status: () => this.drafts.status(),
    clear: () => this.drafts.clear(),
    save: async (signal?: AbortSignal) => {
      const draft = this.drafts.current;
      if (!draft) throw new Error('No active Case. Call begin first.');
      const owner = this.registry.list().find((adapter) => adapter.root === draft.rootDirectory);
      if (!owner) throw new Error('Draft belongs to an unregistered platform root.');
      const result = await saveCase(draft, owner.root, signal);
      // A promoted Case no longer needs its exploratory Sessions. Failed validation keeps them
      // alive so the Agent can inspect and repair the same UI state.
      await this.registry.close();
      return result;
    },
  };

  readonly evidence = {
    list: () => this.drafts.listEvidence(),
    get: (id: string) => this.drafts.getEvidence(id),
  };

  readonly tests = {
    run: (selection: CaseSelection, options?: MaatRunOptions, signal?: AbortSignal) =>
      runMaatTests(this.registry.current.root, selection, signal, undefined, {
        ...options,
        workspaceRoot: options?.workspaceRoot ?? this.workspaceRoot,
      }),
  };

  close(): Promise<void> {
    return this.registry.close();
  }
}
