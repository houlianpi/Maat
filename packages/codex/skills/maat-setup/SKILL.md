---
name: maat-setup
description: Prepare or diagnose Maat Web, Android, iOS, or macOS UI testing when a platform, browser, Appium Session, device, driver, or system capability is not ready.
---

# Prepare Maat

Use Maat tools to reach an evidence-backed setup state without replacing the user's infrastructure.
The workflow is already loaded. Do not browse or open this `SKILL.md` to rediscover it.

1. Call `maat_list_platforms`, select the requested platform, then call `maat_check_setup`.
2. Present the human-relevant state and one recommended next action. Keep technical details in `maat_get_setup_diagnostics` unless requested.
3. Use `maat_open_setup_step` only to obtain the supported Settings URL or command. Do not claim it grants permissions, installs drivers, starts Appium, or changes system settings.
4. When device trust, signing, authentication, permissions, or unlocking needs the user, explain the exact action and wait for confirmation. Then call `maat_retry_setup_step`.
5. Skip an optional capability only after explicit user choice through `maat_continue_without_capability`.
6. Prefer an existing reachable Appium Server, driver, device, and application. Maat creates and deletes only its own Sessions.
7. Finish with Ready, Partially ready, or Blocked, including the verified reason.

For platform-specific decisions, read [references/platforms.md](references/platforms.md).
