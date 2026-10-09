import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { bindMaatRequest } from './request.ts';
import type { CodexMaatRuntime } from './runtime.ts';
import { dashboardEvidence, dashboardState } from './dashboard-state.ts';
import { z } from 'zod';

export const dashboardUri = 'ui://maat/dashboard.html';

export function registerDashboard(server: McpServer, runtime: CodexMaatRuntime): void {
  server.registerResource(
    'maat-dashboard',
    dashboardUri,
    {
      title: 'Maat Dashboard',
      description: 'Platform, Session, Case, Evidence, and latest test run.',
      mimeType: 'text/html;profile=mcp-app',
      _meta: { ui: { prefersBorder: false } },
    },
    async () => ({
      contents: [
        {
          uri: dashboardUri,
          mimeType: 'text/html;profile=mcp-app',
          text: await readFile(
            fileURLToPath(new URL('../ui/dashboard.html', import.meta.url)),
            'utf8',
          ),
          _meta: {
            ui: {
              prefersBorder: false,
              csp: { connectDomains: [], resourceDomains: [] },
            },
          },
        },
      ],
    }),
  );

  server.registerTool(
    'maat_get_evidence_preview',
    {
      title: 'Load Maat Evidence Preview',
      description: 'Load one Dashboard Evidence image by ID.',
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ['app'] } },
    },
    async ({ id }, extra) => {
      await bindMaatRequest(runtime, extra);
      const image = await dashboardEvidence(runtime, id);
      return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }] };
    },
  );

  server.registerTool(
    'maat_get_dashboard_state',
    {
      title: 'Refresh Maat Dashboard',
      description:
        'Return the current Maat platform, Session, Case, Evidence, and latest run state.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (extra) => {
      await bindMaatRequest(runtime, extra);
      const state = await dashboardState(runtime);
      return {
        structuredContent: state,
        content: [{ type: 'text', text: 'Dashboard refreshed.' }],
      };
    },
  );

  server.registerTool(
    'maat_open_dashboard',
    {
      title: 'Open Maat Dashboard',
      description:
        'Open the Maat conversation panel with current Platform, Session, Case, Evidence, and latest test run.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: {
        ui: { resourceUri: dashboardUri, visibility: ['model', 'app'] },
        'openai/ui': { entrypoints: [{ type: 'thread' }] },
        'openai/toolInvocation/invoking': 'Opening Maat Dashboard…',
        'openai/toolInvocation/invoked': 'Maat Dashboard opened.',
      },
    },
    async (extra) => {
      await bindMaatRequest(runtime, extra);
      const state = await dashboardState(runtime);
      return {
        structuredContent: state,
        content: [{ type: 'text', text: 'Showing the current Maat Dashboard.' }],
      };
    },
  );
}
