import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { JavaScriptSession } from '@houlianpi/maat-core';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ModelExecutionFailure = {
  category: string;
  code?: string;
  phase: string;
  actionState: 'not-started' | 'uncertain';
  sessionState: 'reusable' | 'closed' | 'unknown';
  summary: string;
};

function executionFailure(error: unknown): ModelExecutionFailure {
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === 'mobile-busy')
      return {
        category: 'mobile-busy',
        code: 'mobile-busy',
        phase: 'acquire',
        actionState: 'not-started',
        sessionState: 'reusable',
        summary: 'Another mobile operation is already in progress.',
      };
    if (
      error.code === 'MAAT_EXECUTION_ERROR' &&
      'details' in error &&
      error.details &&
      typeof error.details === 'object'
    ) {
      const details = error.details as Record<string, unknown>;
      if (
        typeof details.category === 'string' &&
        typeof details.phase === 'string' &&
        (details.actionState === 'not-started' || details.actionState === 'uncertain')
      )
        return {
          category: details.category,
          phase: details.phase,
          actionState: details.actionState,
          sessionState: 'reusable',
          summary: `${typeof details.name === 'string' ? `${details.name}: ` : ''}${errorText(error)}`,
        };
    }
    if (error.code === 'MAAT_EXECUTION_TERMINATED')
      return {
        category: 'execution-terminated',
        phase: 'execute',
        actionState: 'uncertain',
        sessionState: 'closed',
        summary: errorText(error),
      };
  }
  return {
    category: 'unknown',
    phase: 'unknown',
    actionState: 'uncertain',
    sessionState: 'unknown',
    summary: errorText(error),
  };
}

function modelExecutionError(error: unknown): string {
  const failure = executionFailure(error);
  const recovery =
    failure.category === 'mobile-busy'
      ? 'No UI action ran. Wait for the current mobile operation to settle, then make a new explicit request.'
      : failure.actionState === 'not-started'
        ? 'No UI action ran. Correct the JavaScript using only globals from the active adapter codeContext, then retry.'
        : 'Earlier statements may already have changed the UI. Do not replay this code. First run a read-only exe_js observation of the current UI, then generate a new action from that state.';
  const hint =
    failure.category === 'reference-error' && /\bsetTimeout\b/.test(failure.summary)
      ? ' Appium wait hint: use await driver.pause(milliseconds).'
      : failure.category === 'reference-error' || failure.category === 'type-error'
        ? ' Values and functions created in an earlier exe_js call do not persist.'
        : '';
  return [
    'MAAT_EXECUTION_FAILED',
    `category: ${failure.category}`,
    ...(failure.code ? [`code: ${failure.code}`] : []),
    `phase: ${failure.phase}`,
    `session: ${failure.sessionState}`,
    `actionState: ${failure.actionState}`,
    `summary: ${failure.summary}`,
    `recovery: ${recovery}${hint}`,
  ].join('\n');
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
      'UI Session state persists across exe_js calls; JavaScript variables and functions do not.',
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
        const failure = modelExecutionError(error);
        let guidance: string | undefined;
        try {
          guidance = await actionableError?.(error, ctx, signal);
        } catch (diagnosticError) {
          throw new Error(
            `${failure}\nSetup diagnosis also failed: ${errorText(diagnosticError)}`,
            { cause: error },
          );
        }
        throw new Error(`${failure}${guidance ? `\n${guidance}` : ''}`, { cause: error });
      }
    },
  });
}
