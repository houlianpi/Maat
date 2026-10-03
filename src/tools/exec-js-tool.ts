import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import type { StepRecorder } from "../recording/run-recorder.ts";
import type { JavaScriptSession } from "../worker/javascript-session.ts";
import type { StepExecution } from '../recording/run-recorder.ts';

export function createExecJsTool(
  session: JavaScriptSession,
  recorder?: StepRecorder,
  context?: { description?: string; guidelines?: string[] },
  execution?: () => StepExecution,
) {
  return defineTool({
    name: "exe_js",
    label: "Execute JavaScript",
    description:
      context?.description ?? "Execute asynchronous JavaScript against the active persistent UI Session. Use console.log() for text observations and display() for images.",
    promptSnippet: "Execute JavaScript in the active persistent UI Session",
    promptGuidelines: [
      "Use exe_js for all UI interaction.",
      "Session state persists across exe_js calls.",
      "Infer assertions only from the user's explicit test objective, expected result, or acceptance criteria.",
      "Use the active framework's expect assertions for business outcomes so a failed expectation fails exe_js.",
      "Do not add redundant assertions for navigation, element lookup, or other prerequisites already enforced by Playwright operations.",
      "If the user gives no expected business outcome, do not invent one merely to add an assertion.",
      ...(context?.guidelines ?? []),
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      code: Type.String({
        description:
          "Async JavaScript body using page, context, browser, expect, console, and display",
      }),
    }),
    execute: async (_toolCallId, params, signal) => {
      try {
        const observations = await session.execute(params.code, signal);
        await recorder?.recordSuccessfulStep(params.code, observations, execution?.());
        return {
          content: observations,
          details: { observationCount: observations.length },
        };
      } catch (error) {
        await recorder?.recordFailedStep(params.code, error, execution?.());
        throw error;
      }
    },
  });
}
