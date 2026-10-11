# @houlianpi/maat-pi

Pi coding-agent extension for Maat. Install with `pi install npm:@houlianpi/maat-pi`.

## Android setup and Mobile Use

The package ships internal `maat-setup` and `mobile-use` workflows alongside its
extension without adding `skill:*` commands. Ask the host Agent to prepare an
Android phone, or select Android and run `/maat-setup`, the only Maat command.
Setup reports distinguish computer-side preparation from a verified phone
channel. Multi-step phone work uses bounded scrolling and treats each `exe_js`
call as isolated.
Execution failures return a model-visible category, phase, Session state and
action certainty. Compile failures can be corrected; runtime or timeout failures
require a fresh read of current UI state and are never replayed automatically.
Maat tool failures remain error tool results inside the Pi Agent loop; they do
not terminate the host Pi Session, so the model can recover in the same turn or
the user can continue with a later message.
`check_platform_setup` and `get_setup_diagnostics` diagnose preparation; `check_device_ready`
checks the actual phone channel and returns observations.

The host Agent handles authorized installation, configuration and startup with
its existing tools. Maat does not start or stop external services. Shell and file
tools remain available under host permissions; there is no Maat work mode.

The old Case/recording/report tools were removed. `exe_js` accepts only `code`
and returns observations; it does not save a formal test.

The Skill's bundled `scripts/android-tools.mjs` offers read-only `status`, explicit
`prepare`, authorized ADB startup and foreground `appium` commands. Prepared tools become visible to the
same running Pi process; the launcher supplies their environment to Appium without
asking users to export SDK variables. Downloads of official platform-tools require
actual license acceptance. Existing services and global configuration are preserved.
