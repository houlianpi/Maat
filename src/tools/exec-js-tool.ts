import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import type { StepRecorder } from "../recording/run-recorder.ts";
import type { JavaScriptSession } from "../worker/javascript-session.ts";

export function createExecJsTool(
  session: JavaScriptSession,
  recorder?: StepRecorder,
) {
  return defineTool({
    name: "exec_js",
    label: "Execute JavaScript",
    description:
      "Execute asynchronous JavaScript against one persistent Playwright page. " +
      "The variables page, context, browser, and Playwright expect are available. " +
      "Use console.log() for text observations and display(await page.screenshot()) " +
      "for images.",
    promptSnippet: "Execute JavaScript in the persistent Playwright browser",
    promptGuidelines: [
      "Use exec_js for all browser interaction.",
      "Inspect pages with Playwright locators and console.log concise observations.",
      "Use display(await page.screenshot()) only when visual inspection is needed.",
      "Browser state persists across exec_js calls in the same run.",
      "Infer assertions only from the user's explicit test objective, expected result, or acceptance criteria.",
      "Use Playwright expect assertions for those business outcomes so a failed expectation fails exec_js.",
      "Do not add redundant assertions for navigation, element lookup, or other prerequisites already enforced by Playwright operations.",
      "If the user gives no expected business outcome, do not invent one merely to add an assertion.",
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
        await recorder?.recordSuccessfulStep(params.code, observations);
        return {
          content: observations,
          details: { observationCount: observations.length },
        };
      } catch (error) {
        await recorder?.recordFailedStep(params.code, error);
        throw error;
      }
    },
  });
}
