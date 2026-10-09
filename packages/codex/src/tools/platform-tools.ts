import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { browserNames, nativeDeviceKinds } from '@houlianpi/maat-core';
import { z } from 'zod';

import type { CodexMaatRuntime } from '../runtime.ts';
import { jsonResult, textResult } from '../result.ts';
import { bindMaatRequest } from '../request.ts';

export function registerPlatformTools(server: McpServer, runtime: CodexMaatRuntime): void {
  server.registerTool(
    'maat_list_platforms',
    {
      title: 'List Maat Platforms',
      description: 'List Maat UI platform adapters and the JavaScript globals each exposes.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (extra) => {
      await bindMaatRequest(runtime, extra);
      return jsonResult(
        runtime.maat.platforms.list().map((adapter) => ({
          id: adapter.id,
          label: adapter.label,
          codeContext: adapter.codeContext,
        })),
      );
    },
  );

  server.registerTool(
    'maat_select_platform',
    {
      title: 'Select Maat Platform',
      description: 'Select the active Web, Android, iOS, or macOS adapter.',
      inputSchema: { platform: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ platform }, extra) => {
      await bindMaatRequest(runtime, extra);
      return jsonResult(await runtime.maat.platforms.select(platform));
    },
  );

  server.registerTool(
    'maat_get_platform_status',
    {
      title: 'Get Maat Platform Status',
      description: 'Return the selected platform and persistent exploration Session state.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (extra) => {
      await bindMaatRequest(runtime, extra);
      return jsonResult(runtime.maat.platforms.status());
    },
  );

  server.registerTool(
    'maat_configure_browser',
    {
      title: 'Configure Maat Browser',
      description: 'Configure the Web adapter browser, headless mode, or logical profile.',
      inputSchema: {
        browser: z.enum(browserNames).optional(),
        headless: z.boolean().optional(),
        profile: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input, extra) => {
      await bindMaatRequest(runtime, extra);
      return jsonResult(await runtime.maat.platforms.configure(input));
    },
  );

  server.registerTool(
    'maat_configure_session',
    {
      title: 'Configure Maat Session',
      description:
        'Provide optional Appium Server, device, App, and reset hints to the active native adapter.',
      inputSchema: {
        serverUrl: z.string().url().optional(),
        device: z
          .object({
            kind: z.enum(nativeDeviceKinds).optional(),
            name: z.string().min(1).optional(),
          })
          .optional(),
        capabilities: z.record(z.string(), z.unknown()).optional(),
        allowDataReset: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (input, extra) => {
      await bindMaatRequest(runtime, extra);
      await runtime.maat.platforms.configureSession(input);
      return textResult('Session hints accepted.', runtime.maat.platforms.status());
    },
  );

  server.registerTool(
    'maat_list_devices',
    {
      title: 'List Maat Devices',
      description: 'Discover online devices for the selected Appium platform.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (extra) => {
      await bindMaatRequest(runtime, extra);
      return jsonResult(await runtime.maat.platforms.inspectSetup({ kind: 'devices' }));
    },
  );

  server.registerTool(
    'maat_find_applications',
    {
      title: 'Find Applications',
      description: 'Find installed applications matching a name on the selected native device.',
      inputSchema: { query: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ query }, extra) => {
      await bindMaatRequest(runtime, extra);
      return jsonResult(await runtime.maat.platforms.inspectSetup({ kind: 'applications', query }));
    },
  );
}
