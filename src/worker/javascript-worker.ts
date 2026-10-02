import { formatWithOptions } from "node:util";
import vm from "node:vm";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { expect as playwrightExpect } from "playwright/test";

import {
  isRecord,
  maxCodeBytes,
  maxOutputBytes,
  type JavaScriptObservation,
  type WorkerRequest,
} from "./protocol.ts";

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
let repl: vm.Context | undefined;
let observations: JavaScriptObservation[] = [];
let outputBytes = 0;
let busy = false;
let closing = false;

function appendObservation(observation: JavaScriptObservation): void {
  outputBytes += Buffer.byteLength(JSON.stringify(observation));
  if (outputBytes > maxOutputBytes) {
    throw new Error("JavaScript output exceeds 12 MiB.");
  }
  observations.push(observation);
}

function display(value: string | Uint8Array): void {
  if (typeof value !== "string") {
    appendObservation({
      type: "image",
      data: Buffer.from(value).toString("base64"),
      mimeType: "image/png",
    });
    return;
  }

  const dataUrl = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(value);
  appendObservation(
    dataUrl
      ? { type: "image", mimeType: dataUrl[1], data: dataUrl[2] }
      : { type: "image", data: value, mimeType: "image/png" },
  );
}

function createRepl(assertionTimeoutMs: number): vm.Context {
  return vm.createContext({
    browser,
    context,
    page,
    expect: playwrightExpect.configure({ timeout: assertionTimeoutMs }),
    Buffer,
    console: {
      log: (...values: unknown[]) => {
        appendObservation({
          type: "text",
          text: formatWithOptions(
            { getters: false, maxStringLength: 2_000, showHidden: false },
            ...values,
          ),
        });
      },
    },
    display,
  });
}

async function initialize(
  browserOptions: Extract<WorkerRequest, { operation: "initialize" }>["browser"],
  assertionTimeoutMs: number,
): Promise<{ currentUrl: string }> {
  if (
    browser ||
    !Number.isSafeInteger(assertionTimeoutMs) ||
    assertionTimeoutMs <= 0
  ) {
    throw new Error("Invalid worker initialization.");
  }

  if (browserOptions.mode === "persistent") {
    context = await chromium.launchPersistentContext(
      browserOptions.userDataDir,
      {
        channel: browserOptions.channel,
        executablePath: browserOptions.executablePath,
        headless: browserOptions.headless,
        viewport: { width: 1440, height: 900 },
        args: browserOptions.profileDirectory
          ? [`--profile-directory=${browserOptions.profileDirectory}`]
          : [],
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      },
    );
    browser = context.browser() ?? undefined;
  } else {
    browser = await chromium.connect(browserOptions.endpoint, { timeout: 15_000 });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  }
  context.setDefaultTimeout(10_000);
  context.setDefaultNavigationTimeout(15_000);
  page = context.pages()[0] ?? (await context.newPage());
  repl = createRepl(assertionTimeoutMs);
  return { currentUrl: page.url() };
}

async function execute(code: string): Promise<JavaScriptObservation[]> {
  if (!repl || !page) throw new Error("JavaScript worker is not initialized.");
  if (!code.trim() || Buffer.byteLength(code) > maxCodeBytes) {
    throw new Error("JavaScript code must be nonempty and at most 64 KiB.");
  }

  observations = [];
  outputBytes = 0;
  const returnValue = await new vm.Script(`(async () => {\n${code}\n})()`, {
    filename: "exec-js.js",
  }).runInContext(repl);

  if (observations.length === 0 && returnValue !== undefined) {
    appendObservation({
      type: "text",
      text: formatWithOptions(
        { getters: false, maxStringLength: 2_000, showHidden: false },
        returnValue,
      ),
    });
  }
  if (observations.length === 0) {
    appendObservation({ type: "text", text: "exec_js completed with no output." });
  }
  return observations;
}

async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.operation) {
    case "initialize":
      return initialize(request.browser, request.assertionTimeoutMs);
    case "execute":
      return execute(request.code);
    case "close":
      await close();
      return undefined;
  }
}

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await context?.close();
    await browser?.close();
  } finally {
    process.exit(0);
  }
}

process.on("disconnect", () => void close());
process.on("message", (message: unknown) => {
  if (closing) return;
  if (!isRecord(message) || !Number.isSafeInteger(message.id) || busy) {
    process.send?.({
      id: isRecord(message) && typeof message.id === "number" ? message.id : -1,
      error: "Invalid or concurrent worker request.",
    });
    return;
  }

  busy = true;
  void handle(message as WorkerRequest)
    .then(
      (result) => process.send?.({ id: message.id, result }),
      (error: unknown) =>
        process.send?.({
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        }),
    )
    .finally(() => {
      busy = false;
    });
});
