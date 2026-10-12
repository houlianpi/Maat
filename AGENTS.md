# Maat agent development guide

Keep this file focused on navigation, ownership, safety and review decisions.
Product intent and confirmed decisions live in the [product baseline](docs/product/maat-product-spec.md).
The first approved user task is [mobile content search](docs/specs/mobile/content-search.md).
Device migration gates, resource ownership and deletion authorization live in the
[approved technical design](docs/maat-mvp-technical-design.md).
Spec approval is not proof of implementation or validation.
Product usage belongs in the [README](README.md) and [Chinese README](README.zh-CN.md);
executable contracts belong in exported types and tests. Preparation details live in
[Setup Assistant](docs/setup-assistant.md) and [native setup](docs/native-testing.md).

## Core philosophy

Maat supplies real UI observation and execution to a host Coding Agent. Android
and iOS share the Mobile Use workflow; Web and macOS execution remain available.

- **The user declares intent; the LLM chooses the operation.** The host LLM reads
  current UI facts, selects locators and generates Appium JavaScript for each action.
  Do not embed App-specific navigation, collection or business decision scripts in
  the product. Deterministic regression tests are not a product operation path.
- **UI interaction goes through `exe_js`.** Its model-generated code runs in the
  existing killable Worker and platform runtime. Do not substitute host-shell phone
  commands, direct WDA/Appium requests, temporary phone clients or a parallel
  operation channel. Host tools remain available for authorized preparation and
  platform-native non-UI work, including Android `adb push`/`adb pull` file transfers.
  Preserve platform differences; shared UI strategy does not remove Android features.
- **Skills contain strategies, not another operator.** Put targeting priorities,
  observation timing, list-reading boundaries, recovery and authorization guidance
  in the [Mobile Use Skill](packages/pi/skills/mobile-use/SKILL.md). Do not add
  another planner, installer Agent, runtime or generic service manager.
- **Infrastructure remains deterministic.** Discovery, dependency/signing checks,
  tracked preparation, Session lifecycle, readiness observations, screenshots,
  timeouts and cleanup are Maat responsibilities, not App business decisions.
- A responding service, ready Session or successful action is not business validation.
  Do not invent expectations or claim an observed result proves more than it does.
- Case/Draft generation, formal Runner/SessionPool, reports, Replay recording and
  work modes were removed. Do not rebuild them or compatibility layers.

## Controls first; vision only when necessary

1. Through `exe_js`, obtain the current UI tree and query visible, unambiguous
   controls with the selected adapter's supported APIs. Use control locators for
   clicks and input; inspect an available list/container before choosing a gesture.
2. Use vision and absolute coordinates only when the JS interface cannot reliably
   obtain the tree, or the requested target genuinely has no usable controls.
   A bad selector, incomplete extraction, parsing mistake or truncated tree does
   not establish that an App has no controls. A screenshot can clarify content
   without abandoning a reliable control locator.
3. State the concrete reason for coordinate fallback. Let the LLM identify the
   target in a current screenshot and generate the Appium JS, still through
   `exe_js`. Do not introduce a separate visual operator or recognition runtime.
4. Absolute coordinates use the current Appium viewport units, not displayed
   screenshot pixels. Account for image scaling and rotation; after a UI change,
   obtain current state before reusing coordinates. Return to controls when usable.

These are selection strategies, not a fixed tap/scroll algorithm. Never use an
unavailable screenshot, unknown device state or connection failure as permission
to click blindly.

## Repository ownership

```text
packages/core/  Host-neutral API, Worker, adapters and platform preparation primitives
packages/pi/    Pi tools, host-owned preparation tasks, Skills and UI
packages/maat/  Standalone Pi-backed TUI, one-shot Agent and executable
test/          Observable specifications and regressions
artifacts/     Generated output, never editable source
```

- Dependencies point inward: Hosts/CLI -> Core. Core never imports a Host SDK.
- Adapters own platform conditionals, connection discovery, Session lifecycle,
  runtime globals and screenshots. Consumers use the platform contract.
- The native `evidence.screenshot()` helper returns an in-memory image observation;
  it is not a formal Evidence store.
- Pi supplies SDK dependencies; avoid installing a second Host SDK inside the extension.
- `.github/agents/` contains the development squad. Do not remove customization or
  historical assets as incidental cleanup.
- `maat-tests/` contains retained historical assets, not current executable tests.
  Preserve those files; they are excluded from the root typecheck.

## Shared collaboration protocol

- **Entry and responsibility.** The user works through Tech Lead, the sole normal
  coordination node. Lead owns architecture, scope, dependencies, orchestration,
  integration validation and final delivery. Default to delegation-first: PM handles
  requirements and AC; Designer handles product interaction when needed; Developer
  handles bounded technical investigation, implementation and related tests/docs;
  Reviewer independently reviews requirements, actual changes and risk. Lead
  delegates substantive analysis, design, implementation and risk review rather
  than doing everything. Simple answers and tiny work needing no independent
  handoff may be handled directly; do not require every role or a fixed parallel count.
  Without subagent capability, Lead must disclose the limitation and request
  permission for direct implementation, not simulate delegation or silently take over.
  Every direct-implementation exception states its reason, scope and validation
  arrangements; it does not waive required independent review.
- **Autonomous execution.** Once scope, AC, dependencies and authorization are
  settled, Lead proceeds through delegation, implementation, tests, review,
  fixes and local delivery-baseline commits without asking whether each routine
  step should happen. Keep the user informed; seek decisions for unapproved scope,
  major architecture/Gate changes, public API/privacy boundaries or other
  human-confirmation matters below. Autonomy does not waive AC or review, nor
  grant remote-push, release or device-operation authorization.
- **One task package.** Every handoff includes a traceable TaskID and fixed-version
  requirement/design/AC references (commit + path/section, or content hash for
  uncommitted content); implementation HEAD does not substitute for Spec versions.
  Include branch, HEAD and worktree status (including existing changes); goal
  and non-goals; allowed files and forbidden boundaries; dependencies and entry
  conditions; applicable official validation commands; required evidence, stop
  conditions and who decides escalations. Mark unresolved/not-applicable fields
  explicitly. Without an authorized ledger, disclose a temporary TaskID and the
  persistence gap, request authorization, and never invent a GitHub number or
  create another system. Do not assume shared chat context.
- **Ready and Done.** PM recommends team-task Ready; Lead decides it only when
  scope, AC, dependencies, exclusive file ownership and necessary authorization
  are settled. Task Ready is not phone `ready` or proof of device readiness.
  Developer delivers **pending review**,
  never self-declares Done. Reviewer reads the original Spec, approved design and
  actual diff, including applicable product/technical gates, not just summaries,
  and gives a review conclusion.
  High-risk work requires independent review; a self-check is not a substitute.
  Lead decides Done using review, required tests and real-path evidence appropriate
  to the AC/risk. Requirement/design approval is not implementation or acceptance.
  Done authority cannot waive AC, safety gates or unresolved important review
  findings; escalate major disagreements to the user, never lower the standard.
- **Scheduling and rework.** Each Developer has one implementation task at a time.
  Assign exclusive file ownership; never run same-file implementation in parallel.
  Only independent scopes may run concurrently; do not start dependent
  implementation before its prerequisites are met. Reviewer findings return to
  the original Developer; review fixes again according to risk. If a loop makes no
  progress, stop it and report the blocker with owner, next step, resume conditions
  and decision needed rather than repeating it.
- **Stop and clarify.** Waiting for user unlock, authentication, authorization or
  requirement clarification is a blocker, not permission to guess or bypass.
  Route questions through Lead. Requirement changes must first be approved and
  reflected in the authoritative Spec/AC before implementation resumes.
  Record old/new requirement version references and impacts on AC, design,
  in-flight tasks and validation in the authorized source.
  Major product, security, permission, destructive-operation, public-API, platform
  and deletion-boundary decisions still require user approval.
- **Durable truth and status.** Existing product/feature Specs and approved designs
  are the permanent requirement truth; GitHub Issues/PRs are the execution-status
  and delivery/review-evidence carrier once authorized and established.
  Lead persists PM/Designer/Reviewer outputs in those
  existing sources within authorization, without a shadow requirement system or
  new process/report/plan Markdown by default. Chat and session todos are not the
  team's long-term ledger. If Issue/PR tracking is not established or persistence
  is unavailable/unauthorized, explicitly report the record-keeping gap and
  request authorization to establish the needed carrier; do not create a record
  system without approval, invent IDs, claim persistence or substitute shadow
  Markdown. Read-only roles return structured content for Lead to persist.
- **One delivery package.** Every role returns the TaskID, completed items, actual
  scope and delivery version (committed revision, or explicit baseline + inspectable
  diff for uncommitted work; never claim an unmade commit). List every applicable
  AC individually as pass/fail/unverified/blocked with evidence, and identify the
  version covered by validation. Include actual commands/results (or not run),
  unverified paths, limits, blockers (owner, next step, resume conditions) and who
  must decide. Role-specific findings supplement this package. Lead consolidates
  it, retaining failures and separately versioned post-fix checks, and distinguishes
  review, validation and business completion.
- **Authority and safety.** Role tools are capabilities, not device-operation
  authorization, and never override this guide's safety or human-confirmation
  boundaries. PM/Designer/Reviewer stay read/search-only; Developer uses
  read/search/edit/execute/todo without nested delegation. Lead retains its existing
  tools and agent whitelist for coordination, validation and authorized persistence.

## Working procedure

1. Read this file, relevant confirmed product/task requirements, package manifests,
   affected producers, exports, consumers and
   nearest tests. When the user names a reference project, inspect its relevant
   workflow and implementation, not just its README; adapt the strategy without
   copying another runtime or violating Maat's boundaries.
2. Inspect Git status and integrate user changes; do not revert unrelated work.
3. State the observable result and module boundary. Escalate decisions below before editing.
4. Follow the [shared collaboration protocol](#shared-collaboration-protocol).
   Implement success, failure, observation and cleanup behavior together; PM's
   acceptance analysis and Reviewer's independent review are not ceremonial approval.
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
- Native execution: `native`, `platform-adapter`, `android-setup`, `ios-setup`.
- Preparation: `android-tools`, `ios-wda`, `mobile-preparation`, `setup-assistant`,
  `setup-tools`, `android-setup-tools`, `setup-ui`, `setup-skill`, `setup-model-context`.
- Hosts/CLI: `pi-extension`, `pi-session-isolation`, `mobile-ui`, `maat-tui`,
  `cli-bin`, `agent-options`, `agent-trace`.

Use controlled local browser content. Mock Appium proves contracts, not platform
coverage. Real native claims require actual Appium and a real device or simulator;
do not substitute one platform for another. Distinguish scripted device checks,
controlled Pi/LLM runs and full first-use acceptance. Missing prerequisites leave
that path unverified. Stay within the user's task authorization; sends, purchases,
deletes, authentication and destructive changes require explicit intent.

## Engineering and safety

- Use ESM, strict TypeScript and source-relative `.ts` imports. Validate `unknown`.
- Reuse existing APIs; avoid generic utilities or speculative layers.
- Cleanup is bounded, idempotent and attempts owned resources. Preserve the primary
  error when supplemental diagnosis or cleanup fails.
- Model code runs only in the Worker with timeout, Abort, protocol/output limits,
  stderr bounds and process-tree termination. It is not a filesystem/network sandbox.
- Do not release the device merely because a model turn ends. Keep its Session
  while awaiting a user-only step if phone work remains; release when the task or
  conversation no longer needs it. Close only owned resources, never user services.
- Preserve App data/login. Reset requires explicit intent. Do not change native
  App-close semantics incidentally.
- Recovery rereads current state; never replay a potentially executed action.
- Only explicitly read-only internal probes may retry within a defined budget.
  Arbitrary `exe_js` is potentially mutating and must never be automatically replayed.
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

Use the [shared delivery package](#shared-collaboration-protocol).
Name the changes, commands and actual results. State device/Host paths not exercised,
environment blockers and outstanding decisions. Never claim a completed build,
installed package, Session, UI result, CI run or release without evidence.
Preserve failed attempts and label post-fix or recovery checks separately; do not
retroactively turn an earlier failed acceptance into a pass. CI checks source and
package gates; it does not provide live-device or real-LLM user-flow coverage.
