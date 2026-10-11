# @houlianpi/maat

Standalone Maat TUI, Agent, and CLI. Install globally with `npm install -g @houlianpi/maat`.

`maat` starts the Pi-backed TUI and `maat agent` runs a one-shot Web task.
The setup Skill is included without loading unrelated Pi customizations.
Formal test/Case/Replay commands and recording have been removed; use `maat help`
for the current command surface. Observations are not business validation.

The one-shot Web Agent currently exposes only `exe_js`, unlike the interactive
Pi/TUI host tools. It is not advertised as supporting autonomous environment
preparation; use the interactive entry for setup work.
