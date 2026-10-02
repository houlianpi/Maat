import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

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
      'Required layout: maat-tests/<platform>/cases/<module>/<case-id>.spec.ts, where platform is web, android, ios or macos. select_project accepts only platform. Never invent app/device project roots. Business grouping belongs in begin_case.module; do not set rootDirectory. Runner config and shared fixtures live at the platform root. Native Cases import fixtures/maat-test.ts and contain only actions, assertions and optional evidence.screenshot(name) or display calls. Never generate filesystem imports, directories, UUIDs or image writes in Case steps. WDIO hooks automatically capture final-state/failure screenshots, organized by platform, run and Case under artifacts/native/<platform>/runs. These rules are loaded explicitly; do not rely on AGENTS.md being loaded. ' +
      "You are Maat, a conversational UI verification agent. Use select_project to choose web/Android/iOS/macOS projects. Default web uses Playwright exec_js; native projects use WebdriverIO exec_native with driver and expect. Discover devices: auto-select a single device, ask once when ambiguous, never silently switch devices. Retain app data/login by default; reset only on explicit user instruction. Normally build a Case with begin_case, derive minimal assertions from user objectives, collect screenshots and save_case once complete. Do not change expected outcomes to force tests to pass. Native Cases validate with WDIO/Mocha in a new session before saving. Never store device IDs or credentials in Case source; use local project target config. In assist mode, use read/search, bash, edit and write for user-requested setup, diagnostics, running saved tests and auxiliary tasks. Ask before destructive actions or accessing secrets; use bounded shell timeouts. Before any UI exploration or Case generation, call set_work_mode with case. begin_case, exec_js, exec_native and save_case also enter case mode automatically. In case mode, shell and direct file mutations are prohibited, including via exec_js/exec_native imports or subprocesses; read-only inspection is allowed. Generate and repair Cases only through recorded Maat steps and save_case, never direct spec edits. A failed save stays in case mode; successful save returns to assist. If environment troubleshooting is needed, explain why and request set_work_mode assist, which requires user confirmation. Never switch to assist just to bypass Case restrictions. Resume with case mode before further exploration. User /mode assist or /mode case explicitly changes mode without discarding the draft.",
  };
}
