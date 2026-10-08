import type { MaatApi } from '@houlianpi/maat-core';
import { createCaseTools } from './tools/case-tools.ts';
import { createExecJsTool } from './tools/exec-js-tool.ts';
import { createPlatformTools } from './tools/platform-tools.ts';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

/** Pi-specific projection of the host-neutral Maat API. */
export function createMaatPiTools(maat: MaatApi): ToolDefinition<any, any, any>[] {
  return [
    createExecJsTool(
      {
        close: () => maat.platforms.current().close(),
        execute: (code, signal) => maat.exploration.executeJavaScript(code, signal),
      },
      maat.drafts,
      {
        description:
          'Execute JavaScript against the active Platform Adapter. Call list_platforms after switching to see the available runtime globals.',
        guidelines: ['Use only globals exposed by the active adapter codeContext.'],
      },
      () => maat.exploration.execution(),
    ),
    ...createCaseTools(maat),
    ...createPlatformTools(maat),
  ];
}
