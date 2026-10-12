# @houlianpi/maat-core

Host-neutral UI execution through one `MaatApi`, platform adapters and killable Workers.

`createMaat({ workspaceRoot?, setupAssistant? })` exposes `platforms`, `exploration`
(`executeJavaScript`, `context`), `setup` (doctor checks, Android/iOS readiness and permission
recovery), and `close()`. Execution returns text/image UI observations; a ready device
does not prove a business outcome. Worker `display()` and `evidence.screenshot()` return
image observations, not persisted Evidence records.

`close()` attempts cleanup of owned Workers and native Sessions, not external
Appium or ADB services. Worker exit deadlines are canceled as soon as the child
exits, so completed cleanup does not leave timers delaying host process exit.
Android cleanup does not explicitly terminate the App and requests
`appium:shouldTerminateApp:false`; normal no-reset use preserves App data/login
and avoids closing its foreground page. iOS App termination behavior is unchanged.
Session deletion retains bounded network waits; a slow or unavailable server can
still delay cleanup.

Android `setup.ready({ screenshot?, signal? })` checks `driver.isLocked()` before
reading the UI and again before returning `proof.phoneUnlocked: true`. Locked or
screen-off phones fail with `ANDROID_DEVICE_LOCKED`; failed/non-boolean lock queries
fail with `ANDROID_DEVICE_LOCK_STATE_UNKNOWN`. Wake/unlock the phone yourself, then
recheck. Cold ready first checks the exact selected local device through the existing
ADB daemon (`dumpsys power` and `dumpsys window policy`), requiring explicit awake
and unlocked evidence before Session creation. Locked/off/unknown checks never
enter Appium bootstrap. Remote or unprovable cold routing is unsupported; healthy
remote Sessions still use their driver. Device/endpoint fallback is disabled only
for cold ready. The existing 15-second budget includes preflight and initialization.
Ready does not send wake, unlock or key commands or retry. Appium initialization
can still start required helpers after preflight; a lock transition between that
check and bootstrap is not an absolute no-wake guarantee.
New ready Sessions use transient `appium:skipUnlock:true` to suppress Appium's
automatic unlock; healthy Sessions are reused without reconfiguration. An explicit
conflicting `skipUnlock` hint (including inside `appium:options`) blocks new ready
Sessions rather than being overwritten.
This is a point-in-time observation, not a lasting guarantee or business validation.
Screen-off detection uses the installed Appium driver's lock query, not PNG color.

## iPhone preparation preview

`detectIosSetup` and `setup.check({ platform: 'ios' })` inspect full Xcode,
Appium/XCUITest, physical-device connection/pairing and Developer Mode without
creating a Session. CoreDevice simulator entries cannot stand in for a physical
iPhone. WDA signing/deployment is not verified by doctor.

The iOS readiness path uses the existing Worker, requires an exact local device
and endpoint, and has a three-minute budget. A healthy Session must return
`driver.isLocked() === false` before and after source/viewport/image observation.
Physical-iPhone readiness never falls back to another device/server or replays
an App-target initialization failure. Existing ordinary native execution and
explicit simulator execution remain available outside this readiness path;
neither bypass can be counted as a successful first-use preparation check.

**Cold iPhone initialization requires explicit authorization.** The tested Xcode CoreDevice
lock result contains `passcodeRequired` and `unlockedSinceBoot`, not a current
screen/unlocked proof. A false passcode requirement is not treated as that proof.
Without `allowWdaInitialization: true`, `IOS_DEVICE_LOCK_STATE_UNKNOWN` stops
before POST `/session`. Set this transient flag only after the user explicitly
authorizes first WDA startup and possible screen/system-prompt effects. Even with
authorization, failed queries, a required passcode or no unlock since boot block
initialization. It never sends an unlock command or stores consent in hints.
Authorization is not a machine-proven unlocked fact: only subsequent live WDA
lock checks and actual observations can establish readiness. Do not describe
preparation checks as successful iPhone operation or autonomous first use.

`inspectIosWda({ device?, capabilities?, signal? })` reads the installed XCUITest
project's existing Team and build, verifies the build's signature, and reports
certificate and provisioning-profile expiry separately. It supports current
free or paid profiles without assuming seven-day validity. A ready build must
match the selected phone, configured Team/bundle and profile certificate.
Returned Session capabilities are internal configuration, not model-facing
diagnostic data.

`prepareIosWda({ ..., signingAuthorized })` reuses a valid build without
rebuilding. Missing or expired builds require explicit authorization; renewal
uses the existing project settings, verifies the result and rejects unexpected
project changes. It builds only WDA; it does not deploy, choose a Team, purchase
membership, change signing identity or claim phone readiness. Commands have
bounded output, cancellation/deadlines and owned process-group cleanup.

Case/Draft recording, saving/promotion, formal test Sessions, Runner, reports and the
`@houlianpi/maat-core/test` export have been removed without a compatibility layer.
Historical `maat-tests/` assets are not modified or executed by Core.

Native adapters no longer accept a test root. `WebPlatformAdapter` accepts a
`configRoot` only for reading named profiles from `maat.config.json`. Built-in Web
composition retains `<workspaceRoot>/maat-tests/web/maat.config.json` as its existing
read-only profile location; it does not create or maintain a test directory there.
Explicit browser profile/user-data options and native `~/.maat/session-hints` storage
(or `MAAT_SESSION_HINTS_DIR`) retain their existing behavior.
