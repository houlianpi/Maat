import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import type { CaseManager } from "../cases/case-manager.ts";
import type { AppiumManager } from "./appium-manager.ts";
import { appiumPlatforms } from "./types.ts";

const strategies = [
  "accessibility id",
  "id",
  "xpath",
  "class name",
  "name",
  "-android uiautomator",
  "-ios predicate string",
  "-ios class chain",
] as const;

export function createAppiumTools(
  manager: AppiumManager,
  caseManager: CaseManager,
) {
  const configure = defineTool({
    name: "configure_appium",
    label: "Configure Appium",
    description:
      "Configure an Android, iOS, or macOS Appium target. Capabilities use W3C/Appium names such as appium:app, appium:bundleId, appium:appPackage, appium:appActivity, appium:udid, or appium:deviceName.",
    parameters: Type.Object({
      platform: Type.Union(appiumPlatforms.map((item) => Type.Literal(item))),
      serverUrl: Type.Optional(
        Type.String({ description: "External Appium server URL; omit to start Maat's local server" }),
      ),
      capabilities: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    execute: async (_id, params) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            await manager.configure({
              platform: params.platform,
              serverUrl: params.serverUrl,
              capabilities: params.capabilities,
            }),
          ),
        },
      ],
      details: {},
    }),
  });

  const start = defineTool({
    name: "start_appium_session",
    label: "Start Appium Session",
    description:
      "Start the configured Appium session. Android requires UiAutomator2 and a device/emulator; iOS requires XCUITest and a device/simulator; macOS requires Mac2 and Automation Mode authorization.",
    parameters: Type.Object({}),
    execute: async () => {
      const session = await manager.start();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(session) }],
        details: session,
      };
    },
  });

  const find = defineTool({
    name: "appium_find",
    label: "Find Appium Element",
    description:
      "Find one native UI element and return its opaque element id. Prefer accessibility id, id, iOS predicate/class chain, or Android UiAutomator over XPath.",
    parameters: Type.Object({
      using: Type.Union(strategies.map((item) => Type.Literal(item))),
      value: Type.String(),
    }),
    execute: async (_id, params) => {
      const elementId = await manager.find(params.using, params.value);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ elementId }) }],
        details: { elementId },
      };
    },
  });

  const action = defineTool({
    name: "appium_action",
    label: "Appium Action",
    description:
      "Perform a structured action against an Appium element id or screen coordinate.",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("click"), elementId: Type.String() }),
      Type.Object({ action: Type.Literal("clear"), elementId: Type.String() }),
      Type.Object({
        action: Type.Literal("setValue"),
        elementId: Type.String(),
        text: Type.String(),
      }),
      Type.Object({ action: Type.Literal("getText"), elementId: Type.String() }),
      Type.Object({
        action: Type.Literal("getAttribute"),
        elementId: Type.String(),
        name: Type.String(),
      }),
      Type.Object({ action: Type.Literal("isDisplayed"), elementId: Type.String() }),
      Type.Object({
        action: Type.Literal("tap"),
        x: Type.Number(),
        y: Type.Number(),
      }),
    ]),
    execute: async (_id, params) => {
      let result: unknown = null;
      switch (params.action) {
        case "click":
          await manager.click(params.elementId);
          break;
        case "clear":
          await manager.clear(params.elementId);
          break;
        case "setValue":
          await manager.setValue(params.elementId, params.text);
          break;
        case "getText":
          result = await manager.getText(params.elementId);
          break;
        case "getAttribute":
          result = await manager.getAttribute(params.elementId, params.name);
          break;
        case "isDisplayed":
          result = await manager.isDisplayed(params.elementId);
          break;
        case "tap":
          await manager.tap(params.x, params.y);
          break;
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ result }) }],
        details: { result },
      };
    },
  });

  const source = defineTool({
    name: "get_appium_source",
    label: "Get Appium Source",
    description: "Return the current native accessibility/XML page source.",
    parameters: Type.Object({}),
    execute: async () => {
      const value = await manager.source();
      return {
        content: [{ type: "text" as const, text: value }],
        details: { length: value.length },
      };
    },
  });

  const screenshot = defineTool({
    name: "capture_appium_screenshot",
    label: "Capture Appium Screenshot",
    description: "Capture the current native UI screenshot as Evidence.",
    parameters: Type.Object({}),
    execute: async () => {
      const data = await manager.screenshot();
      if (caseManager.current) {
        await caseManager.recordEvidence([
          { type: "image", data, mimeType: "image/png" },
        ]);
      }
      return {
        content: [{ type: "image" as const, data, mimeType: "image/png" }],
        details: {},
      };
    },
  });

  const stop = defineTool({
    name: "stop_appium_session",
    label: "Stop Appium Session",
    description: "Stop the active Appium session and Maat-owned server.",
    parameters: Type.Object({}),
    execute: async () => {
      await manager.close();
      return {
        content: [{ type: "text" as const, text: "Appium session stopped." }],
        details: {},
      };
    },
  });

  return [configure, start, find, action, source, screenshot, stop];
}
