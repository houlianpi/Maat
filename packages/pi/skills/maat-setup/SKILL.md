---
name: maat-setup
description: 'Prepare or recover an Android phone for Maat Mobile Use in Pi: diagnose missing dependencies, reuse an existing connection or startup task, use authorized host tools for setup, verify the phone channel, and continue after user authorization.'
---

# Prepare the phone, then continue the user's task

Maat is a device execution capability of the host Coding Agent. Use the host's
existing shell, file tools and permission interaction for preparation. Do not
create another agent or generate an ad-hoc phone client.
This workflow currently targets a local Android phone with Appium and UiAutomator2:
Pi, Appium and the ADB connection must be on the same computer. Preparing a new
remote Appium connection is outside this workflow.
Host tools remain available under the host's own permission controls.

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

For diagnosis only, use `get_setup_diagnostics`. Do not create a Session, start a
service or install components if the user asked only to inspect the environment.
Keep technical output separate from the short user explanation.

## Handle the actual missing condition

Tell the user the situation and one useful next step. Do ordinary preparation
yourself within the task's authorization and host permissions. Do not turn every
command into a new confirmation. Ask only when the next action needs the user
or would affect something beyond the agreed task.

- **Appium is installed but stopped:** inspect the configured local endpoint and
  existing processes or host-managed startup work. Start the existing installation
  once using the host's supported background execution. Use the bundled script's
  `appium` command so the service receives the same resolved Android tools as Maat.
  Keep the exact task or
  process handle; query that work instead of starting again. Bind a new local
  service to loopback. Do not ask the user to export SDK variables or restart Pi.
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
node <this-skill-directory>/scripts/android-tools.mjs appium --port 4723
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

The `appium` command launches the existing Appium installation in the foreground
with the resolved SDK/PATH only in its child environment. Use the host's supported
background execution to track this process. This is not a service manager.
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

Use bounded waits supported by the host and inspect the same startup handle. A
timeout can mean work is still running; it is not permission to start again.
Long-running services need not exit successfully before they are usable.

If the host cannot keep a background process alive or query it, say so and offer
an explicit user-managed terminal. Do not claim persistent service management.
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
