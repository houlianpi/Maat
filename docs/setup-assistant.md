# Maat Setup Assistant

## Product goal

Users should be able to say “test a macOS app” without knowing Appium, Mac2, XCTest, WDA, TCC, or process paths. Maat checks capabilities, explains what already works, presents one next action, and resumes the current Case after the user finishes macOS authorization.

## User journey

1. Selecting macOS triggers a read-only setup check.
2. Maat reports `ready`, `partially-ready`, or `blocked` in plain language.
3. `/maat-setup` presents one recommended action and may open the relevant System Settings page after confirmation.
4. The user grants permission and runs `/maat-setup` again.
5. If the same Appium/WDA processes still hold stale permission state, Maat recommends restarting Appium instead of reopening Settings.
6. The active Case draft and successful steps remain intact; Maat resumes from the interruption.

Restart Appium only when recheck reports `MACOS_SCREEN_CAPTURE_RESTART_REQUIRED`. Restart Pi only if the newly published extension itself was installed or updated; changing Screen Recording permission alone does not normally require it. Maat never performs either restart automatically.

## State machine

```text
unknown → checking → action-required → waiting-for-recheck
                                  ↘ partially-ready → ready
```

Capabilities include Appium, Mac2, Automation Mode, Accessibility, UI interaction, screen capture, video recording, and Full Disk Access. Process fingerprints invalidate skipped capability choices after Appium/WDA restarts.

## Copy guidelines

The default panel shows capabilities and one next action. It does not mention WDA, TCC, capabilities, raw WebDriver errors, or paths. `/maat-doctor` exposes redacted technical details, commands, PIDs, and paths for engineers. Prompt/page text, image payloads, tokens, credentials, and screenshots are omitted or redacted.

## Degraded operation

UI interaction and business assertions may continue when optional screenshot/video capabilities are unavailable. Evidence records one of:

- `captured`
- `unavailable`
- `required-but-missing`
- `skipped-by-user`

Cases that explicitly require screenshot Evidence cannot skip screen capture and fail validation when no screenshot is captured. Optional screenshot failure never changes a successful business assertion into a failure.

## Error codes

- `APPIUM_SERVER_UNAVAILABLE`
- `MAC2_DRIVER_MISSING`
- `AUTOMATION_MODE_AUTH_REQUIRED`
- `MACOS_ACCESSIBILITY_PERMISSION_REQUIRED`
- `MACOS_SCREEN_CAPTURE_PERMISSION_REQUIRED`
- `MACOS_SCREEN_CAPTURE_RESTART_REQUIRED`
- `MACOS_FULL_DISK_ACCESS_REQUIRED`
- `FFMPEG_MISSING`

## Safety boundary

Setup checks are read-only. Maat may open System Settings but never grants permissions, runs `tccutil reset`, kills processes, restarts services, installs software, or changes security settings without explicit user confirmation.

## Host integration

Host packages call the `maat-core` Setup API and render the same `SetupSnapshot`. Hosts own dialogs, buttons, notifications, and OS-opening actions. Core never imports a Host SDK. Future Codex, Claude Code, and DeepSeek hosts should preserve the same state, capability, action, and safety contracts.
