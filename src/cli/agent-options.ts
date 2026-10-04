import { parseArgs } from 'node:util';
import path from 'node:path';

import { parseBrowserName, type BrowserName } from '../platforms/web/config.ts';

export type AgentCliOptions = {
  browser: BrowserName;
  executablePath?: string;
  headless: boolean;
  profileDirectory?: string;
  prompt: string;
  userDataDir?: string;
};

const macOSDefaultUserDataDirs: Partial<Record<BrowserName, string>> = {
  chrome: 'Library/Application Support/Google/Chrome',
  'chrome-beta': 'Library/Application Support/Google/Chrome Beta',
  edge: 'Library/Application Support/Microsoft Edge',
  'edge-beta': 'Library/Application Support/Microsoft Edge Beta',
};

function rejectDefaultUserDataDir(browser: BrowserName, userDataDir: string | undefined): void {
  if (!userDataDir || process.platform !== 'darwin') return;
  const relativeDefault = macOSDefaultUserDataDirs[browser];
  if (!relativeDefault) return;
  const defaultPath = path.resolve(process.env.HOME ?? '', relativeDefault);
  if (path.resolve(userDataDir) === defaultPath) {
    throw new Error(
      `Cannot automate the default ${browser} user-data directory because the browser disables remote debugging there. ` +
        'Use a dedicated automation --user-data-dir and sign in to it once.',
    );
  }
}

export function parseAgentOptions(args: string[]): AgentCliOptions {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      browser: { type: 'string', default: 'chrome' },
      'executable-path': { type: 'string' },
      headless: { type: 'boolean' },
      headed: { type: 'boolean' },
      'profile-directory': { type: 'string' },
      'user-data-dir': { type: 'string' },
    },
    strict: true,
  });

  if (values.headless && values.headed) {
    throw new Error('Use only one of --headless and --headed.');
  }

  const browser = parseBrowserName(values.browser);
  if (values['executable-path'] && browser !== 'chromium') {
    throw new Error('--executable-path can only be used with --browser chromium.');
  }
  if (values['profile-directory'] && !values['user-data-dir']) {
    throw new Error('--profile-directory requires --user-data-dir.');
  }
  rejectDefaultUserDataDir(browser, values['user-data-dir']);

  const prompt = positionals.join(' ').trim();
  if (!prompt) {
    throw new Error(
      'Usage: npm run agent -- [--browser edge] [--user-data-dir <path>] [--profile-directory Default] [--headless|--headed] "your prompt"',
    );
  }

  return {
    browser,
    executablePath: values['executable-path'],
    headless: values.headless ?? false,
    profileDirectory: values['profile-directory'],
    prompt,
    userDataDir: values['user-data-dir'],
  };
}
