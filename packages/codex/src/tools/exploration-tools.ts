import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { CodexMaatRuntime } from '../runtime.ts';
import { bindMaatRequest } from '../request.ts';

export function registerExplorationTools(server: McpServer, runtime: CodexMaatRuntime): void {
  server.registerTool(
    'maat_get_execution_context',
    {
      title: 'Get Maat Execution Context',
      description:
        'Return the globals and guidelines available to JavaScript on the active adapter.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (extra) => {
      await bindMaatRequest(runtime, extra);
      return {
        structuredContent: runtime.maat.exploration.context(),
        content: [
          { type: 'text', text: JSON.stringify(runtime.maat.exploration.context(), null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    'maat_execute_javascript',
    {
      title: 'Execute Maat JavaScript',
      description:
        'Execute JavaScript in the active persistent UI Session. Exploration is not recorded unless record=true with stepName.',
      inputSchema: {
        code: z
          .string()
          .min(1)
          .max(64 * 1024),
        record: z.boolean().optional(),
        stepName: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ code, record, stepName }, extra) => {
      await bindMaatRequest(runtime, extra);
      if (record && !stepName?.trim()) throw new Error('stepName is required when record=true.');
      const observations = await runtime.maat.exploration.executeJavaScript(code, extra.signal);
      if (record) {
        await runtime.maat.drafts.recordSuccessfulStep(
          code,
          observations,
          runtime.maat.exploration.execution(),
          stepName!.trim(),
        );
      }
      return {
        structuredContent: { recorded: record === true, observationCount: observations.length },
        content: observations,
      };
    },
  );

  server.registerTool(
    'maat_close_exploration',
    {
      title: 'Close Maat Exploration',
      description:
        'Close the active persistent exploration Session without closing external servers.',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (extra) => {
      await bindMaatRequest(runtime, extra);
      await runtime.maat.platforms.current().close();
      return { content: [{ type: 'text', text: 'Exploration Session closed.' }] };
    },
  );
}
