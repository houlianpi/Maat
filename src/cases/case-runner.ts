import { access, readdir } from "node:fs/promises";
import path from "node:path";

export type CaseSelection =
  | { mode: "all" }
  | { mode: "case"; value: string }
  | { mode: "suite"; value: string }
  | { mode: "tag"; value: string };

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
