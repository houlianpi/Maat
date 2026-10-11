# @houlianpi/maat-pi

Pi coding-agent extension for Maat. Install with `pi install npm:@houlianpi/maat-pi`.

## Mobile TUI preview

Start Pi with `pi --maat-mobile-ui` to opt into compact cards for **all Maat tools**
and a concise single-line platform status. Labels follow the current session's
user language (Chinese or English), cached from lifecycle events rather than
resolved from the machine locale during card rendering.

**Control source:** the host Agent generates tool arguments and JavaScript;
Maat's existing Worker/platform runtime executes them. These cards only present
returned results: they do not control the phone, request observations or retry
actions. Pi independently draws inline images and owns its image display setting.
No host thinking configuration or assistant content is changed.
Complete arguments, text and images sent to the model are preserved; the Android
preparation instruction result adds only a `systemChangesExecuted: false` detail.
Platform discovery, connection and preparation tools also use compact cards,
including before Android is selected. Platform lists show platform names rather
than runtime JSON; device/application lists show counts and a few names, including
explicit empty results. Preparation checks retain blockers and the actual next step.
`/maat-setup` Android messages use Pi's public message renderer: compact user summary,
full instructions/facts still in model context and expanded view.

Call headers identify the tool and show its phase only while pending/executing.
After completion the header is only the tool identity; the result is normally one
neutral summary line. JavaScript text results show their original content,
including image-coordinate notes and technical payloads, with a default preview
of at most 240 Unicode characters and three lines; an ellipsis marks truncation.
Expansion reveals the complete text, and model observations are never truncated.
Image-only
results report the number returned; text results do not repeat image counts.
XML/JSON/globals remain expandable. Error causes, action certainty and recovery
guidance are visible without expansion. Errors without explicit certainty facts
stay uncertain; known not-started failures say no UI action ran.

The editor status shows only the phone and the most important user state.
Before a native platform is selected it says "Phone · Awaiting connection",
not the internal default Web adapter. A checked missing device says "Connect
the phone"; an unchecked device is not presumed absent. Other states are unlock,
authorize/select, check the connection, operating, checking, ready, or not prepared.
User-only actions and unresolved execution risk outrank activity.
Preparation passing alone never means "Ready": that
requires a recent successful `check_device_ready` result. It is not a live
connection guarantee or business validation. Unrelated diagnostics, returned
images and same-platform configuration cannot clear a prior execution risk.
An actual successful channel check clears the connection warning, but the original
failure and action uncertainty remain in the error card. Session/tree navigation
and platform changes reset presentation without closing a Maat device Session;
accepted routing/configuration invalidates channel confirmation.

**Still needs manual visual acceptance:** real Pi in image-capable and text-only
terminals, input/IME preservation, narrow-width status and
inline-image coexistence. Public SDK contracts are tested, not terminal pixels.
There is no reliable public business-completion/authorization signal here: requests
for user intervention remain in the conversation, except explicit host error codes
such as `ANDROID_DEVICE_LOCKED`. No task/action inference or automatic recovery is added.

## Android setup and Mobile Use

Use a base Android Session and launch Apps separately through `exe_js`, rather
than binding `appPackage`/`appActivity` during setup. When the current conversation
no longer needs phone interaction, the host calls `release_device_session`.
This releases the owned Worker and Appium Session, not the Pi conversation or
external Appium/ADB services. Normal no-reset Android cleanup does not explicitly
terminate the App. Keep the connection while awaiting user actions if more phone
work remains; a model-turn end is not an automatic release trigger. Later phone
work requires a fresh channel check. Cleanup failure remains visible.

The package ships internal `maat-setup` and `mobile-use` workflows alongside its
extension without adding `skill:*` commands. Ask the host Agent to prepare an
Android phone, or select Android and run `/maat-setup`, the only Maat command.
Setup reports distinguish computer-side preparation from a verified phone
channel. Multi-step phone work uses bounded scrolling and treats each `exe_js`
call as isolated.
Execution failures return a model-visible category, phase, Session state and
action certainty. Compile failures can be corrected; runtime or timeout failures
require a fresh read of current UI state and are never replayed automatically.
Maat tool failures remain error tool results inside the Pi Agent loop; they do
not terminate the host Pi Session, so the model can recover in the same turn or
the user can continue with a later message.
`check_platform_setup` and `get_setup_diagnostics` diagnose preparation; `check_device_ready`
checks the actual phone channel and returns observations.

The host Agent handles authorized installation, configuration and startup with
its existing tools. Maat does not start or stop external services. Shell and file
tools remain available under host permissions; there is no Maat work mode.

The old Case/recording/report tools were removed. `exe_js` accepts only `code`
and returns observations; it does not save a formal test.

The Skill's bundled `scripts/android-tools.mjs` offers read-only `status`, explicit
`prepare`, authorized ADB startup and foreground `appium` commands. Prepared tools become visible to the
same running Pi process; the launcher supplies their environment to Appium without
asking users to export SDK variables. Downloads of official platform-tools require
actual license acceptance. Existing services and global configuration are preserved.
