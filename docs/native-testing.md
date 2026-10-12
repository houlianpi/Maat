# Native setup and execution

Maat uses WebdriverIO and Appium for Android, iOS and macOS. The host Coding Agent
handles authorized environment preparation with its existing tools. Maat owns
its Sessions and execution Worker, not user-managed Appium servers.

## Android preparation

The current setup workflow targets Pi, Appium and the Android phone's ADB
connection on the same computer. Remote connection preparation is outside its scope.
The packaged `maat-setup` Skill guides device selection, installed-tool reuse,
service startup, user authorization and recovery. `check_platform_setup` checks
preparation without creating a phone Session or starting Appium/ADB.

The current engine needs Appium, UiAutomator2 and the Android tools it actually
uses, including ADB and APK metadata tooling. It does not require Android Studio
or an emulator for a real phone. Java is not an unconditional Mobile Use check;
APK signing/install workflows may still require it. A Java-free real-device
path must be verified, not inferred from an upstream doctor checklist.

`check_device_ready` creates or reuses a Session and returns the current source
and viewport, plus an optional screenshot. Session creation may deploy automation
helpers. A service `/status` response is not proof of phone operation.
Readiness checks the lock/screen-off state before returning observations. A locked
phone requires the user to wake and unlock it; initialization must not unlock it
automatically. Successful readiness includes `phoneUnlocked: true`.
For a new local Session, a read-only ADB check of the exact selected device runs
before Appium initialization. Locked, screen-off, unknown or failed checks cannot
create that Session. A cold remote readiness request cannot use local ADB as proof
and is rejected. A healthy existing Session continues to use the driver's lock check.
Preflight checks establish a fact at that moment; they are not a guarantee against
the user or device locking again between a check and Session creation.

## iPhone preparation preview

On macOS, `check_platform_setup` for `ios` reads Xcode, Appium/XCUITest and
CoreDevice connection/pairing/Developer Mode facts. Physical devices are
distinguished from simulators, including simulator entries in CoreDevice.
Doctor does not start WDA or create an Appium Session and does not prove that
WDA signing or phone observation works.

`check_device_ready` is wired to the existing Worker for iOS with a three-minute
budget and before/after `driver.isLocked()` observations. It requires a base
physical-iPhone Session without an App target. The cold path binds the exact
local endpoint and device and must not use another phone or an unrelated WDA.

Cold initialization is blocked by default: the observed CoreDevice lock response
contains `passcodeRequired` and `unlockedSinceBoot`, neither of which proves the
current screen and lock state. It returns `IOS_DEVICE_LOCK_STATE_UNKNOWN`
before Session creation instead of inventing an unlocked proof. After the user
explicitly authorizes startup of WDA and possible screen/system-prompt effects,
`allowWdaInitialization=true` permits this one initialization when the read-only
query succeeds, no passcode is required and the phone was unlocked since boot.
It does not authorize signing changes, reinstallation or a device restart.
The flag is not persisted and is not a proof of current unlock. Live WDA lock
checks and actual UI observations remain required. No autonomous first-use
success follows from an authorization or preparation result alone.

Only the user may approve device trust, Developer Mode, signing/account access,
unlock or a required restart. Never request Apple credentials, rewrite signing
settings automatically or disturb an existing simulator WDA. Existing simulator
execution remains separate from physical-iPhone readiness.

Free Personal Team provisioning expires seven days after issuance. Renewing
requires a newly signed build and deployment, not reinstalling the old binary.
Inspect the embedded profile's expiration and selected-device inclusion before
blaming a missing trust menu; a valid code signature does not make an expired
profile usable. Do not switch teams, purchase membership or revoke certificates
as automatic recovery. See [Apple's account limits](https://developer.apple.com/help/account/basics/about-your-developer-account).

### Observed physical-iPhone path

On 2026-10-12, a local Mac with Xcode 27.0, Appium 3.7.0 and XCUITest 12.13.2
renewed and deployed WDA with explicit user authorization. The new Personal Team
profile was valid for seven days, included the selected phone, and retained the
existing project signing configuration and WDA identifier.

Direct `usePreinstalledWDA` launch remained rejected by iOS. The same verified
build succeeded through `usePrebuiltWDA` plus its `derivedDataPath`, using XCTest
`test-without-building`. The first successful readiness took about 21 seconds
and returned actual unlocked/source/viewport/screenshot observations.
This is a verified configuration, not a guarantee for every iOS/Xcode version.

Installed-App discovery includes CoreDevice's default Apps, not only development
Apps. Through the existing Maat Worker, the actual system Calculator was opened,
its observed keys were clicked for `3×3×8`, and both its displayed value and final
screenshot showed `72`. Owned Sessions were cleaned up and the user-managed
Appium service remained responsive. These scripted physical-device results do
not establish autonomous Pi/LLM first-use acceptance or tracked Appium startup.

### Model-driven unlock recovery

A separately labeled real Pi/LLM recovery run on the same date completed in
93.478 seconds, including cleanup. With the selected Appium endpoint initially
stopped, the Agent used `prepare_mobile` to start tracked service work, reused
the valid WDA build without signing changes, and obtained real phone readiness.
It observed the old Calculator result, cleared it, read `0`, entered `3×3×8`,
pressed Equals, and read and captured the new `72`. The Agent released its
Session; the harness then shut down its owned service, leaving the separate
user-managed Appium service responding.

The original product attempt failed on the task-ID argument contract, and the
first post-fix run stopped at a locked phone. Both records are retained. The
recovery run used a new controlled Pi Session after the user explicitly unlocked;
it does not prove continuous in-conversation waiting, the original cumulative
five-minute/two-attempt target, a fresh Mac installation or first-time signing.
The harness disabled shell/file writes to exercise the preparation tools rather
than manual service startup.

## Connection hints and actions

### UI execution strategy

The host LLM generates Appium JavaScript and submits UI work through `exe_js`.
Host-shell commands and temporary WDA clients are not alternate UI operation
paths. Skills guide targeting and recovery; Maat does not embed App-specific
operation scripts or decide locators on the model's behalf.
This UI-only boundary preserves Android's authorized `adb push`/`adb pull`
transfers between the selected device and the computer. Host tools may perform
that platform-native non-UI work within the requested file/path scope, without
unapproved overwrite; verify transfer completion. ADB is not an iOS capability.

Query current controls first, including an identifiable scroll container when
available. Absolute-coordinate fallback requires an unreadable tree or a
requested target with no usable control, a stated reason, and a current
screenshot mapped to Appium viewport units. Incorrect selectors, truncated
extraction and XML parsing errors are not proof that controls are missing.
The runtime still executes supplied JS; these strategies are model guidance,
not a heuristic that blocks legitimate coordinate fallback.

The WeChat Moments exploration did not complete the requested date-bounded
summary. Its temporary observation path and premature coordinate choice were
not a control-driven acceptance result. Updating guidance does not establish
that WeChat's control/text observations are now reliable; that needs a separate
real task through the shipped `exe_js` path.

`configure_session` supplies server URL, device selection and App capabilities.
Local hints may be cached under `~/.maat/session-hints/<adapter>.json`; keep
device identities, signing information and credentials out of source control.
Use `find_applications` rather than hardcoding the wrong App variant.

`clearAppTarget=true` explicitly clears runtime App routing before a base
readiness check. It uses the existing Session-close behavior, does not erase
App data, and cannot be combined with a new App target.

Native `exe_js` exposes `driver`, `browser`, `app`, `expect`, `console`, `display`
and `evidence`. The screenshot helper returns an observation, not a saved
Evidence manifest. Switching adapters preserves their independent execution
Sessions. The Worker is killable, not an OS sandbox.

## Failure and cleanup

Reuse healthy services and known startup work. Do not stop an external server,
kill a process by port, or reinstall everything after a timeout.
An action may already have happened; reread the current UI before deciding how
to continue, never replaying a previous input/submission batch automatically.

Only the user can grant device trust, unlock, enter passwords or complete
authentication. Wait for actual completion and then obtain a new observation.
App data/login are retained by default. Existing native cleanup may terminate
the configured target App before deleting the owned Session; its semantics
are unchanged here.

Maat no longer provides formal Case generation, test Sessions, a Runner,
validation status or HTML reports. Saved example files remain historical
assets. Automated regressions use controlled content and Mock Appium;
platform support claims require actual user-managed device execution.
