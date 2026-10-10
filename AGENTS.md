# Maat agent development guide

This is the single root instruction source for Coding Agents working on Maat. Keep it a navigation and decision guide; put detailed product usage in `README.md` and durable behavior in types and tests. Add a directory-level `AGENTS.md` only when that directory develops genuinely different invariants.

## Product boundary

Maat is a host-neutral UI execution, Evidence, Case, and validation Harness that helps a Coding Agent turn real UI exploration into reviewable tests that run later without an LLM.

- The user or a trusted specification declares the business intent and expected outcome. A Host/LLM may plan, explore, and propose candidate assertions. Maat executes UI actions, records facts, validates declared conditions, and produces deterministic test assets.
- Maat does **not** invent business truth. Add `expect` assertions only for outcomes explicitly supplied by the user, acceptance criteria, or a trusted existing specification. If no reliable condition exists, report the result as inconclusive rather than manufacturing a pass condition.
- Observation describes actual UI state. Action attempts to change that state. Evidence records what actually occurred. A Case contains the reviewed reusable actions and declared assertions. Fresh-session validation proves that the candidate Case works without relying on exploration state.
- Exploration is model-assisted and stateful. Formal Cases are saved TypeScript/Mocha tests executed by the Maat runner without a model. Diagnostic dumps, locator experiments, and failed attempts are not formal Case steps.
- Computer Use is a capability; verified UI automation is the product. Do not expand Maat into a second model provider, Agent runtime, Case system, Evidence system, or Runner.

## Repository map and ownership

```text
packages/
  core/    Host-neutral MaatApi, Case lifecycle, Workers, Adapters, Runner, SessionPool, Evidence
  pi/      Pi Extension: tools, prompts, setup/status UI, and work-mode policy
  maat/    Standalone Pi-backed TUI, one-shot Agent, CLI, and executable
test/      Observable specifications and regressions, organized by behavior
examples/  Small manually runnable demonstrations; not framework contracts
maat-tests/ Saved example Cases, organized by owner platform and business module
artifacts/ Generated runs, reports, screenshots, attempts, and Evidence; never source code
```

`packages/codex` is **not present in the current baseline**. If a Codex Host is reconsidered, treat it as a new parallel Host package and obtain human agreement on its product shape first; do not infer old experimental Plugin/MCP designs from Git history.

Ownership rules:

- `core` owns the only Case model/renderer/save flow, Evidence contract, exploration protocol, formal Runner, SessionPool, and platform contracts. It must not import Pi, Codex, or another Host SDK.
- Host packages translate their Host API into `MaatApi`; they own Host tools, prompts, UI, authentication integration, and conversation lifecycle, not duplicate business logic.
- An Adapter owns platform conditionals, Session discovery and lifecycle, runtime globals, screenshots, setup hints, and creation of formal test Sessions. Core consumers see `PlatformAdapter`, not platform branches.
- `maat-tests/<owner-platform>/cases/<business-module>/<case-id>.spec.ts` is the single source of truth for a saved Case. A mixed macOS/Web Case belongs to macOS; pure Web belongs to Web.
- Evidence is a factual output of execution. Exploration Evidence lives under `artifacts/cases`; formal run Evidence and HTML reports live under `artifacts/maat/runs/<run-id>`. Do not treat generated artifacts as editable source.
- The Runner executes saved Cases without an LLM. Replay files are successful exploration recordings, not a second formal Case format.

Dependencies point inward: Hosts/CLI → `@houlianpi/maat-core`; Core never points outward to a Host. Reuse the existing API and contracts before adding an abstraction.

### Where contracts live

Maat has no separate schema/RFC system. Confirm a contract in the code that produces and consumes it, the exported package surface, and its regression tests:

- public API: each package's `package.json` exports plus the declarations emitted by `npm run build`;
- formal Case source: Case types/model/renderer/save flow, test Fixture/Runner, and `case-system`/renderer tests;
- Evidence/report behavior: Evidence store, runner/report producer, manifests in real runs, and Evidence/report tests;
- Worker protocol and safety: protocol/client/host together with Worker limit, Abort, exit, and cleanup tests;
- package/install behavior: package manifests, compiled `dist`, and `scripts/check-package.ts`.

Change producer, consumer, fixture, and regression in one review when a contract moves. Documentation explains the product but may drift; verify claims against current source and tests before relying on them. Do not create a schema or second representation merely to document an existing contract.

## Start every task

1. Read this file, `package.json`, and the package/test files for the affected responsibility. Use tests as readable specifications.
2. Inspect `git status`; preserve user changes and unrelated generated files.
3. State the intended module boundary and observable result. For contract/high-risk work, identify the decision requiring human confirmation before editing.
4. Find the nearest existing test and the official command that exercises it. Prefer the shortest feedback loop first.
5. Implement a complete vertical result, including failure and cleanup behavior, rather than stopping at compilation.
6. Run the range of verification required below, inspect actual Evidence/output, then review the final diff from a fresh context.

When a review issue repeats, prefer to encode it in a type or structure, then an automated test/check, and only then this guide or a Skill.

## Official commands

Use repository commands as written; do not invent alternative build or validation systems.

```bash
# Fast, one-file regression while iterating
node --experimental-strip-types --test test/<domain>.test.ts

# Package-focused suites
npm test --workspace @houlianpi/maat-core
npm test --workspace @houlianpi/maat-pi
npm test --workspace @houlianpi/maat

# Repository gates
npm run build
npm run typecheck
npm run format:check
npm test
npm run package:check
```

`npm run typecheck` already builds all workspaces before the root no-emit check. `package:check` builds, packs, installs all three published tarballs in temporary directories, and smoke-tests installed Core, Worker, CLI, Case execution, Pi Extension, and dependency boundaries. Run it whenever exports, manifests, workspace dependencies, `files`, `bin`, compiled paths, packaging, or release behavior changes; source-checkout tests are insufficient.

Package-focused `npm test --workspace ...` commands execute TypeScript source and do not by themselves prove compiled `dist` or install behavior. Use Build/Typecheck for emitted code and `package:check` for consumer-visible packaging. Stale `dist` must never be accepted as evidence that current source works.

Use the actual Maat runner for real saved-Case validation:

```bash
npm run maat:test -- --project web --case <module/case-id> --browser chromium
npm run maat:test -- --project web --suite <suite> --browser chromium
npm run maat:test -- --project android --case <module/case-id> --app-id <package-id>
npm run maat:test -- --project ios --case <module/case-id> --app-id <bundle-id>
```

The native commands require a reachable user-managed Appium Server, installed driver, and suitable device/simulator. Maat creates and deletes only its own Sessions; it does not install drivers or start/stop the Server. If hardware, permissions, signing, Appium, a browser binary, or a model is unavailable, report that validation as inconclusive and state exactly what remains unverified. Never claim platform coverage from mocks alone.

## Change-to-verification map

Run the smallest relevant tests while iterating, then the gates proportional to the change.

| Change area                                               | Required focused verification                                               | Required real or broader verification                                                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Core Case model, renderer, save, Runner, SessionPool      | `case-system`, `playwright-spec-generator`, and relevant `mixed-case` tests | Save a candidate, fresh-session validate it, and rerun the saved Case                                                                |
| Web Adapter / Playwright lifecycle                        | `javascript-session`, `platform-adapter`, affected Case tests               | Controlled local HTML or fixture in a fresh browser; avoid public websites in automated tests                                        |
| Appium Adapter / Android / iOS / macOS                    | `native`, `platform-adapter`, and `mixed-case` tests                        | Real Appium Session on each claimed affected platform; verify App cleanup and that the external Server remains running               |
| Evidence or HTML report                                   | Evidence/report cases in `case-system` plus failure-path tests              | Inspect `evidence.json`, screenshots, missing/degraded states, and `report/index.html`                                               |
| Exploration Worker / protocol                             | `javascript-session` and `exec-js-tool`                                     | Verify state reuse, invalid output, timeout, Abort, early exit, forced cleanup, and idempotent close                                 |
| Pi Extension                                              | `exec-js-tool`, `pi-extension`, `setup-tools`, `setup-ui`, `work-mode`      | Install/run the packed extension when packaging or Host lifecycle changes                                                            |
| Standalone Agent, CLI, TUI, Replay                        | `agent-options`, `agent-trace`, `cli-bin`, `maat-tui`, `run-recorder`       | Run the affected command through `packages/maat/bin/maat.mjs` or installed tarball                                                   |
| Codex Host                                                | No current package or command exists                                        | Stop and agree on Host shape first; if added, require its own package tests and installed-Host smoke without changing Core ownership |
| Packaging, exports, dependency versions, release Workflow | relevant package suite plus Build/Typecheck                                 | `npm run package:check`; validate the actual tarball/install, not only source imports                                                |

For generated Case source, Evidence, reports, Replay, or serialization changes, add an observable regression test. Use repository generators and real execution to update outputs; do not hand-author snapshots or rewrite generated artifacts as the fix.

## Engineering invariants

- Use ESM and strict TypeScript. Source-relative imports include `.ts`; package builds rewrite them. Prefer `unknown` and validation at trust boundaries. Avoid undocumented `any`.
- Organize by runtime responsibility, not generic `utils`/`types` buckets. Avoid speculative abstractions and barrels while modules are small.
- Stateful lifecycle owners may be classes. Use `async`/`await` and `try/finally`; cleanup must be bounded and safe to call more than once. Preserve the original failure when cleanup also fails.
- Model-generated JavaScript is untrusted and runs only in the killable Worker process. The Worker provides timeout, Abort, size/protocol checks, stderr bounds, process-tree termination, and cleanup. It is a **killable boundary, not a security sandbox**; never claim filesystem or network isolation.
- Keep browser/native exploration lifecycle independent from Host conversation lifecycle. The integration layer owns both and closes only resources Maat created.
- Retain App data/login by default. Reset requires explicit user intent. Never put device IDs, signing, credentials, browser profile paths, or local user-data roots in Cases.
- Use the configured company npm registry. Commit `package-lock.json`; runtime dependencies use exact versions. Do not switch registries to bypass installation policy.
- Keep secrets out of source, artifacts, and logs. Trace output goes to stderr, redacts secret-shaped fields, and summarizes image data, but may still contain prompts/UI text and must not be published casually.
- Record a formal step only when successful code is a minimal reusable business action/assertion. If any launch or execution fails, the exploration run is not replayable.

## Agent autonomy and human decisions

Agents may autonomously perform ordinary, reversible implementation inside an agreed module: inspect code, edit source, add focused regressions, run local commands, diagnose failures, and iterate to a reviewable result. Preserve user files and do not broaden platform/product scope.

Stop and request human confirmation before changing any of these contracts:

- the formal Case format, its location, or the single source of truth;
- Evidence trust, mutability, retention, or what counts as verified;
- secret/environment filtering, redaction, or logging safety;
- Worker permissions, isolation boundary, or any “sandbox” claim;
- Core ↔ Host dependency direction or creation of a second Core/Case/Evidence/Runner;
- fresh-session validation semantics or promotion rules;
- supported platforms, required system prerequisites, or ownership of external services;
- a breaking public API, package split/merge, or incompatible saved-Case change;
- destructive device/App data reset, credential/signing changes, or deletion of user assets.

Do not substitute an LLM judgment for these product/contract decisions. Present evidence, alternatives, migration impact, and a recommendation, then wait.

## CI gates versus Agent procedure

Current CI enforces `npm ci`, Playwright Chromium installation, Build/Typecheck, formatting, `npm test`, `package:check`, Core/Pi dependency checks, and the repository Web smoke Suite. Release CI repeats source/package checks and publishes Core → Pi Extension → standalone Maat with npm Trusted Publishing.

The following are Agent work procedures, not automated guarantees: selecting focused tests, running real devices/platforms, inspecting Evidence and reports, checking failure paths, fresh-context diff review, reporting inconclusive validation, and escalating high-risk decisions. Do not say “CI proves” any of these unless an actual gate does. Existing Web smoke Cases may contact a public site; new automated browser regressions must use controlled local content.

There is currently no repository benchmark/main-vs-branch command, live-device CI gate, verification Skill, PR shipping Skill, or review-babysitting automation. Do not claim those workflows exist. For performance or reliability claims, collect explicit before/after behavior, counters, and timings with a reproducible manual procedure, label noisy results inconclusive, and propose automation separately rather than embedding an invented command here.

## Definition of Done

Before handing ordinary implementation to a human reviewer:

- focused tests pass and cover the observable success/failure or cleanup behavior changed;
- required Build/Typecheck/format checks pass;
- the actual user path is exercised through Maat, not only through direct unit calls;
- Evidence, report output, and relevant failure/degradation paths are inspected;
- packaging changes pass `package:check` and installed artifacts are exercised;
- platform/device claims are backed by that real platform, otherwise marked **inconclusive**;
- `git diff` and `git status` are reviewed from a fresh context for scope, generated files, secrets, and user changes;
- the final report states commands run, observed results, unverified areas, and any human decision still required;
- no claim is made for a build, Case, device, Session, report, package, push, PR, CI result, or release that did not actually complete.

The completed result should be directly reviewable: no known in-scope work remains, and any external blocker is concrete rather than hidden behind “tests passed.”
