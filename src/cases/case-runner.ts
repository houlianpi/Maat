import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BrowserName } from "../browser/browser-options.ts";

export type CaseSelection =
  | { mode: "all" }
  | { mode: "case"; value: string }
  | { mode: "suite"; value: string }
  | { mode: "tag"; value: string };

export type CaseRunOptions = {
  rootDirectory: string;
  selection: CaseSelection;
  browser?: BrowserName;
  headed?: boolean;
  ui?: boolean;
  workers?: number;
};

export async function findSpecs(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return findSpecs(entryPath);
      return entry.isFile() && entry.name.endsWith(".spec.ts")
        ? [entryPath]
        : [];
    }),
  );
  return nested.flat();
}

export async function resolveCaseSpec(
  root: string,
  value: string,
): Promise<string> {
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/\.spec\.ts$/, "")
    .replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((part) => part === "..")) {
    throw new Error(`Invalid Case selector: ${value}`);
  }

  const casesDirectory = path.join(root, "cases");
  if (normalized.includes("/")) {
    const direct = path.join(
      casesDirectory,
      ...normalized.split("/"),
    ) + ".spec.ts";
    await access(direct);
    return direct;
  }

  const matches = (await findSpecs(casesDirectory)).filter(
    (file) => path.basename(file) === `${normalized}.spec.ts`,
  );
  if (matches.length === 0) throw new Error(`Unknown Case: ${value}`);
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous Case "${value}". Use a module path:\n${matches
        .map((file) => `- ${path.relative(casesDirectory, file).replace(/\.spec\.ts$/, "")}`)
        .join("\n")}`,
    );
  }
  return matches[0]!;
}

export async function buildPlaywrightArgs(
  root: string,
  options: Omit<CaseRunOptions, "rootDirectory">,
): Promise<string[]> {
  const args = [
    "test",
    "--config",
    path.join(root, "playwright.config.ts"),
    `--project=${options.browser ?? "chrome"}`,
    ...(options.headed ? ["--headed"] : []),
    ...(options.ui ? ["--ui"] : []),
    ...(options.workers ? ["--workers", String(options.workers)] : []),
  ];

  switch (options.selection.mode) {
    case "case": {
      args.push(await resolveCaseSpec(root, options.selection.value));
      break;
    }
    case "suite":
      args.push("--grep", `@suite:${options.selection.value}`);
      break;
    case "tag":
      args.push("--grep", `@${options.selection.value}`);
      break;
    case "all":
      break;
  }

  return args;
}

export async function runCases(options: CaseRunOptions): Promise<number> {
  const root = path.resolve(options.rootDirectory);
  const playwrightCli = fileURLToPath(
    new URL("../../node_modules/playwright/cli.js", import.meta.url),
  );
  const args = await buildPlaywrightArgs(root, options);
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCli, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolve(code ?? (signal ? 1 : 0)),
    );
  });
}
