# Maat agent development guide

Keep this file focused on navigation, ownership, safety and review decisions.
Product usage belongs in the README; executable contracts belong in types and tests.

## Product boundary

Maat supplies real UI observation and execution to a host Coding Agent. Android
Mobile Use through the Pi extension is the current focus; Web, iOS and macOS
execution remain available.

- The user supplies business intent. The host plans, prepares the environment and
  chooses actions. Maat executes, returns observations and reports failures.
- A responding service, ready Session or successful action is not business validation.
  Do not invent expectations or claim an observed result proves more than it does.
- Setup uses the host's existing tools and permissions. Do not add another planner,
  installer Agent, runtime or generic service manager.
- Case/Draft generation, formal Runner/SessionPool, reports, Replay recording and
  work modes were removed. Do not rebuild compatibility layers for them.
- `maat-tests/` contains retained historical assets, not current executable tests.
  Preserve those files; they are excluded from the root typecheck.

## Repository ownership

```text
packages/core/  Host-neutral API, Worker, adapters and setup checks
packages/pi/    Pi tools, setup Skill and UI
packages/maat/  Standalone Pi-backed TUI, one-shot Agent and executable
test/          Observable specifications and regressions
artifacts/     Generated output, never editable source
```

- Dependencies point inward: Hosts/CLI -> Core. Core never imports a Host SDK.
- Adapters own platform conditionals, connection discovery, Session lifecycle,
  runtime globals and screenshots. Consumers use the platform contract.
- The only execution path is the killable Worker and existing platform runtimes.
- The native `evidence.screenshot()` helper returns an in-memory image observation;
  it is not a formal Evidence store.
- Pi supplies SDK dependencies; avoid installing a second Host SDK inside the extension.
- `.github/agents/` contains the development squad. Do not remove customization or
  historical assets as incidental cleanup.

## Working procedure

1. Read this file, package manifests, affected producers/consumers and nearest tests.
2. Inspect Git status and integrate user changes; do not revert unrelated work.
3. State the observable result and module boundary. Escalate decisions below before editing.
4. Implement success, failure, observation and cleanup behavior together.
5. Run focused regressions, then required gates and installed-package checks.
6. Exercise the actual user path proportionally to risk and report unverified areas.

## Official commands

```bash
node --experimental-strip-types --test test/<domain>.test.ts
npm test --workspace @houlianpi/maat-core
npm test --workspace @houlianpi/maat-pi
npm test --workspace @houlianpi/maat
npm run build
npm run typecheck
npm run format:check
npm test
npm run package:check
```

`typecheck` builds first. Builds clean only their generated package `dist`.
`package:check` packs and installs all three packages, exercises Worker/CLI/Skill
delivery, checks dependency boundaries and rejects removed modules in tarballs.
Run it for exports, manifests, dependencies, binaries or compiled-path changes.

Focused areas:

- Worker/Web: `javascript-session`, `platform-adapter`, `mixed-case` (execution
  switching regression), and `exec-js-tool`.
- Native execution: `native`, `platform-adapter`, `android-setup`.
- Setup: `setup-assistant`, `setup-tools`, `android-setup-tools`, `setup-ui`, `setup-skill`.
- Hosts/CLI: `pi-extension`, `maat-tui`, `cli-bin`, `agent-options`, `agent-trace`.

Use controlled local browser content. Mock Appium proves contracts, not platform
coverage. Real native claims require a user-managed service and actual device or
simulator. Missing prerequisites mean that path remains unverified; never call
it validated. Do not run phone writes, sends, purchases, deletes or authentication
without explicit authorization.

## Engineering and safety

- Use ESM, strict TypeScript and source-relative `.ts` imports. Validate `unknown`.
- Reuse existing APIs; avoid generic utilities or speculative layers.
- Cleanup is bounded, idempotent and attempts owned resources. Preserve the primary
  error when supplemental diagnosis or cleanup fails.
- Model code runs only in the Worker with timeout, Abort, protocol/output limits,
  stderr bounds and process-tree termination. It is not a filesystem/network sandbox.
- Keep exploration Sessions independent of Host conversation lifetime. Close only
  owned resources; never stop a user-managed Appium server.
- Preserve App data/login. Reset requires explicit intent. Do not change native
  App-close semantics incidentally.
- Recovery rereads current state; never replay a potentially executed action.
- Failures must be model-visible with a useful category and summary, not only in logs.
- Keep credentials, full device identity, sensitive paths and UI text out of source
  and shared logs. Trace output may contain prompts/UI text; do not publish it casually.
- Use the configured company registry, commit the lockfile and keep runtime versions exact.
- TypeScript is still a runtime dependency for Worker code transformation; do not
  remove it merely because formal test generation was removed.

## Decisions requiring human confirmation

Stop before changing supported platforms, external-service ownership, destructive
reset, Session/App-close behavior, Worker permissions, secret filtering, retention
or trust claims, Core/Host dependency direction, package boundaries, breaking public
APIs, or user asset contents. Explain the concrete impact and recommendation.

## Delivery

Name the changes, commands and actual results. State device/Host paths not exercised,
environment blockers and outstanding decisions. Never claim a completed build,
installed package, Session, UI result, CI run or release without evidence.
CI checks source and package gates; it does not provide live-device coverage.
