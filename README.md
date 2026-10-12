<div align="center">

**English** | [简体中文](README.zh-CN.md)

# ⚖️ Maat

### UI execution for Coding Agents

[![CI](https://github.com/houlianpi/Maat/actions/workflows/ci.yml/badge.svg)](https://github.com/houlianpi/Maat/actions/workflows/ci.yml)

</div>

Maat lets a Coding Agent observe and operate real interfaces. The host understands
the task and plans actions; Maat supplies device discovery, UI observations,
execution, cancellation and failure feedback. Android Mobile Use in Pi is the
current focus. Web, iOS and macOS execution adapters remain available.

Maat does not generate saved tests, run formal Cases, record Replay files or produce
validation reports. A successful command or ready connection is not a business pass.
The host chooses the project's test framework when the user requests test development.

## Quick start

```bash
pi install npm:@houlianpi/maat-pi
pi
```

Ask Pi to prepare an Android phone and read its current UI. The package includes the
`maat-setup` and `mobile-use` Skills. The host Agent uses its existing tools and permissions to handle
necessary preparation; Maat does not create another installer Agent or service manager.
This preparation workflow is local: Pi, Appium and the phone's ADB connection
run on the same computer. Remote preparation is not part of the current scope.

`/maat-setup` is the only Maat command. It hands preparation to the host Agent.
Status remains visible in the TUI, while diagnostics and packaged workflows are
internal Agent capabilities rather than additional user commands.

Pi displays all Maat tools as compact cards with a concise single-line status by
default. Start `pi --maat-raw-ui` to restore the original display; it takes precedence
over the existing `--maat-mobile-ui` flag, which remains compatible but is no longer
needed. Use the valueless raw flag, not an equals-false value. Pi retains inline images,
expanded raw results and complete model content/structured facts.
See [the Pi package guide](packages/pi/README.md#mobile-tui-preview)
for control sources, status semantics and manual visual acceptance boundaries.

To use the standalone Pi-backed TUI:

```bash
npm install --global @houlianpi/maat
maat
maat help
```

The one-shot Web entry remains available:

```bash
maat agent --browser chromium --headless "Read the page and describe what is visible"
```

## Prepare, observe, act

1. Select a platform and the intended device. Never guess between several phones.
2. Check preparation with `check_platform_setup`. Reuse installed tools, healthy
   services and in-progress startup work; only address actual missing conditions.
3. For Android or a local physical iPhone, `check_device_ready` creates or reuses a Session and returns the
   current UI source and viewport. Request `screenshot=true` for visual inspection.
   Ordinary iOS tasks allow the necessary control connection by default; live WDA
   must confirm unlocked state before business UI observations. First WDA installation,
   re-signing and restart still require separate explicit authorization.
4. Use `exe_js` for UI execution. Its only input is `code`; observations are not
   recorded as formal steps. Reuse returned observations for the next action.
   Failures identify their category, phase, Session state and whether an action
   may already have executed; uncertain failures require a current-state read,
   never automatic replay.
5. If phone authorization or authentication requires the user, pause and wait for
   actual completion. Read the current UI before continuing the original task.

Doctor checks preparation, not business results. A responding Appium service does
not prove a usable phone. Recovery must never replay a potentially executed click,
input or submission. Host Shell and file tools remain available under host permissions;
there is no Maat work mode.

Maat discovers existing Android tools and its managed local cache dynamically.
The setup Skill's bundled `android-tools.mjs` prepares missing ADB/AAPT2 under
authorization. Pi's `prepare_mobile(start-appium)` starts/tracks the existing
Appium installation with the same resolved tool environment. Users do not need
another terminal, SDK exports or a Pi restart. Official
platform-tools downloads require actual license acceptance; existing tools are reused.
No full SDK, Android Studio or JDK is installed by this helper. This does not
guarantee every Appium signing/install workflow is Java-free. The engine is unchanged.

Inherited SDK variables are candidates: reuse a valid SDK, otherwise explain the
warning and find verified tools without modifying the user's configuration or
restarting Pi. An explicit user requirement to use a particular SDK remains binding.
`/maat-setup` from the initial Web platform enters Android; an explicit
`/maat-setup android` is supported. Model-visible diagnostics include categories,
states and preparation actions, not just UI details or MCP-only result fields.

First-use acceptance is an actual Pi/LLM task within a cumulative five-minute,
two-attempt budget, delivering real phone observation and a low-risk result.
Necessary user authorization and license acceptance remain explicit; repeated
technical permission questions and manual service preparation do not count as
autonomous setup success. Unit tests do not substitute for this acceptance.
Pi now owns concrete foreground-child Appium tasks with controlled process/HTTP
tests. Use `prepare_mobile(status,taskId)` to track work with waits of 0–20 seconds;
startup has a 60-second overall deadline. `ready` means serviceResponding only.
This closes the missing tracked-startup mechanism, but autonomous real-phone
first-use acceptance remains unverified; manual pre-start is not acceptance.
An actual Pi/LLM unlock-recovery run has now demonstrated tracked startup,
valid-build reuse and the real Calculator result in 93.478 seconds including
cleanup. This limited recovery check does not overturn the original failed
first-use attempt or establish a fresh-machine installation pass.

### iOS preparation and acceptance boundary

Use `/maat-setup ios` on the local Mac with the intended physical iPhone selected.
Read-only doctor checks Xcode, Appium CLI, XCUITest, connection/pairing, Developer
Mode and Appium. Passing preparation is not WDA signing validation or readiness.
iOS readiness has a 180-second budget (Android: 15 seconds). Ordinary phone tasks
automatically establish necessary control connections, without a per-cold-Session
confirmation. Diagnose actual conditions and reuse current valid builds/existing
phone helpers; a valid local build is not phone installation proof. Core checks actual
installation/signature before connecting. CoreDevice
`passcodeRequired:false`/`unlockedSinceBoot:true` is not current-unlock proof or an
initialization approval gate. Known locks require user unlock; live WDA confirms lock
state after connection. Until usable, no source, screenshot or business UI, no automatic
unlock and no replay. `IOS_DEVICE_LOCK_STATE_UNKNOWN` means a real lock-query failure
or missing boolean: connection unconfirmed, not pending cold authorization.
`IOS_WDA_INSTALLATION_AUTHORIZATION_REQUIRED` separately requests approval for first
WDA control-component installation on the selected phone; without approval, no install.
The model handles `allowWdaInstallation` internally only after explicit approval,
not as user configuration homework. `IOS_WDA_SIGNING_REQUIRED` must not auto-renew;
`IOS_WDA_INSPECTION_FAILED` retains actual inspection failures;
`IOS_CONNECTION_INITIALIZATION_DISABLED` is only a legacy caller opt-out.
First installation, re-signing and restart still need separate grants; combine
necessary concrete effects in one request. Trust, Developer Mode and passwords stay
user-only. Never request Apple credentials or use Android SDK, UiAutomator2
gestures/input or Android Back on iOS.

`IOS_WDA_CONFIGURATION_CONFLICT` reports mismatched signing hints or another phone
testRunner, avoiding Appium cleanup deletion. `IOS_READINESS_UNSUPPORTED` reports
unsafe reuse configuration (`useNewWDA`, auto-accept/dismiss alerts, disabled prebuilt,
forced preinstalled or custom suffix). Report the specific configuration issue,
without automatic configuration changes, reinstall, Team changes or modifications
to user services/phone data. First-install approval does not authorize re-signing.

The local Mac/physical-iPhone doctor has passed. Pi integration is separately
regression-tested. After authorized profile renewal/deployment, the verified WDA
build started through XCTest `test-without-building`; real readiness returned
source, viewport and screenshot, and the system Calculator displayed `72` for
`3×3×8`. This was a scripted physical-device check, not autonomous Pi/LLM first use.
The subsequent model-driven recovery independently cleared the old result,
read `0`, recalculated and observed `72`; see [the verified scope](docs/native-testing.md#model-driven-unlock-recovery).
Direct preinstalled launch remained rejected even after renewal. A WDA responding
on local 8100 was a different simulator, not iPhone evidence. `IOS_WDA_SECURITY_REJECTED` can
involve signing, entitlements or profile trust: inspect developer App trust once;
if trusted or absent, inspect signing/profile expiry instead of retry loops.
`prepare_mobile(build-ios-wda)` inspects/reuses valid builds without rebuilding;
expired/missing builds require signing authorization and preserve the existing
Team/bundle. Actual profile/certificate dates apply equally to paid/free signing,
not an assumed seven days. Build hints stay internal; first installation/signing/restart
need separate authorization, not ordinary connection initialization. Do not stop external services. Manual Appium pre-start
does not prove five-minute first use.

## Tools and runtime

| Tools                                                                | Purpose                                                          |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `list_platforms`, `select_platform`                                  | Discover and select an execution adapter                         |
| `list_devices`, `find_applications`, `configure_session`             | Inspect devices/apps; supply legacy configuration/matching hints |
| `check_platform_setup`, `get_setup_diagnostics`                      | Preparation diagnosis                                            |
| `prepare_mobile`                                                     | Track local Appium startup / iOS WDA reuse or authorized build   |
| `open_setup_step`, `retry_setup_step`, `continue_without_capability` | Preparation instructions and permission recheck                  |
| `check_device_ready`                                                 | Verify the Android/iPhone channel and return observations        |
| `configure_browser`, `get_browser_config`                            | Web browser configuration                                        |
| `exe_js`                                                             | Execute code in the active persistent UI Session                 |

Web exposes Playwright `page/context/browser`; native adapters expose WebdriverIO
`driver/browser`. Consult `list_platforms` for the current globals. Use `console.log`
for text and `display` for PNG/JPEG/WebP image bytes or image data URLs. The native
`evidence.screenshot()` helper returns a screenshot observation; it is not a formal
Evidence store or report.

Appium Sessions may use local legacy compatibility/configuration or matching
hints outside source control. These hints are not target selection, consent,
authorization, a default device, readiness proof or cross-lifecycle target
restoration. Device fields may narrow a current proposal only when they exactly
and unambiguously match current facts; zero/single/multiple-candidate selection
still applies. The active identity and endpoint pin live only in volatile memory
for that lifecycle. Pi/standalone TUI tracks only its own service children and
closes owned Sessions before owned processes; healthy user Appium remains
untouched. Existing native close behavior may terminate the configured target
App and is not changed by this cleanup.
See [native setup](docs/native-testing.md) and [Setup Assistant](docs/setup-assistant.md).

## Architecture

```text
Coding Agent / Pi
  ├── host tools + maat-setup Skill → authorized preparation
  └── Maat tools → Core → Adapter / killable Worker → real UI
```

- `packages/core`: host-neutral API, adapters, Worker and setup checks.
- `packages/pi`: Pi tools, setup Skill and UI.
- `packages/maat`: standalone Pi-backed TUI, one-shot Agent and executable.

Core never imports a Host SDK. Generated code runs in a killable Worker with
timeouts, Abort and protocol/output limits, not a filesystem or network sandbox.
Keep screenshots, UI text, device identities and credentials out of shared logs
and generated source. App data and login are retained unless reset is explicitly requested.

## Breaking cleanup

The former Draft/Case API, `@houlianpi/maat-core/test`, Case tools, mode switches,
Runner/report system and `maat test`, `maat cases`, `maat replay` were removed.
Files in `maat-tests/` are retained historical assets, not current executable tests,
and are excluded from the project typecheck. They were not rewritten or deleted.
Old consumers need migration; do not publish this change as a compatible patch release.

## Development and releases

The project `.npmrc` uses the company registry recorded in the lockfile. Keep
them aligned: npm 12 otherwise treats those tarball URLs as remote dependencies
and rejects them with `EALLOWREMOTE`. Do not disable remote-package restrictions
or change global npm settings to work around this.

```bash
npm ci
npm run build
npm run typecheck
npm run format:check
npm test
npm run package:check
```

`package:check` builds, packs and temporarily installs all three packages, checks
the installed Worker/CLI/Skill and dependency boundaries, and rejects obsolete
formal-test modules in the tarballs. Native platform claims require real device
validation; mocks prove contracts only.

Releases use [publish.yml](.github/workflows/publish.yml), matching workspace versions,
npm Trusted Publishing and provenance. The GitHub release tag must equal
`v<workspace version>`. GitHub prereleases publish to npm `next`; stable releases
publish to `latest`. Publishing order remains Core → Pi Extension → standalone Maat.
Manual dispatch reruns validation and checks the current `next` channel without
publishing packages again. Channel verification waits up to five minutes for
npm processing and checks that previews do not change `latest`.

The `0.3.2` prerelease is for local Android first-use testing, not a compatible
patch of the former testing Harness. Autonomous Appium startup in Pi has not
passed first-use acceptance. Install this candidate explicitly:

```bash
pi install npm:@houlianpi/maat-pi@0.3.2
```
