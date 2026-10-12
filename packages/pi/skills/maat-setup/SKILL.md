---
name: maat-setup
description: 'Prepare or recover a local Android phone or physical iPhone for Maat Mobile Use in Pi using existing host tools, read-only diagnosis and explicit user authorization.'
---

# Prepare the phone, then continue the user's task

Maat is a device execution capability of the host Coding Agent. Use `prepare_mobile`
for tracked Appium startup and iOS WDA builds, and the host's existing shell/file
tools for other authorized missing dependencies. Do not
create another agent or generate an ad-hoc phone client.
For a physical iPhone, follow the iOS section below, not the Android tool steps.
The Android workflow targets a local phone with Appium and UiAutomator2:
Pi, Appium and the ADB connection must be on the same computer. Preparing a new
remote Appium connection is outside this workflow.
Host tools remain available under the host's own permission controls.

## One Android/iOS entry, concrete tracked work

Start from the natural phone task or `/maat-setup [android|ios]`, not another
generic permission or "start preparation" gate. If the existing channel is healthy,
continue directly. Ordinary missing-component preparation inside the approved
scope is automatic; combine only the necessary first-control, signing/deployment
and possible-screen-wake explanation into one confirmation when needed. Internal
authorization flags are implementation details, not questions for the user.

`prepare_mobile` has only `status`, `start-appium`, and `build-ios-wda` actions:

- `status` with `taskId:null` (or omitted) reads the exact selected local endpoint and (on iOS,
  with no existing Appium task) WDA signing facts. It never installs, starts,
  builds, deploys or creates a phone Session.
- `start-appium` preserves healthy user services without owning them. Otherwise
  Pi starts one foreground child at the exact loopback endpoint, with the resolved
  Android environment when applicable. No untracked daemon/shell, port-process killing or
  endpoint fallback. An occupied unhealthy endpoint is a visible failure.
- `build-ios-wda` inspects/reuses valid builds without rebuilding; missing/expired
  builds require actual signing authorization (`signingAuthorized:true`). This
  task only builds and applies private reuse hints, not deployment or phone control.

Each returns content containing `taskId`, `state`, `summary`, and failure category/
error when relevant. States are `running|ready|completed|failed|cancelled`.
`taskId:null` is the documented tool transport value for “no existing task”,
including providers that send every field. Use it for current inspection and
new startup/build work. For polling, use only the actual taskId returned by this
tool with `action:"status"`; never invent `current`, `new`, `reuse-wda`, or an empty
string. Invalid/unknown taskIds remain errors. These are internal tool arguments,
not additional user approval questions.

```json
{"action":"status","taskId":null,"waitSeconds":0,"signingAuthorized":false}
{"action":"start-appium","taskId":null,"waitSeconds":20,"signingAuthorized":false}
```

Wait at most 20 seconds using `waitSeconds`; query the same taskId with `status`.
A timed-out wait leaves work running, never starts it again. Appium has a 60-second
overall startup deadline; WDA work has a 180-second deadline. Process failures
remain failed even if an unrelated service later responds.
`ready` means **serviceResponding only**, not deviceReady or business success.
Continue with the authorized `check_device_ready` and its actual observation.

Pi 0.87's built-in bash has no tracked-background API. Never work around this with
`nohup`, `&`, or an instruction to open another terminal. Extension/standalone TUI
shutdown closes owned Sessions first and stops only its own service children,
bounded and idempotent, with cleanup failures visible. Existing user services stay.
POSIX children have an owned process group with retained handle/stdio; even root
exit does not cancel TERM/KILL of that group. This is not a detached/unreferenced
daemon. Windows tree cleanup that cannot be confirmed is an explicit cleanup error.
After cancelling startup/build, Pi retains the real work promise and waits an
independent three-second cleanup grace; failure or unsettled cleanup stays visible.
Appium reuse requires its ready message and supported build version, not just
generic WebDriver `ready:true`. Owned listener confirmation must match the selected
host/port as well as passing the exact endpoint's HTTP check.
The original task and continuation stay in the host conversation; no new planner.

## iOS: local physical iPhone

Use `/maat-setup ios` or `select_platform` with `ios`. Select the intended physical
iPhone explicitly; do not substitute a simulator or a different device.
`check_platform_setup`, `retry_setup_step` and `get_setup_diagnostics` inspect
Xcode, Appium CLI, XCUITest, device connection/pairing, Developer Mode and the
selected Appium endpoint. They are preparation checks, not WDA signing validation
or UI control. Use model-visible facts and this Skill, not project source.

Reuse user-managed Appium and existing device-bound WDA. An open port (including
8100), installed WDA or simulator image is not proof of the selected iPhone.
Do not use `android-tools.mjs`, Android SDK/ADB, UiAutomator2 or Android Back.
Use a base Session without App target capabilities; activate a known bundle ID
separately after readiness. Preserve App data/login and external services.

`check_device_ready` has a bounded 180-second iOS budget (Android: 15 seconds).
Cold readiness defaults to stopping with `IOS_DEVICE_LOCK_STATE_UNKNOWN` when
current awake/unlocked state cannot be proven. CoreDevice
`passcodeRequired:false` plus `unlockedSinceBoot:true` is not proof of current
unlock or screen state. Explain that first WDA initialization may wake the
screen or trigger system prompts and wait for explicit user authorization.
Only then use `check_device_ready({allowWdaInitialization:true})` for that
attempt. This transient flag is not saved, not unlock proof and not permission
to change signing or reinstall. Known lock/unsafe probe states still stop;
readiness requires live WDA unlocked state and real source/viewport observations,
plus an image when requested. Ordinary iOS/simulator execution is not a claim
that all paths use this readiness cold guard.

Trust, Developer Mode, signing changes and deployment require the user's actual
permission; never request Apple credentials. Prefer existing signed WDA when
usable. `IOS_DEVICE_LOCKED` requires the user to wake/unlock, not automatic
unlock, restart or action replay. `IOS_WDA_SECURITY_REJECTED` may mean invalid
signing, entitlements or developer-profile trust. Ask the user to check developer
App trust in Settings > General > VPN & Device Management once. If trusted or
there is no entry, inspect signing and profile expiry read-only; do not force
repeated trust searches or retry/reinstall loops. Renewal/redeployment needs
separate explicit authorization.

When checking an existing WDA build, read its embedded provisioning profile's
creation and expiration dates and whether it includes the selected phone.
Report only these facts, not raw profiles, certificates, account names or device
identifiers. A valid local code signature alone does not prove that provisioning
is current or accepted by the phone. Paid and free signing are both supported: use actual profile and certificate
expiry independently, never infer seven days from an account assumption.
Reinstalling the same binary does not extend provisioning validity.
If renewal is authorized, reuse the existing Xcode signing configuration and
verify the new profile before deploying only WDA. Do not purchase membership,
change teams, revoke certificates or delete unrelated development Apps.

When a current, device-matching WDA build is available, prefer the supported
XCTest launch path with `appium:usePrebuiltWDA:true` and that build's
`appium:derivedDataPath`; this runs `test-without-building` rather than rebuilding.
Do not equate `usePreinstalledWDA` with that path: it uses direct App launch and
can be rejected even after profile renewal. If direct launch fails, verify the
build/profile before choosing a different supported startup mode. Do not keep
reinstalling or tell the user that a missing developer-trust menu is necessarily
the cause. Select unoccupied local WDA/preview ports without disturbing existing
services; Appium's USB forwarding must bind the selected physical device.

For startup or build work, retain `prepare_mobile`'s taskId and query that same work.
A bounded wait expiring means the work may
still be running, not permission to start it again. A build or open port is
not readiness; continue from the actual channel observation when ready.
These initialization and recovery principles were compared against
[iPhone Use's setup workflow](https://github.com/zhongerxin/iPhone-use/tree/08ed5b00965025120f572a7635aef6698f05cf1a/skills/iphone-use-setup).
Maat still uses its existing Appium/Worker path and the host's permissions;
the reference project's setup manager is not another Maat runtime.

Computer preparation passing and Pi integration tests do not establish real
iPhone initialization or five-minute autonomous first use. The tracked child/HTTP tests are not autonomous real-phone first-use acceptance.
Manual pre-start is not proof of that user experience. Release only when this
conversation no longer needs phone interaction;
retain the Session while waiting for user action if more phone work remains.

## Start with what already exists

1. Select Android with `select_platform`. Use `list_devices` when device selection
   is needed; never ignore an explicit device choice. Ask which phone to use if
   several are available.
2. Before first use, call `check_platform_setup`. It checks preparation conditions,
   not whether the phone is fully controllable. Reuse healthy services and known
   startup work. Do not run a full doctor, reinstall, or start a second service
   for every user task.
3. If preparation is sufficient, call `check_device_ready` to establish the current
   Session and obtain a current UI observation. Request `screenshot=true` when
   visual inspection is needed. Before a new local Session, Maat checks that the
   selected phone is awake and unlocked; a locked, screen-off or unknown state
   must stop before automation initialization. Once the user unlocks it, reuse
   existing phone helpers and prepare only missing components. Session creation
   can deploy helpers or trigger platform prompts; explain these effects before
   first connection.
   Configure the device/server first without an App target; after the phone
   channel is usable, discover and launch the requested App with `exe_js`.
4. Reuse the returned observation and continue the original task. A ready channel
   is not proof that the target App is authenticated or that the business task
   succeeded. Screenshots and UI text are observations, not a formal report.
   When this conversation no longer needs phone interaction, use
   `release_device_session`; keep the connection while waiting for a user-only
   step if more phone work remains. Do not close the Pi conversation or stop
   external services. For a later task, check the phone channel again.

Never describe dependency installation, a responding Appium service, or
`check_platform_setup` alone as fully ready. Give one explicit conclusion:

- Before `check_device_ready` succeeds: the computer-side preparation may be
  complete, but phone tasks cannot start yet. State the remaining user or channel
  step.
- After `check_device_ready` succeeds: phone tasks can start. Continue from its
  current observation instead of rechecking or replaying an earlier action.

For diagnosis only, use `get_setup_diagnostics`. Do not create a Session, start a
service or install components if the user asked only to inspect the environment.
Keep technical output separate from the short user explanation.

## Handle the actual missing condition

Tell the user the situation and one useful next step. Do ordinary preparation
yourself within the task's authorization and host permissions. Do not turn every
command into a new confirmation. Ask only when the next action needs the user
or would affect something beyond the agreed task.

- **Appium is installed but stopped:** inspect the configured local endpoint and
  existing preparation task. Use `prepare_mobile(action:"start-appium",taskId:null,waitSeconds:20)`
  once, then `status` with its taskId. Pi passes the same resolved Android tools
  as Maat to the owned foreground child. Do not ask the user to export SDK variables,
  restart Pi, or open another terminal.
- **Appium or UiAutomator2 is missing:** inspect installed versions and compatibility.
  If installation is authorized, use the configured package registry and a compatible
  pinned version. Preserve working installations; do not upgrade everything.
  Recheck after installation.
- **Android tools are incomplete:** locate usable ADB and the SDK tools actually
  required by this driver, including APK metadata tooling. Use the bundled
  `scripts/android-tools.mjs status` and authorized `prepare` commands described
  below. They reuse existing tools and prepare a minimal local cache when needed.
  Do not require Android Studio, an emulator, a global SDK configuration or a Pi
  restart. Do not globally rewrite shell profiles.
- **Java:** do not install a JDK merely because a broad upstream doctor recommends
  it. Existing-App Mobile Use may avoid APK signing paths. This is a candidate
  configuration, not a promise of Java-free operation. If an actual operation
  requires Java, explain the missing capability and prepare it only within authorization.
- **Phone is absent, offline or unauthorized:** ask the user to connect the phone
  or accept the USB debugging prompt. Wait for actual completion, then recheck.
  Do not restart ADB blindly or change another tool's connection.
- **Phone is locked or its screen is off:** readiness must stop before returning
  UI observations. Ask the user to wake and unlock it, wait for actual completion,
  and recheck the current channel. Do not wake, unlock, restart the service or
  replay an earlier action to get around this state. A fresh Session must not be
  started merely to find out whether an already locked phone can be used.
- **A new connection targets a remote service:** explain that this setup workflow
  currently supports the phone connected to the same computer as Pi/Appium.
  Do not substitute a local phone's state for a remote phone or silently switch
  the selected device or endpoint.
- **An unrelated process occupies the port:** preserve it. Prefer an available
  endpoint with `configure_session`; never kill a process merely by its port.
- **Service responds but Session or observation fails:** report the specific
  failure. Do not advertise the phone as ready or loop through reinstall/start.
  If the failure identifies legacy App routing, use
  `configure_session(clearAppTarget=true)` to return to a base Session before
  rechecking. This uses the existing Session-close behavior; it does not clear
  App data. Do not do it without explaining any impact on the current session.

Do not ask for passwords, unlock credentials or verification codes. Device reset,
deleting user assets, overwriting unrelated configuration and disrupting external
services are not ordinary preparation.

## Prepare tools without user environment variables

The script below is bundled with this Skill. Resolve its path relative to this
`SKILL.md`, not the user's project directory, and invoke it with Node through
the host shell:

```text
node <this-skill-directory>/scripts/android-tools.mjs status
node <this-skill-directory>/scripts/android-tools.mjs prepare
node <this-skill-directory>/scripts/android-tools.mjs adb
```

`status` is read-only. `prepare` is an explicit download/cache action, not a
diagnostic check. It uses existing compatible tools first, never installs a full
SDK or JDK, and does not change global shell configuration. Maat discovers the
prepared cache on subsequent checks in the same Pi process.

If diagnosis confirms the local ADB daemon is not running, use the `adb` command
within the task's authorization, then recheck device discovery. It starts the
resolved connection tool explicitly rather than changing the parent PATH or
asking the user to start it manually. Existing incompatible ADB services are
rejected and preserved; never use `kill-server` as routine preparation. Do not
start ADB during a diagnosis-only request.

If ADB must be downloaded, explain that the official Android platform-tools
license applies and obtain actual user acceptance before passing
`--accept-sdk-license` to `prepare`. Do not infer license acceptance from silence
or accept it on the user's behalf. Reusing an existing ADB installation does not
require downloading platform-tools again. Preserve bundled notices.

Use `prepare_mobile(start-appium)` for Appium in Pi. The script's `appium` command
is only a manual foreground diagnostic, not the Pi tracked-startup workflow.
The tool supplies resolved SDK/PATH only in its child environment, not a service manager.
An already ready service is preserved and is not reconfigured. If an existing
external service lacks the tool environment, explain the specific failure; only
its owner may authorize a restart. Do not launch a second server to conceal it.

Report download, unsupported-platform, cache or executable failures explicitly.
Inherited `ANDROID_HOME` and `ANDROID_SDK_ROOT` are candidates, not instructions
from the user. When they are invalid or conflict, explain the warning and let
`status` or `prepare` reuse verified system tools or the Maat cache. Do not ask
permission merely to search again, repair their SDK, clear their variables, edit
their shell profile or restart Pi. A typical explanation is: "The old tool path
is unusable; I will use the connection tools already prepared for Maat."

Only an explicit user requirement to use a particular SDK makes that path mandatory.
If that requirement cannot be met, explain the concrete conflict; do not replace
it silently. A diagnosis-only request still does not authorize downloads or startup.
When preparation finishes, recheck and continue the original phone task; do not
ask the user to run `export` or restart Pi.

## First-use behavior

Begin with the user's actual task, not a questionnaire about environment settings.
For an authorized phone task, checking and reusing existing tools is routine; do
not ask "may I continue looking?" after every failed check. Ask only for a real
decision: device choice when ambiguous, actual download-license acceptance, or
phone authorization/authentication requiring the user.

The user should not need to inspect Maat source or locate its cache. Use the
bundled scripts and model-visible setup facts. Address the indicated missing
component rather than repeating doctor indefinitely. A stopped ADB daemon needs
the explicit `adb` command; missing Appium needs installation, not repeated
connection probes. If one bounded recovery still fails, report the specific
blocked capability and the next useful action, without claiming task completion.

First-use acceptance is an actual Pi/LLM phone task within the user's five-minute,
two-attempt budget. Count startup, downloads, questions and recovery time; do not
reset the clock on retry. Script and unit tests do not establish that experience.

## Startup is work, not phone readiness

A shell command returning successfully, an open port or an Appium `/status` response
does not establish a usable Session. After service startup, recheck preparation
and use `check_device_ready`.

Use bounded `prepare_mobile` waits and inspect the same taskId. A
timeout can mean work is still running; it is not permission to start again.
Long-running services need not exit successfully before they are usable.

If `prepare_mobile` fails, report its actual category rather than claiming
persistent service management or silently delegating startup to another terminal.
Track who created a service. Preserve user-managed services. Do not stop, restart
or take ownership of existing services as a side effect of preparation.

## Recover reading, never replay an uncertain action

For a lost channel, discard stale elements and observations, diagnose the failed
layer and establish a fresh current observation. Recovery of a connection does
not authorize repeating a previous click, input, submission or action batch.

If an action timed out or disconnected after dispatch, it may already have happened.
Read the actual page before choosing the next action. Only known read-only checks
may be retried under a bounded policy.

App login is not a broken automation service. Pause phone calls while the user
authenticates or grants permission. Resume only after their actual completion,
then reread the App and continue from the new state. Do not repeat setup or
reinstall helpers just because an App asks for login.

During normal use, combine a necessary next observation with progress checking;
do not take screenshots or redo readiness after every known action. Recheck after
connection loss, user takeover or other evidence that the channel changed.

Keep device IDs, credentials and sensitive local configuration out of generated
source, shared logs and source control. Maat does not generate or run saved tests;
the host Coding Agent chooses the project's test framework when that work is requested.
