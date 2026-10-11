import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { JavaScriptSession } from '@houlianpi/maat-core';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createExecJsTool(
  session: JavaScriptSession,
  context?: { description?: string; guidelines?: string[] },
  actionableError?: (
    error: unknown,
    ctx: Parameters<ToolDefinition<any, any, any>['execute']>[4],
    signal?: AbortSignal,
  ) => Promise<string | undefined>,
): ToolDefinition<any, any, any> {
  return defineTool({
    name: 'exe_js',
    label: 'Execute JavaScript',
    description:
      context?.description ??
      'Execute asynchronous JavaScript against the active persistent UI Session. Use console.log() for text observations and display() only for image bytes or image data URLs.',
    promptSnippet: 'Execute JavaScript in the active persistent UI Session',
    promptGuidelines: [
      'Use exe_js for all UI interaction.',
      'Session state persists across exe_js calls.',
      'Use console.log() for text. display() accepts only image bytes or PNG/JPEG/WebP base64 data URLs.',
      "Only compare results against the user's declared expected outcome; do not invent business truth.",
      'If the user gives no expected business outcome, do not invent one merely to add an assertion.',
      ...(context?.guidelines ?? []),
    ],
    executionMode: 'sequential',
    parameters: Type.Object(
      {
        code: Type.String({
          description:
            'Async JavaScript body using the globals exposed by the active platform adapter',
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      try {
        const observations = await session.execute(params.code, signal);
        return {
          content: observations,
          details: { observationCount: observations.length },
        };
      } catch (error) {
        let guidance: string | undefined;
        try {
          guidance = await actionableError?.(error, ctx, signal);
        } catch (diagnosticError) {
          throw new Error(
            `${errorText(error)}\nSetup diagnosis also failed: ${errorText(diagnosticError)}`,
            { cause: error },
          );
        }
        if (guidance) throw new Error(`${errorText(error)}\n${guidance}`, { cause: error });
        throw error;
      }
    },
  });
}
