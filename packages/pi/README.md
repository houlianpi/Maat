# @houlianpi/maat-pi

Pi coding-agent extension for Maat. Install with `pi install npm:@houlianpi/maat-pi`.

## Android setup and Mobile Use

The package ships the `maat-setup` Skill alongside its extension. Ask the host
Agent to prepare an Android phone, or select Android and run `/maat-setup`.
`/maat-doctor` and `check_platform_setup` diagnose preparation; `check_device_ready`
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
