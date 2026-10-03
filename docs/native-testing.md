# Native testing with Maat

Maat uses TypeScript throughout: WebdriverIO Client for exploration, Appium with UiAutomator2 / XCUITest / Mac2 for device control, and WDIO Runner + Mocha + expect-webdriverio for saved tests. No Python bridge or custom WebDriver client is involved.

## Start in the Agent

Run `maat`, then describe the project, app and expected outcome. For example:

```text
选择 android 项目，使用连接的手机测试 Demo 应用。
先查找应用，保留登录和应用数据。
测试目的：点击登录后显示 Welcome。执行后保存 Case。
```

Agent tools: `select_project`, `list_devices`, `find_applications`, `configure_native`, `exec_native`, `begin_case`, `save_case`, `list_evidence`, `show_evidence`.

`exec_native` runs TypeScript in a child process with persistent `driver`/`browser` (WebdriverIO), `expect` (expect-webdriverio), `console.log` and `display(base64Screenshot)`. Local variables are per call; the device Session persists.

```typescript
await driver.$('~login-button').click();
await expect(driver.$('~welcome')).toBeDisplayed();
display(await driver.takeScreenshot());
```

Only one matching local device is selected automatically. `native-target.local.json` stores a stable selector such as `{ "kind": "simulator", "name": "iPhone 17" }`; Maat resolves its current UUID at runtime. An explicit remote Appium server has no standard device-discovery endpoint, so use its stable `deviceName` routing capability. Android app lookup currently matches package IDs; real iOS discovery uses Xcode, and macOS discovery lists installed app bundles.

## Projects and configuration

```text
maat-tests/
  web/playwright.config.ts
  web/cases/calculator/*.spec.ts
  android/wdio.conf.ts
  android/fixtures/maat-test.ts
  android/native-target.local.json
  android/cases/login/*.spec.ts
  ios/wdio.conf.ts
  macos/wdio.conf.ts
```

Platform roots are fixed to `web`, `android`, `ios`, `macos`. `select_project` accepts only `platform`; the manager rejects arbitrary project names. Put business grouping in `begin_case.module` (for example `calculator` or `account/login`), never in a new root such as `iphone-calculator`. `begin_case` cannot set a custom root. These rules are in the runtime prompt, tool schemas, save-path checks and regression tests, not only AGENTS.md.

Native platform scaffolds are created on selection. Agent configuration is saved to ignored `native-target.local.json` (not the Case). For CI, set `MAAT_NATIVE_TARGET` to a runtime-supplied target file. Example:

```json
{
  "platform": "android",
  "device": { "kind": "device", "name": "Pixel 9" },
  "capabilities": {
    "appium:noReset": true,
    "appium:fullReset": false
  }
}
```

Add `serverUrl` for remote Appium, including any `/wd/hub` base path. Omit it for a Maat-owned local server. Maat uses the WDIO Appium service for local process lifecycle and deletes only its own remote Session. A new Session does not clear application data. Data reset requires an explicit user request.

The local target contains the environment: Appium endpoint, stable device selector, signing, timeouts and data-retention policy. It does not persist a discovered UUID or the current app. App identifiers are transient during exploration and saved as Case target metadata. Driver-specific signing capabilities remain configuration. Real iPhone XCUITest still requires Apple signing/provisioning and Developer Mode.

Each saved native Case records only its app target (`appium:bundleId`, Android package/activity, or app path) in a leading `@maat-target` comment. `maat test` applies that app target before WDIO creates the session, so changing the exploration app cannot replay a calculator Case in Calendar. The device selector, Appium URL, signing and data-retention settings come from ignored `native-target.local.json` or the `MAAT_NATIVE_TARGET` override. Batch runs start a separate session for each spec to apply its target. Existing native specs without target metadata need to be revalidated and saved.

The same `beforeSession` hook applies Case target metadata when WDIO is launched directly through `wdio.conf.ts`; there is no Maat-only environment variable contract. Suite, tag and all-Case runs execute every selected spec in its own Session and return a failing aggregate status after the remaining Cases finish.

## Driver prerequisites

```bash
maat appium install android
maat appium install ios
maat appium install macos
maat appium doctor ios
```

These explicit commands use `~/.maat/appium` (`MAAT_APPIUM_HOME` overrides it). No drivers, devices or OS permissions are automatically installed/configured during npm installation. Android requires SDK/JDK and an authorized device. iOS/macOS require a Mac with Xcode and platform permissions.

## Save and run

`save_case` runs the generated native spec through the real WDIO Runner using a new Session. Only a passing candidate is promoted to `<id>.spec.ts`. Failed validation retains its log under `artifacts/native/<platform>/runs/<run-id>/wdio.log`. Native execution never invokes Playwright.

```bash
maat test --project android --suite smoke
maat test --project ios --case login-success
maat test --project web --browser chrome --suite smoke
```

Native reports: WDIO spec output and a per-run directory at `artifacts/native/<platform>/runs/<run-id>/`, containing `wdio.log`, `junit/`, and `evidence/<case-id>-<attempt-id>/`. Each Evidence directory includes named screenshots and `evidence.json` linking the test title, suite, source file, result and screenshot paths. Failed screenshot capture is recorded explicitly without hiding the original assertion result. Paths are rooted in the test workspace, independent of the shell working directory.

Native Cases import `fixtures/maat-test.ts`; no `node:fs`, directory creation, UUID or base64 persistence boilerplate is generated in specs. WDIO hooks automatically capture `final-state` or `failure`. Optional intermediate screenshots use `await evidence.screenshot('after-login')`; existing `display(await driver.takeScreenshot())` steps remain compatible through the fixture. Web retains its official Playwright HTML report. Native HTML visualization is not supplied yet.

The old `iphone-calculator` Case and local target have been migrated into `ios`. Previous project configurations are retained under ignored `artifacts/migrations/platform-layout-2026-10-02/` for recovery. Restart Maat and select the `ios` platform; old project names are no longer accepted.

## Verification and limits

Tests exercise real WebdriverIO, expect-webdriverio and the WDIO/Mocha Runner against a local fake W3C server, plus real Appium service startup/shutdown. This verifies integration without altering personal devices. It does not prove real-device driver/signing readiness.

The worker is killable, not an OS security sandbox. Native execution is serial, with 64 KiB code and 12 MiB observation limits. Driver startup has a longer deadline for WDA builds; an abort during startup is handled once the startup request settles. Remote session deletion can fail if the server is unreachable; server-side newCommandTimeout is the fallback.

Dependency audit at integration time reports 19 advisories (18 high, 1 moderate), primarily through WDIO browser-download/proxy dependencies and Mocha serialization. These have not been suppressed or fixed by switching stacks. The native stack remains WDIO/Appium as agreed; review upstream fixes before distributing it to production.
