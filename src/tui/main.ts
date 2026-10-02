import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { BrowserManager } from "../browser/browser-manager.ts";
import { AppiumManager } from "../appium/appium-manager.ts";
import { createAppiumTools } from "../appium/appium-tools.ts";
import { CaseManager } from "../cases/case-manager.ts";
import { createCaseTools } from "../cases/case-tools.ts";
import { createExecJsTool } from "../tools/exec-js-tool.ts";
import { createMaatExtension } from "./maat-extension.ts";
import {
  createMaatResourceOptions,
  createMaatSettings,
} from "./maat-runtime-config.ts";

const cwd = process.cwd();
const maatDir = path.join(homedir(), ".maat");
const sessionDir = path.join(maatDir, "sessions");
const piAgentDir = getAgentDir();
await mkdir(sessionDir, { recursive: true });
process.env.PI_SKIP_VERSION_CHECK = "1";

const browserManager = new BrowserManager();
const appiumManager = new AppiumManager();
const caseManager = new CaseManager();
const caseTools = createCaseTools(caseManager, browserManager);
const appiumTools = createAppiumTools(appiumManager, caseManager);
const customTools = [
  createExecJsTool(browserManager, caseManager),
  ...caseTools,
  ...appiumTools,
];
const piSettings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings();
const maatSettings = SettingsManager.create(cwd, maatDir, {
  projectTrusted: false,
});
if (!maatSettings.getDefaultProvider() && piSettings.defaultProvider) {
  maatSettings.setDefaultProvider(piSettings.defaultProvider);
}
if (!maatSettings.getDefaultModel() && piSettings.defaultModel) {
  if (piSettings.defaultProvider) {
    maatSettings.setDefaultModelAndProvider(
      piSettings.defaultProvider,
      piSettings.defaultModel,
    );
  } else {
    maatSettings.setDefaultModel(piSettings.defaultModel);
  }
}
if (!maatSettings.getDefaultThinkingLevel() && piSettings.defaultThinkingLevel) {
  maatSettings.setDefaultThinkingLevel(piSettings.defaultThinkingLevel);
}
if (!maatSettings.getTheme() && piSettings.theme) {
  maatSettings.setTheme(piSettings.theme);
}
maatSettings.setLastChangelogVersion(VERSION);
await maatSettings.flush();
maatSettings.applyOverrides(createMaatSettings(maatSettings.getGlobalSettings()));
const modelRuntime = await ModelRuntime.create({
  authPath: path.join(piAgentDir, "auth.json"),
  modelsPath: path.join(piAgentDir, "models.json"),
});
const maatExtension = createMaatExtension(
  browserManager,
  caseManager,
  appiumManager,
);

const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd: runtimeCwd,
  sessionManager,
  sessionStartEvent,
}) => {
  const services = await createAgentSessionServices({
    cwd: runtimeCwd,
    agentDir: maatDir,
    modelRuntime,
    settingsManager: maatSettings,
    resourceLoaderOptions: createMaatResourceOptions([maatExtension]),
  });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      tools: customTools.map((tool) => tool.name),
      customTools,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd,
  agentDir: maatDir,
  sessionManager: SessionManager.create(cwd, sessionDir),
});

try {
  const tui = new InteractiveMode(runtime, {
    startupDiagnostics: [...runtime.diagnostics],
    modelFallbackMessage: runtime.modelFallbackMessage,
  });
  await tui.run();
} finally {
  await browserManager.close();
  await appiumManager.close();
  await runtime.dispose();
}
