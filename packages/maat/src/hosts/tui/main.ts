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
  createMaatSetupExtension,
  MobilePreparation,
  closeMobileRuntime,
} from '@houlianpi/maat-pi';

import { createMaatResourceOptions, createMaatSettings } from './runtime-config.ts';

const cwd = process.cwd();
const maatDir = path.join(homedir(), '.maat');
const sessionDir = path.join(maatDir, 'sessions');
const piAgentDir = getAgentDir();
await mkdir(sessionDir, { recursive: true });
process.env.PI_SKIP_VERSION_CHECK = '1';

const maat = createMaat({ workspaceRoot: cwd });
let activePreparation: MobilePreparation | undefined;
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
const maatExtension = createMaatExtension(() => maat.platforms.status());

const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd: runtimeCwd,
  sessionManager,
  sessionStartEvent,
}) => {
  // Pi replaces this runtime on /new, /resume and /fork. Each owns new tasks;
  // never hand a replacement conversation the previous closed task owner.
  const preparation = new MobilePreparation(maat);
  activePreparation = preparation;
  const customTools = createMaatPiTools(maat, preparation);
  const services = await createAgentSessionServices({
    cwd: runtimeCwd,
    agentDir: maatDir,
    modelRuntime,
    settingsManager: maatSettings,
    resourceLoaderOptions: createMaatResourceOptions([
      maatExtension,
      createMaatSetupExtension(maat),
      {
        name: 'maat-cleanup',
        hidden: true,
        factory: (pi) => {
          pi.on('session_shutdown', async () => {
            await closeMobileRuntime(maat, preparation);
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
    if (activePreparation) await closeMobileRuntime(maat, activePreparation);
  } finally {
    await runtime.dispose();
  }
}
