import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { appiumEnvironment } from "./appium-home.ts";

export type AppiumServerHandle = {
  url: string;
  close(): Promise<void>;
};

export async function launchAppiumServer(
  port = 4723,
): Promise<AppiumServerHandle> {
  const entry = fileURLToPath(
    new URL("../../node_modules/appium/index.js", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [entry, "--address", "127.0.0.1", "--port", String(port), "--base-path", "/"],
    {
      env: appiumEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8_000);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8_000);
  });
  const url = `http://127.0.0.1:${port}/`;

  try {
    await waitForServer(url, child, () => output);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  return {
    url,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 2_000),
        ),
      ]);
    },
  };
}

async function waitForServer(
  url: string,
  child: ChildProcess,
  readOutput: () => string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Appium server exited during startup. ${readOutput()}`.trim());
    }
    try {
      const response = await fetch(new URL("status", url), {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Server is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Appium server did not become ready. ${readOutput()}`.trim());
}
