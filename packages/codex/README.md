# Maat Codex Plugin

Local Codex plugin for Maat. It bundles focused Skills and a local stdio Tool Server backed by `@houlianpi/maat-core`. The server runs in the current Codex workspace and does not listen on a network port.

## Local development

From the repository root:

```bash
npm install
npm run plugin:stage
codex plugin marketplace add .
codex plugin add maat@maat-local
```

Start a new Codex chat in one local workspace after installation. The Tool Server requests that workspace root from Codex; set `MAAT_WORKSPACE_ROOT` only for clients that do not provide roots.
