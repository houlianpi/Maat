import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { CodexMaatRuntime } from '../runtime.ts';
import { jsonResult } from '../result.ts';
import { bindMaatRequest } from '../request.ts';

const optionalCapabilities = z.enum(['screenCapture', 'videoRecording', 'fullDiskAccess']);

export function registerSetupTools(server: McpServer, runtime: CodexMaatRuntime): void {
  server.registerTool(
    'maat_check_setup',
    {
      title: 'Check Maat Setup',
      description: 'Read-only check of the selected platform setup and capabilities.',
      inputSchema: { platform: z.string().optional(), serverUrl: z.string().url().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ platform, serverUrl }, extra) => {
      await bindMaatRequest(runtime, extra);
      return jsonResult(
        await runtime.maat.setup.check({
          platform: platform ?? runtime.maat.platforms.current().id,
          serverUrl,
          signal: extra.signal,
        }),
      );
    },
  );

  server.registerTool(
    'maat_get_setup_diagnostics',
    {
      title: 'Get Maat Setup Diagnostics',
      description: 'Return redacted technical setup diagnostics for the current platform.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (extra) => {
      await bindMaatRequest(runtime, extra);
      return jsonResult(runtime.maat.setup.current());
    },
  );

  server.registerTool(
    'maat_open_setup_step',
    {
      title: 'Prepare Maat Setup Step',
      description:
        'Record the currently recommended setup action and return its Settings URL or command. Does not grant permissions or run commands.',
      inputSchema: { actionId: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ actionId }, extra) => {
      await bindMaatRequest(runtime, extra);
      return jsonResult(
        await runtime.maat.setup.action(
          actionId as Parameters<typeof runtime.maat.setup.action>[0],
        ),
      );
    },
  );

  server.registerTool(
    'maat_retry_setup_step',
    {
      title: 'Retry Maat Setup Step',
      description: 'Recheck setup after the user completes the requested system action.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (extra) => {
      await bindMaatRequest(runtime, extra);
      return jsonResult(
        await runtime.maat.setup.check({
          platform: runtime.maat.platforms.current().id,
          signal: extra.signal,
        }),
      );
    },
  );

  server.registerTool(
    'maat_continue_without_capability',
    {
      title: 'Continue Without Maat Capability',
      description:
        'Skip an optional capability after the user explicitly chooses to continue without it.',
      inputSchema: { capability: optionalCapabilities },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ capability }, extra) => {
      await bindMaatRequest(runtime, extra);
      return jsonResult(await runtime.maat.setup.skip(capability));
    },
  );
}
