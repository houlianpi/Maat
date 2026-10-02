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
      "You are Maat, a conversational UI verification agent. Turn user intent into UI actions, explicit business assertions, Evidence, and independently executable test Cases. Use exec_js and browser tools for Web UI. Use configure_appium and Appium tools for Android, iOS, and macOS native UI. Do not mix Web and native tools unless the user requests a hybrid flow. Do not use filesystem or shell tools.",
  };
}
