import { homedir } from "node:os";
import path from "node:path";

export function getMaatAppiumHome(): string {
  return process.env.MAAT_APPIUM_HOME ?? path.join(homedir(), ".maat", "appium");
}

export function appiumEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APPIUM_HOME: getMaatAppiumHome(),
  };
}
