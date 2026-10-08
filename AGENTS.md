# Maat development guide

Maat is a TypeScript project for conversational UI verification. Exploration uses a shared killable Worker harness with platform runtimes. Saved Cases use one Mocha format and may mix Playwright Library with WebdriverIO/Appium Sessions. Keep official clients; do not replace them with custom W3C clients or Python bridges.

## Project structure

```text
packages/
  core/         Host-neutral API, Case, Workers, Adapters, Runner, SessionPool and Evidence
  pi/           Pi Extension, tools, prompt, work mode and status UI
  maat/         Standalone Pi-backed Agent/TUI and thin CLI executable
examples/      Small, manually runnable demonstrations
test/          Automated tests, mirroring the source domains
artifacts/     Generated screenshots and run records; never source code
```

- Organize by runtime responsibility, not by generic categories such as `utils` or `types`.
- Do not create a directory until code for that responsibility exists.
- Dependencies point inward: Host packages and standalone Maat depend on `maat-core`; Core never imports a Host SDK. Future Host integrations are parallel workspace packages.
- Avoid barrel `index.ts` files while modules are few. Import the defining module directly.

## TypeScript conventions

- Use ESM and strict TypeScript. Local imports include the `.ts` extension because this project runs source directly with Node's type stripping.
- Prefer `type` imports and type aliases for data shapes. Use classes only for stateful lifecycle owners such as SessionPool or Adapter managers.
- Prefer `unknown` at trust boundaries and validate before use. Do not introduce `any` without a documented interoperability reason.
- Keep public APIs small. Internal Playwright handles stay private unless a caller genuinely needs them.
- Name files in kebab-case, types/classes in PascalCase, and values/functions in camelCase.
- Use `async`/`await` and `try/finally` for owned resources. Cleanup methods must be safe to call more than once.
- Do not hide failures. Convert provider, worker, and browser failures into actionable errors and preserve their cause when useful.
- Avoid speculative abstractions. Extract shared code only after a second real use appears.

## Testing

- Put tests under `test/` and mirror the source domain in their filename.
- Test observable behavior and lifecycle guarantees rather than private implementation details.
- Browser tests should use local HTML or controlled fixtures, not public websites.
- Every owned resource must be closed in `finally`, even when an assertion fails.
- Add regression tests for concurrency, timeout, abort, output limits, and cleanup as those capabilities are introduced.

Run the full local verification before handing off changes:

```bash
npm run typecheck
npm test
```

Run the exploration and mixed-Case tests when Session lifecycle code changes.

## Dependencies and generated files

- Use the configured company npm registry. Do not override it with the public registry.
- Commit `package-lock.json` and use exact versions for runtime dependencies.
- Never commit `.env`, credentials, `node_modules`, screenshots, or run artifacts.
- Keep Pi authentication and model selection in Pi's normal configuration; do not copy secrets into this repository.
- Maat TUI reuses Pi credentials and copies the initial model selection once, but persists its own Settings and Sessions under `~/.maat/`; Skills, Extensions, prompt templates, and project context remain disabled.
- Never persist browser user-data/profile paths in manifests or generated Replay source. Accept them only as runtime CLI arguments.
- Reject installed browsers' default user-data roots for automation. Chromium-family browsers disable remote debugging there; use a dedicated automation profile.
- Trace logs go to stderr, redact secret-shaped fields, and summarize image payloads. They may still contain user prompts and webpage text, so do not publish them.
- Exploration and non-interactive Agent runs may produce Replay files from successfully executed `exe_js` code. Preserve step order and the active Adapter Session lifecycle.
- If any launch or `exe_js` execution fails in a Replay run, mark the whole run non-replayable. Formal Cases use the selected Adapter runner.
- Generate `expect` assertions only for outcomes stated in the user's test objective, expected result, or acceptance criteria. Do not assert every operational prerequisite.
- A saved Case has one source of truth under `maat-tests/<owner-platform>/cases/<business-module>`. Steps record Adapter IDs in order; macOS/Windows-owned Cases may mix Web steps.
- Formal Evidence and the Maat HTML report live under `artifacts/maat/runs/<run-id>`. Web trace may be added as Adapter Evidence.

## Scope and safety

- Model-generated JavaScript is untrusted and must run in the worker process, never in the Pi/CLI process.
- The worker boundary provides killability and resource cleanup, not a security sandbox. Do not claim filesystem or network isolation without an OS/container boundary.
- Preserve timeout, abort, code-size, output-size, protocol validation, and forced-cleanup tests when changing the worker.
- Keep the persistent browser lifecycle independent from the Pi session lifecycle. The integration layer owns and closes both.
- Maat Core depends only on PlatformAdapter and PlatformRegistry. Platform conditionals, Session discovery, framework globals, save/validation, runner, status, and platform-specific tools belong in adapters. `exe_js` is the single JavaScript execution tool; future language executors such as `exe_py` remain separate tools.
- `maat-tests` contains Cases only. Optional local Appium Session hints live under `~/.maat/session-hints/`, never in the repository. Never put device IDs or signing into Case source.
- Maat does not install drivers or start/stop Appium Server. Agent/Shell/user setup provides a reachable Server; Maat creates and deletes only its own Sessions. Retain app data by default; resetting requires explicit user intent.
- TUI assist mode permits Pi shell/read/edit/write for auxiliary work. Case exploration/generation enters case mode, blocking shell (including manual `!`/`!!`) and direct edit/write tools. Read-only inspection remains available. Failed saves retain the guard; successful saves return to assist. `/mode assist` explicitly pauses the workflow without clearing its draft; model-requested transitions to assist require user confirmation. This is a tool workflow guard, not an OS sandbox.
