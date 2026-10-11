import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { createMaat } from '@houlianpi/maat-core';
import { createMaatPiTools } from './tools.ts';
import { MAAT_SYSTEM_PROMPT } from './system-prompt.ts';
import { maatStatusLines } from './status.ts';
import { registerMaatSetupCommands } from './setup-extension.ts';
import { createMobileUi } from './mobile-ui.ts';

/** Pi package entry point. Each loaded extension instance owns one Maat lifecycle. */
export default function maatPiExtension(pi: ExtensionAPI): void {
  const maat = createMaat({ workspaceRoot: process.cwd() });

  const mobileTool = createMobileUi(pi, maat);
  const tools = createMaatPiTools(maat);
  for (const tool of tools) pi.registerTool(tool);

  const renderStatus = (ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui') return;
    if (pi.getFlag('maat-mobile-ui') === true) {
      mobileTool.update(ctx);
      return;
    }
    const status = maat.platforms.status();
    ctx.ui.setWidget('maat-status', maatStatusLines(status), {
      placement: 'aboveEditor',
    });
  };

  pi.on('session_start', async (_event, ctx) => {
    if (pi.getFlag('maat-mobile-ui') === true) {
      for (const tool of tools) pi.registerTool(mobileTool(tool));
    }
    renderStatus(ctx);
  });
  pi.on('tool_execution_end', async (_event, ctx) => renderStatus(ctx));
  pi.on('session_shutdown', async () => maat.close());
  pi.on('before_agent_start', (event, ctx) => {
    mobileTool.update(ctx);
    return { systemPrompt: `${event.systemPrompt}\n\n${MAAT_SYSTEM_PROMPT}` };
  });

  registerMaatSetupCommands(pi, maat, mobileTool.prepared);
}
