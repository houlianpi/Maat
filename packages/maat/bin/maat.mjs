#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const command = args[0];

const help = `Maat - UI execution for Coding Agents

Usage:
  maat                         Start the interactive TUI
  maat tui                     Start the interactive TUI
  maat agent [options] PROMPT  Run one non-interactive task
  maat help                    Show this help

Examples:
  maat
  maat agent --browser edge --headed "Test Edge"
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
  default:
    process.stderr.write(`Unknown command: ${command}\n\n${help}`);
    process.exit(1);
}

const child = spawn(process.execPath, [path.resolve(packageRoot, script), ...forwardedArgs], {
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
