import assert from "node:assert/strict";
import test from "node:test";

import { BrowserManager } from "../src/browser/browser-manager.ts";
import { CaseManager } from "../src/cases/case-manager.ts";
import { maatStatusLines } from "../src/tui/maat-extension.ts";
import {
  createMaatResourceOptions,
  createMaatSettings,
} from "../src/tui/maat-runtime-config.ts";

test("Maat isolates Pi resources while copying initial model preferences", () => {
  const settings = createMaatSettings({
    defaultProvider: "github-copilot",
    defaultModel: "gpt-test",
    defaultThinkingLevel: "medium",
    theme: "dark",
    extensions: ["foreign-extension"],
    skills: ["foreign-skill"],
  });
  const resources = createMaatResourceOptions([]);

  assert.equal(settings.defaultProvider, "github-copilot");
  assert.equal(settings.defaultModel, "gpt-test");
  assert.deepEqual(settings.extensions, []);
  assert.deepEqual(settings.skills, []);
  assert.equal(settings.enableInstallTelemetry, false);
  assert.equal(resources.noExtensions, true);
  assert.equal(resources.noSkills, true);
  assert.equal(resources.noContextFiles, true);
  assert.equal(resources.noPromptTemplates, true);
});

test("Maat status lines show browser, Case, and Evidence state", () => {
  const browserManager = new BrowserManager();
  const caseManager = new CaseManager();
  caseManager.begin({
    id: "login-case",
    name: "Login Case",
    description: "Verify login",
    objectives: ["Dashboard is visible"],
  });

  const lines = maatStatusLines(browserManager, caseManager);
  assert.match(lines[0]!, /Browser  chrome · headless/);
  assert.match(lines[1]!, /Appium   not configured/);
  assert.match(lines[2]!, /Case     login-case · 0 steps/);
  assert.match(lines[3]!, /Evidence 0 items · 1 objectives/);
});
