#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const command = args[0];

const help = `Maat - conversational UI verification

Usage:
  maat                         Start the interactive TUI
  maat tui                     Start the interactive TUI
  maat agent [options] PROMPT  Run one non-interactive task
  maat test [options]          Run saved Maat/Mocha Cases
  maat cases [options]         Compatibility alias for maat test
  maat replay FILE [options]   Run a saved Replay or Case test
  maat help                    Show this help

Examples:
  maat
  maat agent --browser edge --headed "Test Edge"
  maat test --suite smoke
  maat test --project android --suite smoke
  maat test --project android --case edge-exit-browser-cancel --app-id com.microsoft.emmx
  maat test --project android --case edge-exit-browser-cancel --app-id com.microsoft.emmx.canary
  maat test --project web --browser edge --suite smoke
  maat test --case calculator-basic-addition --headed
`;

if (command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(help);
  process.exit(0);
}

let script;
let forwardedArgs;
switch (command) {
  case undefined:
  case 'tui':
    script = 'dist/hosts/tui/main.js';
    forwardedArgs = args.slice(command === 'tui' ? 1 : 0);
    break;
  case 'agent':
    script = 'dist/cli/agent.js';
    forwardedArgs = args.slice(1);
    break;
  case 'cases':
  case 'test':
    script = 'dist/cli/cases.js';
    forwardedArgs = args.slice(1);
    break;
  case 'replay': {
    const replayPath = args[1];
    if (!replayPath) {
      process.stderr.write('Usage: maat replay FILE [options]\n');
      process.exit(1);
    }
    script = replayPath;
    forwardedArgs = args.slice(2);
    break;
  }
  default:
    process.stderr.write(`Unknown command: ${command}\n\n${help}`);
    process.exit(1);
}

const runtimeArgs =
  command === 'replay'
    ? ['--import', import.meta.resolve('tsx'), script]
    : [path.resolve(packageRoot, script)];
const child = spawn(process.execPath, [...runtimeArgs, ...forwardedArgs], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.once('error', (error) => {
  process.stderr.write(`Failed to start Maat: ${error.message}\n`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
