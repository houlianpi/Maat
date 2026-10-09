---
name: maat-case-builder
description: Explore a real UI with Maat and turn the user's explicit test objective into a minimal executable Case that validates in a fresh Session.
---

# Build a Maat Case

Build through Maat tools; do not hand-edit generated source unless the user explicitly asks.
The complete workflow is in this loaded file. Do not browse or open this `SKILL.md`, enumerate unrelated tools, or use another UI automation tool to rediscover these instructions.

1. Extract the platform, Case identity, business actions, and explicit expected outcomes. Ask only when a missing choice materially changes the test.
2. Select the platform. If setup is not ready, use `$maat-setup` before exploration.
3. Call `maat_begin_case` before recording formal steps. Preserve the user's description, preconditions, actions, objectives, tags, and suites.
4. Call `maat_get_execution_context`, then explore with `maat_execute_javascript`. The Session persists.
5. Use Playwright for Web and WebdriverIO for Appium platforms. Use only the returned globals.
6. Set `record=true` with a concise `stepName` only for minimal reusable business code. Never record page-source dumps, setup diagnostics, or failed experiments.
7. Generate assertions only for outcomes stated by the user. Do not add redundant assertions for operational prerequisites.
8. Capture screenshot Evidence when it supports the objective or the Case requires it.
9. Call `maat_list_case_steps`; remove or replace diagnostic, duplicated, or unstable steps.
10. Call `maat_save_case`. If fresh validation fails, preserve the expected outcome, fix the steps, and retry.
11. When rerunning a native Case whose saved App target is runtime-bound, pass the verified App package or bundle identifier as `appId`. Do not first run it without that required value.

Read [references/case-quality.md](references/case-quality.md) when deciding what belongs in the Case.
