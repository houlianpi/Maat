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
import { CaseManager } from "../cases/case-manager.ts";
import { createCaseTools } from "../cases/case-tools.ts";
import { createExecJsTool } from "../tools/exec-js-tool.ts";
import { ProjectManager } from '../projects/project-manager.ts';
import { createProjectTools } from '../projects/project-tools.ts';
import { createDefaultPlatformRegistry } from '../platforms/default-registry.ts';
import { createMaatExtension } from "./maat-extension.ts";
import { createWorkModeExtension } from './work-mode.ts';
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

const browserManager = new BrowserManager(path.resolve('maat-tests/web'));
const caseManager = new CaseManager();
const testsRoot = path.resolve('maat-tests');
const projects = new ProjectManager(createDefaultPlatformRegistry(testsRoot, browserManager), testsRoot);
const caseTools = createCaseTools(caseManager, projects);
const customTools = [
  createExecJsTool({
    close: () => projects.adapter.close(),
    execute: (code, signal) => projects.execute(code, signal),
  }, caseManager, {
    description: 'Execute JavaScript against the active Platform Adapter. Call list_platforms after switching to see the available runtime globals.',
    guidelines: ['Use only globals exposed by the active adapter codeContext.'],
  }, () => ({ adapterId: projects.adapter.id, bindings: projects.adapter.codeContext.globals.map(item => item.name), requirement: projects.adapter.runtimeRequirement() })),
  ...caseTools,
  ...createProjectTools(projects, caseManager),
  ...projects.registry.list().flatMap(adapter => adapter.tools?.() ?? []),
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
const maatExtension = createMaatExtension(caseManager, () => projects.status());

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
    resourceLoaderOptions: createMaatResourceOptions([maatExtension, createWorkModeExtension(), {
      name: 'maat-cleanup', hidden: true, factory: pi => {
        pi.on('session_shutdown', async () => {
          await projects.close();
        });
      },
    }]),
  });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'set_work_mode', ...customTools.map((tool) => tool.name)],
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
  try { await projects.close(); } finally { await runtime.dispose(); }
}
