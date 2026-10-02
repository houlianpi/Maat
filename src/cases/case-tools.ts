import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import { browserNames, type BrowserName } from "../browser/browser-options.ts";
import type { BrowserManager } from "../browser/browser-manager.ts";
import { validateAndSaveCase } from "./case-store.ts";
import type { CaseManager } from "./case-manager.ts";

export function createCaseTools(
  caseManager: CaseManager,
  browserManager: BrowserManager,
) {
  const configureBrowser = defineTool({
    name: "configure_browser",
    label: "Configure Browser",
    description:
      "Configure the browser used by later exec_js calls. Changing configuration closes the current browser.",
    parameters: Type.Object({
      browser: Type.Optional(Type.Union(browserNames.map((name) => Type.Literal(name)))),
      headless: Type.Optional(Type.Boolean()),
      profile: Type.Optional(
        Type.String({ description: "Logical profile name from maat-tests/maat.config.json; empty clears it" }),
      ),
    }),
    execute: async (_id, params) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await browserManager.configure({
              ...(params.browser ? { browser: params.browser as BrowserName } : {}),
              ...(params.headless !== undefined ? { headless: params.headless } : {}),
              ...(params.profile !== undefined ? { profile: params.profile } : {}),
            }),
          ),
        },
      ],
      details: {},
    }),
  });

  const getBrowserConfig = defineTool({
    name: "get_browser_config",
    label: "Get Browser Config",
    description: "Return the current browser configuration.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [
        { type: "text", text: JSON.stringify(browserManager.currentConfig) },
      ],
      details: {},
    }),
  });

  const beginCase = defineTool({
    name: "begin_case",
    label: "Begin Case",
    description:
      "Start a test Case from the user's natural-language description, action steps, and explicit test objectives.",
    parameters: Type.Object({
      id: Type.String(),
      module: Type.Optional(
        Type.String({
          description:
            "Optional module path under maat-tests/cases, for example calculator or payments/refunds",
        }),
      ),
      name: Type.String(),
      description: Type.String(),
      preconditions: Type.Optional(Type.Array(Type.String())),
      actionSteps: Type.Optional(Type.Array(Type.String())),
      objectives: Type.Array(Type.String(), { minItems: 1 }),
      tags: Type.Optional(Type.Array(Type.String())),
      suites: Type.Optional(Type.Array(Type.String())),
      rootDirectory: Type.Optional(Type.String({ default: "maat-tests" })),
    }),
    execute: async (_id, params) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(caseManager.begin(params)),
        },
      ],
      details: {},
    }),
  });

  const getCaseStatus = defineTool({
    name: "get_case_status",
    label: "Get Case Status",
    description: "Return the active Case objectives, candidate steps, failures, and Evidence count.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: JSON.stringify(caseManager.status()) }],
      details: {},
    }),
  });

  const saveCase = defineTool({
    name: "save_case",
    label: "Validate and Save Case",
    description:
      "Re-run all candidate steps in a fresh browser session. Only when every step and assertion passes, save one standard Playwright case.spec.ts containing natural-language documentation, tags, Suite tags, executable steps, and assertions.",
    parameters: Type.Object({}),
    execute: async () => {
      const draft = caseManager.current;
      if (!draft) throw new Error("No active Case. Call begin_case first.");
      const result = await validateAndSaveCase(draft, browserManager);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });

  const listEvidence = defineTool({
    name: "list_evidence",
    label: "List Evidence",
    description: "List text and screenshot Evidence captured for the active Case.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [
        { type: "text", text: JSON.stringify(caseManager.listEvidence()) },
      ],
      details: {},
    }),
  });

  const showEvidence = defineTool({
    name: "show_evidence",
    label: "Show Evidence",
    description:
      "Return one Evidence item. Screenshot Evidence is rendered inline by Pi TUI when the terminal supports images.",
    parameters: Type.Object({ id: Type.String() }),
    execute: async (_id, params) => {
      const evidence = caseManager.getEvidence(params.id);
      if (!evidence) throw new Error(`Unknown Evidence id: ${params.id}`);
      if (evidence.type === "text") {
        return {
          content: [{ type: "text" as const, text: evidence.text ?? "" }],
          details: evidence,
        };
      }
      if (!evidence.path || !evidence.mimeType) {
        throw new Error(`Image Evidence ${params.id} is incomplete.`);
      }
      return {
        content: [
          {
            type: "image" as const,
            data: (await readFile(evidence.path)).toString("base64"),
            mimeType: evidence.mimeType,
          },
          { type: "text" as const, text: evidence.path },
        ],
        details: evidence,
      };
    },
  });

  return [
    configureBrowser,
    getBrowserConfig,
    beginCase,
    getCaseStatus,
    saveCase,
    listEvidence,
    showEvidence,
  ];
}
import { readFile } from "node:fs/promises";
