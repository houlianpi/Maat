import { readFile } from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { CodexMaatRuntime } from '../runtime.ts';
import { jsonResult } from '../result.ts';
import { bindMaatRequest } from '../request.ts';

export function registerCaseTools(server: McpServer, runtime: CodexMaatRuntime): void {
  server.registerTool(
    'maat_begin_case',
    {
      title: 'Begin Maat Case',
      description:
        "Start a Case draft from the user's description, action steps, and explicit test objectives.",
      inputSchema: {
        id: z.string().min(1),
        module: z.string().optional(),
        name: z.string().min(1),
        description: z.string(),
        preconditions: z.array(z.string()).optional(),
        actionSteps: z.array(z.string()).optional(),
        objectives: z.array(z.string().min(1)).min(1),
        tags: z.array(z.string()).optional(),
        suites: z.array(z.string()).optional(),
        requireScreenshotEvidence: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input, extra) => {
      await bindMaatRequest(runtime, extra);
      return jsonResult(runtime.maat.cases.begin(input));
    },
  );

  server.registerTool(
    'maat_get_case_status',
    {
      title: 'Get Maat Case Status',
      description:
        'Return the active Case objectives, recorded steps, failed attempts, and Evidence.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (extra) => {
      await bindMaatRequest(runtime, extra);
      return jsonResult(runtime.maat.cases.status());
    },
  );

  server.registerTool(
    'maat_list_case_steps',
    {
      title: 'List Maat Case Steps',
      description: 'List formal candidate steps recorded for the active Case.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (extra) => {
      await bindMaatRequest(runtime, extra);
      return jsonResult(runtime.maat.cases.listSteps());
    },
  );

  server.registerTool(
    'maat_remove_case_step',
    {
      title: 'Remove Maat Case Step',
      description: 'Remove a diagnostic, redundant, or incorrect Case step by 1-based number.',
      inputSchema: { number: z.number().int().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ number }, extra) => {
      await bindMaatRequest(runtime, extra);
      runtime.maat.cases.removeStep(number);
      return jsonResult(runtime.maat.cases.listSteps());
    },
  );

  server.registerTool(
    'maat_replace_case_step',
    {
      title: 'Replace Maat Case Step',
      description: 'Replace the name and/or JavaScript of a recorded Case step.',
      inputSchema: {
        number: z.number().int().min(1),
        name: z.string().min(1).optional(),
        code: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ number, name, code }, extra) => {
      await bindMaatRequest(runtime, extra);
      runtime.maat.cases.replaceStep(number, { name, code });
      return jsonResult(runtime.maat.cases.listSteps());
    },
  );

  server.registerTool(
    'maat_save_case',
    {
      title: 'Validate and Save Maat Case',
      description:
        'Validate the complete Case in fresh Sessions and save an executable Mocha TypeScript spec. Failed validation does not save.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (extra) => {
      await bindMaatRequest(runtime, extra);
      return jsonResult(await runtime.maat.cases.save(extra.signal));
    },
  );

  server.registerTool(
    'maat_discard_case',
    {
      title: 'Discard Maat Case Draft',
      description: 'Discard the active unsaved Case draft. Does not delete saved Cases.',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (extra) => {
      await bindMaatRequest(runtime, extra);
      runtime.maat.cases.clear();
      return { content: [{ type: 'text', text: 'Active Case draft discarded.' }] };
    },
  );

  server.registerTool(
    'maat_list_evidence',
    {
      title: 'List Maat Evidence',
      description: 'List text and screenshot Evidence captured for the active Case.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (extra) => {
      await bindMaatRequest(runtime, extra);
      return jsonResult(runtime.maat.evidence.list());
    },
  );

  server.registerTool(
    'maat_show_evidence',
    {
      title: 'Show Maat Evidence',
      description: 'Return one text or screenshot Evidence item by ID.',
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ id }, extra) => {
      await bindMaatRequest(runtime, extra);
      const evidence = runtime.maat.evidence.get(id);
      if (!evidence) throw new Error(`Unknown Evidence id: ${id}`);
      if (evidence.type === 'text') {
        return {
          structuredContent: evidence,
          content: [{ type: 'text', text: evidence.text ?? '' }],
        };
      }
      if (!evidence.path || !evidence.mimeType)
        throw new Error(`Image Evidence ${id} is incomplete.`);
      return {
        structuredContent: evidence,
        content: [
          {
            type: 'image',
            data: (await readFile(evidence.path)).toString('base64'),
            mimeType: evidence.mimeType,
          },
          { type: 'text', text: evidence.path },
        ],
      };
    },
  );
}
