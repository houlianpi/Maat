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
`maat-setup` Skill. The host Agent uses its existing tools and permissions to handle
necessary preparation; Maat does not create another installer Agent or service manager.
This preparation workflow is local: Pi, Appium and the phone's ADB connection
run on the same computer. Remote preparation is not part of the current scope.

After selecting Android:

- `/maat-setup` hands preparation to the host Agent.
- `/maat-doctor` shows redacted environment diagnostics.
- `/maat-status` shows the current platform and preparation state.

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
3. For Android, `check_device_ready` creates or reuses a Session and returns the
   current UI source and viewport. Request `screenshot=true` for visual inspection.
   Session creation may deploy automation helpers or trigger system prompts.
4. Use `exe_js` for UI execution. Its only input is `code`; observations are not
   recorded as formal steps. Reuse returned observations for the next action.
5. If phone authorization or authentication requires the user, pause and wait for
   actual completion. Read the current UI before continuing the original task.

Doctor checks preparation, not business results. A responding Appium service does
not prove a usable phone. Recovery must never replay a potentially executed click,
input or submission. Host Shell and file tools remain available under host permissions;
there is no Maat work mode.

Maat discovers existing Android tools and its managed local cache dynamically.
The setup Skill's bundled `android-tools.mjs` prepares missing ADB/AAPT2 under
authorization and starts the existing Appium installation with the same tool
environment. Users do not need SDK exports or a Pi restart. Official
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
The current Pi setup path has not passed this acceptance: when no supported,
tracked background execution mechanism is available, the foreground Appium
launcher cannot by itself complete autonomous startup. Manual terminal startup
is a diagnostic fallback, not a successful first-use result.

## Tools and runtime

| Tools                                                                | Purpose                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| `list_platforms`, `select_platform`                                  | Discover and select an execution adapter                   |
| `list_devices`, `find_applications`, `configure_session`             | Inspect devices/apps and supply connection hints           |
| `check_platform_setup`, `get_setup_diagnostics`                      | Preparation diagnosis                                      |
| `open_setup_step`, `retry_setup_step`, `continue_without_capability` | Preparation instructions and permission recheck            |
| `check_device_ready`                                                 | Verify the current Android channel and return observations |
| `configure_browser`, `get_browser_config`                            | Web browser configuration                                  |
| `exe_js`                                                             | Execute code in the active persistent UI Session           |

Web exposes Playwright `page/context/browser`; native adapters expose WebdriverIO
`driver/browser`. Consult `list_platforms` for the current globals. Use `console.log`
for text and `display` for PNG/JPEG/WebP image bytes or image data URLs. The native
`evidence.screenshot()` helper returns a screenshot observation; it is not a formal
Evidence store or report.

Appium Sessions use local hints outside source control. The host manages service
startup; Maat closes only its owned Sessions. Existing native close behavior may
terminate the configured target App and is not changed by this cleanup.
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

The `0.3.2` prerelease is for local Android first-use testing, not a compatible
patch of the former testing Harness. Autonomous Appium startup in Pi has not
passed first-use acceptance. Install this candidate explicitly:

```bash
pi install npm:@houlianpi/maat-pi@0.3.2
```
