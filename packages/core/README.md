# @houlianpi/maat-core

Host-neutral UI execution through one `MaatApi`, platform adapters and killable Workers.

Adapters resolve native routing before configuring the runtime. The runtime keeps
one resolved target; it has no separate raw-environment configuration/discovery
path. Local browser executable detection used by regressions lives in test
fixtures and is not shipped as a Core capability.

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
Local physical-iPhone readiness and cold execution use exact device/server
routing and verify reusable WDA before Session creation. Simulator and remote
execution remain separate; they are not physical-phone readiness evidence.

**Normal phone tasks may establish the existing control connection.** CoreDevice
`passcodeRequired` and `unlockedSinceBoot` are cold lock hints, not proof of current
unlock. Known passcode/boot locks and failed queries still stop. Otherwise the
connection initializes without a separate per-Session approval; only live WDA
lock checks and actual observations can establish readiness. No automatic unlock
or business UI action runs during readiness.

The cold path checks a current signed build and the component installed on the
selected phone. First installation requires transient `allowWdaInstallation:true`;
it does not authorize signing or restart. Missing/expired signing stops for an
authorized build/renewal. Conflicting identity, automatic alert handling or a
startup configuration that may remove another test Runner is rejected.
The legacy Core `allowWdaInitialization:false` option remains an explicit
existing-Session-only restriction, but Pi no longer exposes it as a routine chore.
Neither permission is persisted in hints.

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
