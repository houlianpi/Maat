export type ReplayStep = {
  number: number;
  code: string;
};

export type ReplayDefaults = {
  browser?: string;
};

export function generateReplay(steps: ReplayStep[], defaults: ReplayDefaults = {}): string {
  const stepBodies = steps
    .map(
      ({ number, code }) => `
  console.log("[replay] step ${String(number).padStart(3, '0')}");
  await (async (page, context, browser, expect, console, display) => {
${code
  .split('\n')
  .map((line) => `    ${line}`)
  .join('\n')}
  })(page, context, browser, expect, console, display);`,
    )
    .join('\n');

  return `import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import path from "node:path";

import { chromium } from "playwright";
import { expect } from "playwright/test";

const browserChannels = {
  chromium: undefined,
  chrome: "chrome",
  "chrome-beta": "chrome-beta",
  edge: "msedge",
  "edge-beta": "msedge-beta",
} as const;

const { values } = parseArgs({
  options: {
    browser: { type: "string", default: ${JSON.stringify(defaults.browser ?? 'chromium')} },
    "executable-path": { type: "string" },
    "user-data-dir": { type: "string" },
    "profile-directory": { type: "string" },
    headless: { type: "boolean" },
    headed: { type: "boolean" },
    url: { type: "string" },
    timeout: { type: "string", default: "30000" },
    viewport: { type: "string", default: "1440x900" },
    "slow-mo": { type: "string", default: "0" },
    "artifacts-dir": { type: "string", default: "replay-artifacts" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log([
    "Usage: maat replay replay.ts [options]",
    "",
    "--browser <chromium|chrome|chrome-beta|edge|edge-beta>",
    "--executable-path <path>  Use a specific browser executable (mutually exclusive with a channel)",
    "--user-data-dir <path>   Reuse a persistent browser profile root",
    "--profile-directory <name> Profile inside the user-data directory, such as Default",
    "--headless                Run without a visible window (default)",
    "--headed                  Run with a visible window",
    "--url <url>               Navigate here before replaying recorded steps",
    "--timeout <ms>            Playwright action/navigation timeout (default: 30000)",
    "--viewport <width>x<height> (default: 1440x900)",
    "--slow-mo <ms>            Delay Playwright actions for observation",
    "--artifacts-dir <path>    Directory for display() images",
  ].join("\\n"));
  process.exit(0);
}

if (values.headless && values.headed) {
  throw new Error("Use only one of --headless and --headed.");
}
if (!(values.browser in browserChannels)) {
  throw new Error("Unsupported browser: " + values.browser);
}
if (values["executable-path"] && values.browser !== "chromium") {
  throw new Error("--executable-path is mutually exclusive with --browser channels.");
}
if (values["profile-directory"] && !values["user-data-dir"]) {
  throw new Error("--profile-directory requires --user-data-dir.");
}

const positiveInteger = (name: string, value: string, allowZero = false) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error("--" + name + " must be " + (allowZero ? "a non-negative" : "a positive") + " integer.");
  }
  return parsed;
};

const viewportParts = values.viewport.split("x");
if (viewportParts.length !== 2) {
  throw new Error("--viewport must look like 1440x900.");
}
const viewport = {
  width: positiveInteger("viewport width", viewportParts[0]),
  height: positiveInteger("viewport height", viewportParts[1]),
};
const timeout = positiveInteger("timeout", values.timeout);
const slowMo = positiveInteger("slow-mo", values["slow-mo"], true);
const channel = browserChannels[values.browser as keyof typeof browserChannels];

const launchOptions = {
  ...(channel ? { channel } : {}),
  ...(values["executable-path"]
    ? { executablePath: values["executable-path"] }
    : {}),
  headless: values.headed ? false : true,
  slowMo,
};
const context = values["user-data-dir"]
  ? await chromium.launchPersistentContext(values["user-data-dir"], {
      ...launchOptions,
      viewport,
      args: values["profile-directory"]
        ? ["--profile-directory=" + values["profile-directory"]]
        : [],
    })
  : await (await chromium.launch(launchOptions)).newContext({ viewport });
const browser = context.browser();
context.setDefaultTimeout(timeout);
context.setDefaultNavigationTimeout(timeout);
const page = await context.newPage();
const artifactsDir = path.resolve(values["artifacts-dir"]);
let displayCount = 0;

const display = (value: string | Uint8Array) => {
  mkdirSync(artifactsDir, { recursive: true });
  const dataUrl = typeof value === "string" && value.startsWith("data:image/")
    ? value.split(",", 2)[1]
    : undefined;
  const data = typeof value === "string"
    ? Buffer.from(dataUrl ?? value, "base64")
    : Buffer.from(value);
  const outputPath = path.join(
    artifactsDir,
    "display-" + String(++displayCount).padStart(3, "0") + ".png",
  );
  writeFileSync(outputPath, data);
  console.log("[replay] image: " + outputPath);
};

try {
  if (values.url) await page.goto(values.url, { waitUntil: "domcontentloaded" });
${stepBodies}
} finally {
  await context.close();
  await browser?.close();
}
`;
}
