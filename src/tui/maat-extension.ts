import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";

import type { BrowserManager } from "../browser/browser-manager.ts";
import type { CaseManager } from "../cases/case-manager.ts";
import type { AppiumManager } from "../appium/appium-manager.ts";

export function maatStatusLines(
  browserManager: BrowserManager,
  caseManager: CaseManager,
  appiumManager?: AppiumManager,
): string[] {
  const browser = browserManager.currentConfig;
  const draft = caseManager.current;
  const browserLine = [
    `Browser  ${browser.browser}`,
    browser.headless ? "headless" : "headed",
    browser.profile ? `profile: ${browser.profile}` : "temporary profile",
    browserManager.isRunning ? "running" : "idle",
  ].join(" · " );
  const caseLine = draft
    ? `Case     ${draft.id} · ${draft.steps.length} steps · ${draft.failures.length} failed attempts`
    : "Case     no active Case";
  const evidenceLine = draft
    ? `Evidence ${draft.evidence.length} items · ${draft.objectives.length} objectives`
    : "Evidence 0 items";
  const appium = appiumManager?.currentConfig;
  const appiumLine = appium
    ? `Appium   ${appium.platform} · ${String(appium.capabilities["appium:automationName"] ?? "default")} · ${appiumManager.isRunning ? "running" : "idle"}`
    : "Appium   not configured";
  return [browserLine, appiumLine, caseLine, evidenceLine];
}

export function createMaatExtension(
  browserManager: BrowserManager,
  caseManager: CaseManager,
  appiumManager?: AppiumManager,
): InlineExtension {
  const factory = (pi: ExtensionAPI) => {
    const applyUi = (ctx: ExtensionContext) => {
      if (ctx.mode !== "tui") return;
      ctx.ui.setTitle("Maat");
      setTimeout(() => ctx.ui.setTitle("Maat"), 0);
      ctx.ui.setHeader((_tui, theme) => ({
        render(_width: number) {
          const title = theme.bold(theme.fg("accent", "Maat"));
          const subtitle = theme.fg(
            "muted",
            "Conversational UI verification · intent → evidence → executable truth",
          );
          return ["", `  ${title}`, `  ${subtitle}`];
        },
        invalidate() {},
      }));
      ctx.ui.setWidget(
        "maat-status",
        maatStatusLines(browserManager, caseManager, appiumManager),
        { placement: "aboveEditor" },
      );
    };

    pi.on("session_start", async (_event, ctx) => applyUi(ctx));
    pi.on("tool_execution_end", async (_event, ctx) => applyUi(ctx));
  };

  return {
    name: "maat-ui",
    hidden: true,
    factory,
  };
}
