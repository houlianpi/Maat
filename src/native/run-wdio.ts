import { Launcher } from '@wdio/cli';

// Separate runner process keeps WDIO logging and globals out of the Pi TUI.
const [config, serialized] = process.argv.slice(2);
try { process.exit((await new Launcher(config, JSON.parse(serialized)).run()) ?? 1); }
catch (error) { console.error(error); process.exit(1); }
