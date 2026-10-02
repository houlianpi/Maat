import assert from "node:assert/strict";
import test from "node:test";

import { AppiumManager } from "../src/appium/appium-manager.ts";
import { launchAppiumServer } from "../src/appium/appium-server.ts";
import { AppiumClient } from "../src/appium/appium-client.ts";
import { appiumEnvironment, getMaatAppiumHome } from "../src/appium/appium-home.ts";
import { CaseManager } from "../src/cases/case-manager.ts";
import { BrowserManager } from "../src/browser/browser-manager.ts";
import { maatStatusLines } from "../src/tui/maat-extension.ts";
import { createAppiumTools } from "../src/appium/appium-tools.ts";

test("Appium Manager merges platform defaults with user capabilities", async () => {
  const manager = new AppiumManager();
  const config = await manager.configure({
    platform: "android",
    serverUrl: "http://127.0.0.1:9999/",
    capabilities: {
      "appium:deviceName": "Pixel_9",
      "appium:appPackage": "com.example",
    },
  });

  assert.equal(config.capabilities["appium:automationName"], "UiAutomator2");
  assert.equal(config.capabilities["appium:deviceName"], "Pixel_9");
  assert.equal(config.capabilities["appium:appPackage"], "com.example");
});

test("Maat status includes Appium platform and driver", () => {
  const appium = new AppiumManager();
  const lines = maatStatusLines(new BrowserManager(), new CaseManager(), appium);
  assert.match(lines[1]!, /Appium   macos · Mac2 · idle/);
});

test("Maat can start and stop its bundled Appium server", async () => {
  const handle = await launchAppiumServer(4739);
  try {
    const status = await new AppiumClient(handle.url).status();
    assert.ok(status);
  } finally {
    await handle.close();
  }
});

test("Maat registers structured Appium tools without arbitrary script execution", () => {
  const tools = createAppiumTools(new AppiumManager(), new CaseManager());
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "configure_appium",
      "start_appium_session",
      "appium_find",
      "appium_action",
      "get_appium_source",
      "capture_appium_screenshot",
      "stop_appium_session",
    ],
  );
  assert.equal(tools.some((tool) => tool.name === "exec_appium"), false);
});

test("Maat isolates Appium extensions in its own home", () => {
  const previous = process.env.MAAT_APPIUM_HOME;
  process.env.MAAT_APPIUM_HOME = "/tmp/maat-appium-test";
  try {
    assert.equal(getMaatAppiumHome(), "/tmp/maat-appium-test");
    assert.equal(appiumEnvironment().APPIUM_HOME, "/tmp/maat-appium-test");
  } finally {
    if (previous === undefined) delete process.env.MAAT_APPIUM_HOME;
    else process.env.MAAT_APPIUM_HOME = previous;
  }
});
