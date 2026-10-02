import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { appiumPlatforms, type AppiumPlatform } from "../appium/types.ts";
import { appiumEnvironment, getMaatAppiumHome } from "../appium/appium-home.ts";

const args = process.argv.slice(2);
const command = args[0] ?? "doctor";
const appiumEntry = fileURLToPath(
  new URL("../../node_modules/appium/index.js", import.meta.url),
);

const driverNames: Record<AppiumPlatform, string> = {
  android: "uiautomator2",
  ios: "xcuitest",
  macos: "mac2",
};

function run(commandArgs: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [appiumEntry, ...commandArgs], {
      env: appiumEnvironment(),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

try {
  if (command === "doctor") {
    console.log(`Maat Appium home: ${getMaatAppiumHome()}`);
    const platform = args[1] as AppiumPlatform | undefined;
    if (platform && !appiumPlatforms.includes(platform)) {
      throw new Error("Usage: maat appium doctor [android|ios|macos]");
    }
    process.exitCode = platform
      ? await run(["driver", "doctor", driverNames[platform]])
      : await run(["driver", "list", "--installed"]);
  } else if (command === "install") {
    const platform = args[1] as AppiumPlatform | undefined;
    if (!platform || !appiumPlatforms.includes(platform)) {
      throw new Error("Usage: maat appium install <android|ios|macos>");
    }
    process.exitCode = await run(["driver", "install", driverNames[platform]]);
  } else {
    throw new Error("Usage: maat appium [doctor|install <android|ios|macos>]");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
