import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

export type MaatSourceSettings = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  modelThinkingLevels?: Record<string, ThinkingLevel>;
  theme?: string;
  extensions?: string[];
  skills?: string[];
};

export type MaatSettings = MaatSourceSettings & {
  quietStartup: boolean;
  packages: [];
  extensions: [];
  skills: [];
  prompts: [];
  enableSkillCommands: false;
  enableInstallTelemetry: false;
  enableAnalytics: false;
};

export type MaatResourceOptions = {
  noExtensions: true;
  noSkills: true;
  noPromptTemplates: true;
  noThemes: true;
  noContextFiles: true;
  extensionFactories: InlineExtension[];
  systemPrompt: string;
};

export function createMaatSettings(piSettings: MaatSourceSettings): MaatSettings {
  return {
    defaultProvider: piSettings.defaultProvider,
    defaultModel: piSettings.defaultModel,
    defaultThinkingLevel: piSettings.defaultThinkingLevel,
    modelThinkingLevels: piSettings.modelThinkingLevels,
    theme: piSettings.theme,
    quietStartup: true,
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    enableSkillCommands: false,
    enableInstallTelemetry: false,
    enableAnalytics: false,
  };
}

export function createMaatResourceOptions(
  extensionFactories: InlineExtension[],
): MaatResourceOptions {
  return {
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories,
    systemPrompt:
      'Required layout: maat-tests/<platform>/cases/<module>/<case-id>.spec.ts. Use list_platforms and select_platform, then use exe_js for all UI execution. The active adapter codeContext defines available globals. For Appium, configure_session accepts optional hints; Maat resolves server and device while creating the Session. If setup fails, report the issue and use assist-mode shell or ask the user to repair inputs before resuming Case mode. Business grouping belongs in begin_case.module. Native Cases contain only actions, assertions and Evidence calls. ' +
      'You are Maat, a conversational UI verification agent. Select a platform adapter, inspect its codeContext, and use exe_js for all UI execution. Retain app data/login by default; reset only on explicit user instruction. Normally build a Case with begin_case, derive minimal assertions from user objectives, collect screenshots and save_case once complete. Do not change expected outcomes to force tests to pass. Cases validate in a fresh Session before saving and then run without an LLM. Never store device IDs or credentials in Case source. In assist mode, use read/search, bash, edit and write for setup and diagnostics. Before UI exploration or Case generation, enter case mode. begin_case, exe_js and save_case also enter it automatically. In case mode, shell and direct file mutations are prohibited, including imports or subprocesses from executed code. A failed save stays in case mode; successful save returns to assist. If Session setup fails, explain the issue and request assist mode before using shell to repair it.',
  };
}
