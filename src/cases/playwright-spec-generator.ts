import type { CaseDraft } from "./types.ts";

function indent(code: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return code
    .trim()
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function tag(value: string): string {
  return `@${value.trim().replace(/\s+/g, "-")}`;
}

function commentLines(title: string, items: string[]): string[] {
  return [
    ` * ${title}:`,
    ...(items.length > 0
      ? items.map((item, index) => ` * ${index + 1}. ${item.replace(/\*\//g, "* /")}`)
      : [" * None."]),
    " *",
  ];
}

function annotation(
  type: string,
  lines: string[],
): { type: string; description: string } {
  return {
    type,
    description: lines.length > 0 ? lines.join("\n") : "None.",
  };
}

export type PlaywrightSpecOptions = {
  fixtureImport?: string;
};

export function generatePlaywrightSpec(
  draft: CaseDraft,
  options: PlaywrightSpecOptions = {},
): string {
  const tags = [
    ...draft.tags.map(tag),
    ...draft.suites.map((suite) => `@suite:${suite}`),
  ];
  const annotations = [
    annotation("Case ID", [draft.id]),
    annotation("Description", [draft.description]),
    annotation("Preconditions", draft.preconditions),
    annotation("Action steps", draft.actionSteps),
    annotation(
      "Test objectives",
      draft.objectives.map(
        (objective) => `[${objective.id}] ${objective.description}`,
      ),
    ),
  ];
  const recordedSteps = draft.steps
    .map(
      (step) => `
    await test.step(${JSON.stringify(`Recorded step ${String(step.number).padStart(3, "0")}`)}, async () => {
      await (async (page, context, browser, expect, console, display) => {
${indent(step.code, 8)}
      })(page, context, browser, expect, console, display);
    });`,
    )
    .join("\n");

  const documentation = [
    "/**",
    ` * Case ID: ${draft.id}`,
    ` * Name: ${draft.name.replace(/\*\//g, "* /")}`,
    " *",
    " * Description:",
    ` * ${draft.description.replace(/\*\//g, "* /")}`,
    " *",
    ...commentLines("Preconditions", draft.preconditions),
    ...commentLines("Action steps", draft.actionSteps),
    ...commentLines(
      "Test objectives",
      draft.objectives.map(
        (objective) => `[${objective.id}] ${objective.description}`,
      ),
    ),
    " */",
  ].join("\n");

  return `${documentation}

import { test, expect } from ${JSON.stringify(options.fixtureImport ?? "../../fixtures/maat-test.ts")};

test.describe(${JSON.stringify(draft.name)}, {
  tag: ${JSON.stringify(tags)},
  annotation: ${JSON.stringify(annotations, null, 2)},
}, () => {
  test(${JSON.stringify(draft.id)}, async ({ page, context, browser }, testInfo) => {
    const pendingAttachments: Promise<void>[] = [];
    const display = (value: string | Uint8Array) => {
      const dataUrl = typeof value === "string" && value.startsWith("data:image/")
        ? value.split(",", 2)[1]
        : undefined;
      const body = typeof value === "string"
        ? Buffer.from(dataUrl ?? value, "base64")
        : Buffer.from(value);
      pendingAttachments.push(
        testInfo.attach("evidence-" + (pendingAttachments.length + 1) + ".png", {
          body,
          contentType: "image/png",
        }),
      );
    };

    try {${recordedSteps}
    } finally {
      await Promise.all(pendingAttachments);
    }
  });
});
`;
}

export const maatFixtureSource = `import { test as base, expect } from "playwright/test";

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    try {
      await use(page);
    } finally {
      if (!page.isClosed()) {
        const body = await page.screenshot({ fullPage: true });
        await testInfo.attach("final-state", {
          body,
          contentType: "image/png",
        });
      }
    }
  },
});

export { expect };
`;

export const playwrightConfigSource = `import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./cases",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  outputDir: "../../artifacts/playwright/test-results",
  reporter: [
    ["line"],
    ["html", { outputFolder: "../../artifacts/playwright/report", open: "never" }],
  ],
  use: {
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: process.env.MAAT_VIDEO === "1" ? "retain-on-failure" : "off",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "chrome", use: { browserName: "chromium", channel: "chrome" } },
    { name: "chrome-beta", use: { browserName: "chromium", channel: "chrome-beta" } },
    { name: "edge", use: { browserName: "chromium", channel: "msedge" } },
    { name: "edge-beta", use: { browserName: "chromium", channel: "msedge-beta" } },
  ],
});
`;
