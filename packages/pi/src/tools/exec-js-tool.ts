import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { JavaScriptSession, StepExecution, StepRecorder } from '@houlianpi/maat-core';

export function createExecJsTool(
  session: JavaScriptSession,
  recorder?: StepRecorder,
  context?: { description?: string; guidelines?: string[] },
  execution?: () => StepExecution,
  actionableError?: (
    error: unknown,
    ctx: Parameters<ToolDefinition<any, any, any>['execute']>[4],
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
      'Exploration is not recorded by default. Set record=true with a concise stepName only for code that belongs in the formal Case.',
      'Use console.log() for text. display() accepts only image bytes or PNG/JPEG/WebP base64 data URLs.',
      "Infer assertions only from the user's explicit test objective, expected result, or acceptance criteria.",
      "Use the active framework's expect assertions for business outcomes so a failed expectation fails exe_js.",
      'Do not add redundant assertions for navigation, element lookup, or other prerequisites already enforced by Playwright operations.',
      'If the user gives no expected business outcome, do not invent one merely to add an assertion.',
      ...(context?.guidelines ?? []),
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      code: Type.String({
        description:
          'Async JavaScript body using page, context, browser, expect, console, and display',
      }),
      record: Type.Optional(
        Type.Boolean({ description: 'Record this successful execution as a formal Case step.' }),
      ),
      stepName: Type.Optional(
        Type.String({ description: 'Required human-readable Case step name when record=true.' }),
      ),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      try {
        if (params.record && !params.stepName?.trim())
          throw new Error('stepName is required when record=true.');
        const observations = await session.execute(params.code, signal);
        if (params.record)
          await recorder?.recordSuccessfulStep(
            params.code,
            observations,
            execution?.(),
            params.stepName!.trim(),
          );
        return {
          content: observations,
          details: { observationCount: observations.length, recorded: params.record === true },
        };
      } catch (error) {
        await recorder?.recordFailedStep(params.code, error, execution?.());
        const guidance = await actionableError?.(error, ctx);
        if (guidance) throw new Error(guidance, { cause: error });
        throw error;
      }
    },
  });
}
