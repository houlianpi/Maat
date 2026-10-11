# Maat Setup Assistant

## Goal and responsibilities

The user asks to operate a device, not to manage automation infrastructure.
The host Coding Agent prepares what it can under authorization and asks the user
only for actions requiring them. Core returns reliable facts; the packaged
`maat-setup` Skill describes the Android workflow.

- **Doctor:** inspect preparation and report missing conditions or failed checks.
- **Setup:** the host reuses tools/services and handles necessary installation,
  configuration or startup, tracking existing work instead of restarting it.
- **Ready:** check the actual current Android Session/source/viewport and return
  observations, with screenshots when requested.

A ready channel is not an authenticated App or a successful business outcome.
There are no Case drafts, work modes, formal validation states or reports.

## User flow

1. Select the platform and intended device.
2. Diagnose the existing environment; do not reinstall or fully check it for every action.
3. The Agent handles the actual missing condition with its existing tools.
4. Wait for the user's actual USB authorization, unlock or authentication when needed.
5. Recheck the channel, reuse the new observation and continue the original task.

`/maat-setup` on Android hands this flow to the host. `/maat-doctor` returns
redacted technical details; `/maat-status` shows platform and preparation state.
If startup is already running, query the same host task. A timeout is not permission
to start another service or replay a phone action.

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

The same script passes the resolved tool environment only to a new Appium child
process. Existing services are neither reconfigured nor restarted. A mismatch
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
