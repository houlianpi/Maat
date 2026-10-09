import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { CodexMaatRuntime } from '../runtime.ts';
import { jsonResult } from '../result.ts';
import { bindMaatRequest } from '../request.ts';

export function registerTestTools(server: McpServer, runtime: CodexMaatRuntime): void {
  server.registerTool(
    'maat_run_tests',
    {
      title: 'Run Maat Tests',
      description: 'Run a saved Maat Case, Suite, tag, or all Cases without an LLM.',
      inputSchema: {
        case: z.string().min(1).optional(),
        suite: z.string().min(1).optional(),
        tag: z.string().min(1).optional(),
        all: z.boolean().optional(),
        browser: z.string().optional(),
        headed: z.boolean().optional(),
        appId: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input, extra) => {
      await bindMaatRequest(runtime, extra);
      const selectors = [input.case, input.suite, input.tag, input.all ? true : undefined].filter(
        Boolean,
      );
      if (selectors.length !== 1)
        throw new Error('Choose exactly one of case, suite, tag, or all=true.');
      const selection = input.case
        ? ({ mode: 'case', value: input.case } as const)
        : input.suite
          ? ({ mode: 'suite', value: input.suite } as const)
          : input.tag
            ? ({ mode: 'tag', value: input.tag } as const)
            : ({ mode: 'all' } as const);
      return jsonResult(
        await runtime.runTests(
          selection,
          { browser: input.browser, headed: input.headed, appId: input.appId },
          extra.signal,
        ),
      );
    },
  );

  server.registerTool(
    'maat_get_latest_run',
    {
      title: 'Get Latest Maat Run',
      description: 'Return the most recent completed Maat run and its structured result.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (extra) => {
      await bindMaatRequest(runtime, extra);
      return jsonResult((await runtime.latestRun()) ?? { available: false });
    },
  );
}
