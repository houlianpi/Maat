import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

import { BrowserManager } from "../browser/browser-manager.ts";
import { CaseManager } from "../cases/case-manager.ts";
import { createCaseTools } from "../cases/case-tools.ts";
import { createExecJsTool } from "../tools/exec-js-tool.ts";

const cwd = process.cwd();
const browserManager = new BrowserManager();
const caseManager = new CaseManager();
const caseTools = createCaseTools(caseManager, browserManager);
const customTools = [
  createExecJsTool(browserManager, caseManager),
  ...caseTools,
];

const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd: runtimeCwd,
  sessionManager,
  sessionStartEvent,
}) => {
  const services = await createAgentSessionServices({ cwd: runtimeCwd });
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
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(cwd),
});

try {
  const tui = new InteractiveMode(runtime, {
    startupDiagnostics: [...runtime.diagnostics],
    modelFallbackMessage: runtime.modelFallbackMessage,
  });
  await tui.run();
} finally {
  await browserManager.close();
  await runtime.dispose();
}
