import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { createMaat } from '@houlianpi/maat-core';
import { createMaatPiTools } from './tools.ts';
import { MAAT_SYSTEM_PROMPT } from './system-prompt.ts';
import { maatStatusLines } from './status.ts';
import { registerWorkModeExtension } from './work-mode.ts';

/** Pi package entry point. Each loaded extension instance owns one Maat lifecycle. */
export default function maatPiExtension(pi: ExtensionAPI): void {
  const maat = createMaat({ workspaceRoot: process.cwd() });

  for (const tool of createMaatPiTools(maat)) pi.registerTool(tool);
  registerWorkModeExtension(pi);

  const renderStatus = (ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui') return;
    ctx.ui.setWidget('maat-status', maatStatusLines(maat.platforms.status(), maat.drafts), {
      placement: 'aboveEditor',
    });
  };

  pi.on('session_start', async (_event, ctx) => renderStatus(ctx));
  pi.on('tool_execution_end', async (_event, ctx) => renderStatus(ctx));
  pi.on('session_shutdown', async () => maat.close());
  pi.on('before_agent_start', (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${MAAT_SYSTEM_PROMPT}`,
  }));

  pi.registerCommand('maat-status', {
    description: 'Show the active Maat platform, Case, and Evidence status',
    handler: async (_args, ctx) => {
      ctx.ui.notify(maatStatusLines(maat.platforms.status(), maat.drafts).join('\n'), 'info');
    },
  });
}
