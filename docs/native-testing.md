# Appium Sessions in Maat

Maat uses the official WebdriverIO Client to create Appium Sessions. Android, iOS and macOS adapters provide platform and driver defaults. Server, device, signing and app details come from explicit input plus ignored local hints.

## Boundary

Driver installation, Appium Server startup, ADB/Xcode setup, WebDriverAgent signing, simulator startup and OS permissions are handled by the user or Agent through Shell. Maat owns the Harness lifecycle after a Session can be created.

The lifecycle is: resolve hints, create Session, attach Exploration Worker, execute JavaScript, collect Observation, build Draft, validate with fresh Sessions, save one Mocha spec, collect Evidence, and delete owned Sessions.

## Agent tools

The main tools are list_platforms, select_platform, configure_session, list_devices, find_applications, exe_js, begin_case, save_case, list_evidence, and show_evidence.

Appium adapters expose driver, browser, expect, console, display and evidence inside exe_js. Each selected Adapter keeps an independent persistent Exploration Worker and Session. Switching Adapter preserves previous Sessions, enabling Web to macOS to Web flows.

## Local environment hints

The ignored maat-tests/<adapter>/native-target.local.json file is a hint. It may contain a Server URL, stable device kind/name, signing, timeout and data-retention capabilities. UUID, app identity, platformName and automationName are not persisted.

Stale Server/device hints are reported and replaced when a single working alternative exists. Multiple devices require selection. App identity is optional for a base exploration Session but required before saving a replayable Case.

## One Case format

All formal Cases are Mocha TypeScript files under maat-tests/cases. A Case may be Web-only, Appium-only, or mixed. The SessionPool creates only referenced Sessions, reuses them for later steps, and closes all of them when the Case completes.

## Evidence and reports

Formal output lives under artifacts/maat/runs/<run-id> and includes mocha.log, result.json, report/index.html, and per-Case Evidence. Playwright and Appium screenshots use the same Evidence manifest and report run. The exploration Worker is a killable process boundary, not an OS sandbox.
