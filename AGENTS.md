# Maat development guide

Maat is a TypeScript project for conversational, cross-platform UI verification. Its current Web adapter uses the Pi SDK and Playwright. Keep the design explicit and incremental: Pi owns the model/session loop; Maat owns UI state, tool boundaries, worker isolation, Cases, Evidence, and observations.

## Project structure

```text
src/
  agent/       Pi session orchestration; no CLI argument parsing
  browser/     Persistent Playwright lifecycle and browser helpers
  cli/         Executable entry points; parse input and set exit codes
  tools/       Pi custom-tool adapters (add when the first tool exists)
  worker/      Untrusted-code process boundary (add with worker isolation)
  cases/       Natural-language Case metadata, clean validation, persistence, and batch execution
  tui/         Pi InteractiveMode host and long-lived conversational state
examples/      Small, manually runnable demonstrations
test/          Automated tests, mirroring the source domains
artifacts/     Generated screenshots and run records; never source code
bin/           Thin package executables; dispatch only, with no business logic
```

- Organize by runtime responsibility, not by generic categories such as `utils` or `types`.
- Do not create a directory until code for that responsibility exists.
- Keep dependencies pointing inward: `cli -> agent/tools -> browser`; browser code must not import Pi or CLI modules.
- Avoid barrel `index.ts` files while modules are few. Import the defining module directly.

## TypeScript conventions

- Use ESM and strict TypeScript. Local imports include the `.ts` extension because this project runs source directly with Node's type stripping.
- Prefer `type` imports and `type` aliases for data shapes. Use classes only for stateful lifecycle owners such as `BrowserRuntime`.
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

Run `npm run browser:demo` when browser lifecycle code changes.

## Dependencies and generated files

- Use the configured company npm registry. Do not override it with the public registry.
- Commit `package-lock.json` and use exact versions for runtime dependencies.
- Never commit `.env`, credentials, `node_modules`, screenshots, or run artifacts.
- Keep Pi authentication and model selection in Pi's normal configuration; do not copy secrets into this repository.
- Maat TUI reuses Pi credentials and copies the initial model selection once, but persists its own Settings and Sessions under `~/.maat/`; Skills, Extensions, prompt templates, and project context remain disabled.
- Never persist browser user-data/profile paths in manifests or generated Replay source. Accept them only as runtime CLI arguments.
- Reject installed browsers' default user-data roots for automation. Chromium-family browsers disable remote debugging there; use a dedicated automation profile.
- Trace logs go to stderr, redact secret-shaped fields, and summarize image payloads. They may still contain user prompts and webpage text, so do not publish them.
- Exploration and non-interactive Agent runs may produce Replay files from successfully executed `exec_js` code. Preserve step order and the shared browser/context/page lifecycle.
- If any browser launch or `exec_js` execution fails in a Replay run, mark the whole run non-replayable. Formal saved Cases always use Playwright Test `case.spec.ts`.
- Generate `expect` assertions only for outcomes stated in the user's test objective, expected result, or acceptance criteria. Do not assert every operational prerequisite.
- A saved Case has one source of truth: a descriptively named Playwright `<case-id>.spec.ts`. Organize files freely under business/module directories; keep natural-language intent in leading JSDoc and selection data in Playwright tags. Runtime Evidence remains under `artifacts/`.

## Scope and safety

- Model-generated JavaScript is untrusted and must run in the worker process, never in the Pi/CLI process.
- The worker boundary provides killability and resource cleanup, not a security sandbox. Do not claim filesystem or network isolation without an OS/container boundary.
- Preserve timeout, abort, code-size, output-size, protocol validation, and forced-cleanup tests when changing the worker.
- Keep the persistent browser lifecycle independent from the Pi session lifecycle. The integration layer owns and closes both.
