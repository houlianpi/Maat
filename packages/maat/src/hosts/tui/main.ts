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
} from '@earendil-works/pi-coding-agent';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createMaat } from '@houlianpi/maat-core';
import {
  createMaatExtension,
  createMaatPiTools,
  createWorkModeExtension,
} from '@houlianpi/maat-pi';

import { createMaatResourceOptions, createMaatSettings } from './runtime-config.ts';

const cwd = process.cwd();
const maatDir = path.join(homedir(), '.maat');
const sessionDir = path.join(maatDir, 'sessions');
const piAgentDir = getAgentDir();
await mkdir(sessionDir, { recursive: true });
process.env.PI_SKIP_VERSION_CHECK = '1';

const maat = createMaat({ workspaceRoot: cwd });
const customTools = createMaatPiTools(maat);
const piSettings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings();
const maatSettings = SettingsManager.create(cwd, maatDir, {
  projectTrusted: false,
});
if (!maatSettings.getDefaultProvider() && piSettings.defaultProvider) {
  maatSettings.setDefaultProvider(piSettings.defaultProvider);
}
if (!maatSettings.getDefaultModel() && piSettings.defaultModel) {
  if (piSettings.defaultProvider) {
    maatSettings.setDefaultModelAndProvider(piSettings.defaultProvider, piSettings.defaultModel);
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
  authPath: path.join(piAgentDir, 'auth.json'),
  modelsPath: path.join(piAgentDir, 'models.json'),
});
const maatExtension = createMaatExtension(maat.drafts, () => maat.platforms.status());

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
    resourceLoaderOptions: createMaatResourceOptions([
      maatExtension,
      createWorkModeExtension(),
      {
        name: 'maat-cleanup',
        hidden: true,
        factory: (pi) => {
          pi.on('session_shutdown', async () => {
            await maat.close();
          });
        },
      },
    ]),
  });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      tools: [
        'read',
        'bash',
        'edit',
        'write',
        'grep',
        'find',
        'ls',
        'set_work_mode',
        ...customTools.map((tool) => tool.name),
      ],
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
  try {
    await maat.close();
  } finally {
    await runtime.dispose();
  }
}
