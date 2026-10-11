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

## Connection hints and actions

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
