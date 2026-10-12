# Maat Setup Assistant

## Goal and responsibilities

The user asks to operate a device, not to manage automation infrastructure.
The host Coding Agent prepares what it can under authorization and asks the user
only for actions requiring them. Core returns reliable facts; the packaged
`maat-setup` Skill describes the Android and local physical-iPhone workflows.

- **Doctor:** inspect preparation and report missing conditions or failed checks.
- **Setup:** the host reuses tools/services and handles necessary installation,
  configuration or startup, tracking existing work instead of restarting it.
- **Ready:** check the actual current Android/iPhone Session/source/viewport and return
  observations, with screenshots when requested.

A ready channel is not an authenticated App or a successful business outcome.
There are no Case drafts, work modes, formal validation states or reports.

## User flow

1. Select the platform and intended device.
2. Diagnose the existing environment; do not reinstall or fully check it for every action.
3. The Agent handles the actual missing condition with its existing tools.
4. Wait for the user's actual USB authorization, unlock or authentication when needed.
5. Recheck the channel, reuse the new observation and continue the original task.

`/maat-setup` is the only user command; `/maat-setup ios` selects the iPhone flow.
The Agent calls `get_setup_diagnostics` for redacted technical details and
`retry_setup_step` to recheck; TUI widgets show platform/preparation state.
If startup is already running, query the same `prepare_mobile` taskId. A timeout is not permission
to start another service or replay a phone action.

## Pi-owned local preparation tasks

`prepare_mobile({action:"status"|"start-appium"|"build-ios-wda",taskId?,waitSeconds?,
signingAuthorized?})` is a narrow host capability shared by the Pi extension and
standalone TUI, not a generic shell/task scheduler. Start from the original task
or `/maat-setup`; healthy channels continue directly, with no extra generic gate.
`status` is read-only. `start-appium` preserves healthy user Appium, or starts one
owned foreground child using the resolved CLI (current Node on Windows) and
Android tool environment. The exact loopback endpoint is used without fallback
or stopping its port occupant. Spawn is not success: owned listener confirmation
and HTTP `/status` must pass. Content exposes taskId/state/summary/error/category,
never child PID, raw logs, signing identities or paths.

Wait 0–20 seconds and poll the same taskId; Appium startup has a 60-second overall
deadline, WDA work 180 seconds. `running` is not success; Appium `ready` means only
`serviceResponding`, not deviceReady. Process failures cannot be overridden by a
later HTTP response. The built-in Pi bash has no tracked-background API: no `nohup`,
`&`, or second terminal is required. Shutdown closes owned Sessions then attempts
bounded, idempotent owned-child-tree cleanup; user Appium is never stopped and
cleanup failures remain visible without replacing primary errors.
Reuse requires Appium's ready message and supported `value.build.version`, not
generic WebDriver `ready:true`; the owned listener must match the selected host/port.
POSIX children have owned process groups (retained handle/stdio, never unref);
root exit does not cancel TERM/KILL escalation. Windows residual cleanup that
cannot be proved is an explicit cleanup error. Abort retains the actual work
promise and gives it an independent three-second cleanup grace; late cleanup
failures or unsettled work are visible without replacing cancellation/timeout.

For iOS, `status` inspects WDA when no Appium startup task already exists;
`build-ios-wda` always inspects before deciding to reuse/build. Core supplies actual
profile dates/device match and independent certificate expiration. Paid/free builds
are treated equally, without assuming seven days. Valid builds reuse without signing
authorization; missing/expired builds require explicit authorization and preserve
the existing Team/bundle. No Team selection, App deletion, purchase or deployment
occurs in the build tool. Returned private capabilities are applied internally only
when the original adapter/device/hints still match. Ordinary connection initialization
reuses existing phone helpers by default. First WDA installation, re-signing and restart
still need separate explicit grants; combine necessary concrete effects/possible prompts
in one request, not internal flags or a confirmation for each command.

## iOS preparation, initialization and acceptance

Local Mac/physical-iPhone doctor inspects Xcode, Appium CLI, XCUITest, connection,
pairing, Developer Mode and Appium read-only. It does not verify WDA signing.
Pi command/retry/diagnostics remain iOS; no macOS Settings fallback, Android SDK
preparation or project-source environment repair applies.

Ordinary phone tasks automatically establish the necessary control connection.
After actual diagnosis, a current valid build and existing phone helper permit
`check_device_ready` with only the screenshot option, without a per-cold-Session
authorization gate. Core uses the exact selected device/server without root fallback
and checks actual WDA phone installation/signature before connecting; a valid local
build is not proof of phone installation. Ordinary readiness reuses existing helpers,
without Appium auto-signing or automatic first installation.
CoreDevice `passcodeRequired:false`/`unlockedSinceBoot:true` is not current unlock
proof, but is not an initialization approval gate. Known locks block; live WDA must
confirm unlocked boolean state after connection before source, screenshot or business
UI. `IOS_DEVICE_LOCK_STATE_UNKNOWN` means an actual live-lock read failure/missing
boolean: connection unconfirmed, not pending cold authorization. No business UI
until ready, no automatic unlock and no action replay. Budget: iOS 180s, Android 15s.

`IOS_WDA_INSTALLATION_AUTHORIZATION_REQUIRED` stops before POST without explicit
approval of first WDA control-component installation on the selected phone.
Explain necessary installation and possible prompts once, then handle the internal
`allowWdaInstallation:true` grant only after approval; never infer or auto-select it,
or give parameters to users as technical homework. It grants neither signing changes,
restart nor unlock. `IOS_WDA_SIGNING_REQUIRED` needs separately authorized signing,
never automatic renewal. `IOS_WDA_INSPECTION_FAILED` preserves actual installed/signature
inspection failure, not permission to reinstall. `IOS_CONNECTION_INITIALIZATION_DISABLED`
means a legacy caller opted into existingSession-only operation, not a model approval gate.
First installation, re-signing and restart remain separately authorized; combine
concrete effects in one request if several are needed. Trust, Developer Mode,
passwords and authentication remain user-only.

`IOS_WDA_CONFIGURATION_CONFLICT` reports mismatched signing hints or another
testRunner on the phone, avoiding Appium cleanup deletion. `IOS_READINESS_UNSUPPORTED`
reports configuration incompatible with safe reuse: `useNewWDA`,
`autoAcceptAlerts`/`autoDismissAlerts`, disabled prebuilt, forced preinstalled or
custom suffix. Report the explicit problem and inspect read-only; do not automatically
change configuration, reinstall, change Team, delete helpers or modify user services/
phone data. First-install approval does not bypass these checks or allow re-signing;
expired signing still requires separate approval.

Reuse user-managed Appium and device-bound WDA, preserving other services.
`IOS_DEVICE_LOCKED` needs user wake/unlock. `IOS_WDA_SECURITY_REJECTED` may mean
signing, entitlements or profile trust: check developer App trust once; if absent
or already trusted, inspect signing/profile expiry read-only. Renewal/deployment
and first installation need separate authorization; never request Apple credentials or blindly reinstall.
Keep the Session while waiting for user-only steps if more phone work remains;
release only when the conversation no longer needs phone interaction.

Acceptance is split: target-phone doctor preparation passed; Pi integration is
regression-tested; authorized signing renewal/deployment and XCTest initialization
produced actual iPhone UI observations and the Calculator result `3×3×8 = 72`.
Direct preinstalled launch remained rejected; the successful path reused the
verified build through `test-without-building`. Local 8100 was a different
simulator, not target-phone evidence. The scripted device check is not a
five-minute autonomous Pi/LLM first-use pass. Pi now has concrete tracked Appium
startup with controlled child/HTTP regression coverage; autonomous real-phone
first use remains a separate acceptance, not established by those tests.

## Android tool preparation

Users do not need SDK exports. Diagnosis dynamically resolves an existing SDK,
connection tools or Maat's managed cache. The Skill's `scripts/android-tools.mjs`
uses the host shell for explicit preparation of actual missing components.
The next diagnosis in the same Pi process sees the prepared cache, independent
of a child shell's environment changes.
An invalid or conflicting inherited SDK is reported, but does not block verified
alternative tools. Model-visible diagnosis includes status, error category and
the next preparation action, rather than treating failed checks as missing tools.
First-use `/maat-setup` defaults to Android and respects explicit platform choices.

Official platform-tools downloads require actual SDK license acceptance. Reuse
existing ADB first; prepare native AAPT2 without Android Studio, a full SDK or a
JDK. Do not change global configuration.

`prepare_mobile(start-appium)` passes the resolved tool environment only to its new
Appium child. The script remains available for manual foreground diagnosis.
Existing services are neither reconfigured nor restarted. A mismatch
must remain visible and be handled by that service's owner.

## macOS capability checks

Selecting macOS checks Appium, Mac2, automation/Accessibility permissions and optional
screen capture/video capabilities. The detector may create a temporary Mac2 Session
and read the source/screenshots; it is not merely a dependency-only check and does
not execute a business click.

After confirmation, Maat can open the appropriate System Settings page. The user
grants permission and rechecks. Process fingerprints invalidate outdated skip
choices and detect when a permission change requires restarting the current
service. Maat does not restart external services itself.

Unavailable or skipped optional capabilities remain visible; they are not reported
as captured observations. Agent decisions depend on the capabilities the task
actually needs. A screenshot-dependent task cannot proceed on a made-up image.

## Feedback and safety

Show the concrete situation and one next step, not a generic permission checklist.
Keep raw paths, process details and technical logs in redacted diagnostics. Core
returns stable message keys; Pi chooses English/Chinese from the user or an override.

Do not ask for passwords or codes. Preserve unrelated processes, configuration,
App data and login. Recovery must not replay potentially executed inputs or
submissions. Screenshots and UI text are observations, not a formal Evidence report.
