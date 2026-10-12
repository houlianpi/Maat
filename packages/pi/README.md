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
`/maat-setup` Android and iOS messages use Pi's public message renderer: compact user summary,
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

iPhone status also distinguishes connection, device selection, computer trust,
Developer Mode, `IOS_DEVICE_LOCKED`, unknown cold state
(`IOS_DEVICE_LOCK_STATE_UNKNOWN`) and WDA trust/signing rejection
(`IOS_WDA_SECURITY_REJECTED`). Preparation never clears an unresolved channel risk.

## iOS setup and Mobile Use

Android and iOS share the natural-task or `/maat-setup [android|ios]` entry.
`prepare_mobile` supplies concrete tracked local work: `status` is read-only,
`start-appium` reuses healthy user Appium or starts one owned foreground child,
and `build-ios-wda` reuses valid builds or performs explicitly authorized signing
preparation through Core. Poll the returned taskId with `status`; `waitSeconds`
is 0–20 and never replays work. States/errors/categories are model-visible.
Startup has a 60-second overall deadline; WDA work 180 seconds. Appium `ready`
means only serviceResponding, not deviceReady or business success.
No shell/untracked daemon, endpoint fallback, port-process killing or second terminal.
Extension/TUI shutdown closes Sessions before bounded owned-child cleanup;
user services remain untouched. Raw stderr, PID and private signing/build hints
never enter content. Embedders using `createMaatPiTools` can pass their owned
`MobilePreparation` and must call `closeMobileRuntime` for the same lifecycle.
Setup/model diagnostics no longer suggest a conflicting foreground Appium command
or a generic host-background workaround. With an owner, they direct the Agent to
`prepare_mobile({action:"start-appium",taskId:null,waitSeconds:20})` and read-only
`status` polling of the returned taskId. Without an owner, tool factories report
`HOST_TRACKED_PREPARATION_UNAVAILABLE`, not automatic startup. Standalone setup
context/command embedders must explicitly pass `{prepareAvailable:true}` only when
that tool is registered; the default is unavailable. The setup script's documented
foreground Appium mode and ADB/SDK/driver installation commands remain available.
Reuse requires the Appium ready message and supported build version, not arbitrary
WebDriver `ready:true`. Owned listener logs must match the selected host/port.
POSIX uses an owned process group with retained child handle/stdio, not an
unreferenced daemon: TERM/KILL still targets the group after root exit. Windows
cleanup that cannot prove the owned tree stopped is a visible cleanup error.
Cancellation retains the actual build/start promise and waits an independent
three-second cleanup grace; late errors/unsettled work preserve the primary failure.

For WDA, actual profile and independent certificate dates determine reuse for
paid/free signing alike. No assumed seven days or Team change. Valid reuse needs
no signing authorization; missing/expired builds require explicit scope. The task
builds only and applies internal capabilities after adapter/device identity checks.
Later XCTest deployment/initialization needs authorized scope. No new planner:
the original conversation continues, combining only necessary first-control/
signing/possible-wake explanation, without exposing internal flags to users.

`/maat-setup ios` selects iOS; subsequent `retry_setup_step` and
`get_setup_diagnostics` remain iOS. Doctor is read-only and checks preparation,
not signing or control success. Reuse local user-managed Appium and WDA verified
against the selected physical iPhone, never a simulator just because 8100 responds.
Use the iOS Skill section, not project source, SDK tools or Android gesture/input/Back APIs.

`check_device_ready` accepts `screenshot?` and `allowWdaInitialization?`.
The latter is iOS-only and transient, default unset: only explicit user authorization
after explaining WDA initialization's possible screen wake/system prompts permits
true for that attempt. CoreDevice first-unlock facts are not current-unlock proof;
unknown cold state blocks by default. Live unlocked WDA and real UI are still
required within the 180-second budget. Signing/redeployment needs separate
authorization; Apple credentials must not be requested.

Security rejection can mean signing, entitlements or profile trust. Check developer
App trust once; if absent or already trusted inspect signing/profile expiry, not
blind retry/reinstall. The local physical-device doctor passed; authorized signing
renewal/deployment and XCTest `test-without-building` initialization returned actual
iPhone UI and the system Calculator result `3×3×8 = 72`. Direct preinstalled launch
remained rejected. This scripted device check is not autonomous Pi/LLM first use;
simulator images do not count as physical-iPhone results.
Tracked Appium startup now has controlled child/HTTP tests; autonomous real-phone
first-use acceptance is still separate and is not proved by those tests.

`release_device_session` supports Android and iPhone. Keep the Session while waiting
for a user action if more phone work remains. Release only when this conversation
no longer needs phone interaction, not at model-turn end; preserve external services.

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

The host Agent handles authorized missing dependencies with its existing tools;
`prepare_mobile` owns only its own Appium startup/build work, never user services. Shell and file
tools remain available under host permissions; there is no Maat work mode.

The old Case/recording/report tools were removed. `exe_js` accepts only `code`
and returns observations; it does not save a formal test.

The Skill's bundled `scripts/android-tools.mjs` offers read-only `status`, explicit
`prepare`, authorized ADB startup and foreground `appium` commands. Prepared tools become visible to the
same running Pi process; the launcher supplies their environment to Appium without
asking users to export SDK variables. Downloads of official platform-tools require
actual license acceptance. Existing services and global configuration are preserved.
