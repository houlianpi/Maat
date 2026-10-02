import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { BrowserName } from "../browser/browser-options.ts";
import type { BrowserProfile } from "../browser/browser-manager.ts";
import type { SavedCase } from "./types.ts";

const execFileAsync = promisify(execFile);

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
};

type CuaConfig = { profiles?: Record<string, BrowserProfile> };
type SuiteFile = { cases: string[] };

async function loadCase(root: string, id: string): Promise<SavedCase> {
  return JSON.parse(
    await readFile(path.join(root, "cases", id, "case.json"), "utf8"),
  ) as SavedCase;
}

async function selectCases(
  root: string,
  selection: CaseSelection,
): Promise<SavedCase[]> {
  if (selection.mode === "case") return [await loadCase(root, selection.value)];
  if (selection.mode === "suite") {
    const suite = JSON.parse(
      await readFile(
        path.join(root, "suites", `${selection.value}.json`),
        "utf8",
      ),
    ) as SuiteFile;
    return Promise.all(suite.cases.map((id) => loadCase(root, id)));
  }

  const entries = await readdir(path.join(root, "cases"), {
    withFileTypes: true,
  });
  const cases = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map((entry) => loadCase(root, entry.name)),
  );
  return selection.mode === "tag"
    ? cases.filter((item) => item.tags.includes(selection.value))
    : cases;
}

async function loadConfig(root: string): Promise<CuaConfig> {
  try {
    return JSON.parse(
      await readFile(path.join(root, "cua.config.json"), "utf8"),
    ) as CuaConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function runCases(options: CaseRunOptions): Promise<number> {
  const root = path.resolve(options.rootDirectory);
  const [cases, config] = await Promise.all([
    selectCases(root, options.selection),
    loadConfig(root),
  ]);
  if (cases.length === 0) throw new Error("No Cases matched the selection.");

  let failures = 0;
  for (const item of cases) {
    const profile = item.profile ? config.profiles?.[item.profile] : undefined;
    if (item.profile && !profile) {
      console.error(`FAIL ${item.id}: unknown profile ${item.profile}`);
      failures += 1;
      continue;
    }
    const browser = options.browser ?? profile?.browser ?? item.browser;
    const args = [
      "--experimental-strip-types",
      path.join(root, "cases", item.id, item.code),
      "--browser",
      browser,
      options.headed ? "--headed" : "--headless",
      ...(profile
        ? [
            "--user-data-dir",
            profile.userDataDir,
            ...(profile.profileDirectory
              ? ["--profile-directory", profile.profileDirectory]
              : []),
          ]
        : []),
    ];

    try {
      const { stdout } = await execFileAsync(process.execPath, args, {
        cwd: process.cwd(),
        timeout: 120_000,
      });
      console.log(`PASS ${item.id}`);
      if (stdout.trim()) console.log(stdout.trim());
    } catch (error) {
      failures += 1;
      const failure = error as Error & { stderr?: string };
      console.error(`FAIL ${item.id}: ${failure.stderr?.trim() || failure.message}`);
    }
  }

  console.log(`\nCases: ${cases.length}, passed: ${cases.length - failures}, failed: ${failures}`);
  return failures === 0 ? 0 : 1;
}
