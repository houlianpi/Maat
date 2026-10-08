import assert from 'node:assert/strict';
import test from 'node:test';

import { browserChannel } from '../packages/core/src/platforms/web/config.ts';
import { parseAgentOptions } from '../packages/maat/src/cli/agent-options.ts';

test('agent CLI maps Edge to the Playwright msedge channel', () => {
  const options = parseAgentOptions(['--browser', 'edge', '--headed', 'test Edge new tab']);

  assert.equal(options.browser, 'edge');
  assert.equal(options.headless, false);
  assert.equal(browserChannel(options.browser), 'msedge');
  assert.equal(options.prompt, 'test Edge new tab');
});

test('agent CLI accepts headless Chrome Beta', () => {
  const options = parseAgentOptions(['--browser=chrome-beta', '--headless', 'test beta']);

  assert.equal(options.browser, 'chrome-beta');
  assert.equal(options.headless, true);
  assert.equal(browserChannel(options.browser), 'chrome-beta');
});

test('agent CLI rejects conflicting browser options', () => {
  assert.throws(
    () => parseAgentOptions(['--browser', 'edge', '--executable-path', '/tmp/edge', 'prompt']),
    /only be used with --browser chromium/,
  );
});

test('agent CLI accepts an explicit persistent profile', () => {
  const options = parseAgentOptions([
    '--browser',
    'edge',
    '--user-data-dir',
    '/tmp/edge-profile',
    '--profile-directory',
    'Default',
    '--headed',
    'test signed-in new tab',
  ]);

  assert.equal(options.userDataDir, '/tmp/edge-profile');
  assert.equal(options.profileDirectory, 'Default');
});

test('agent CLI requires user data dir for a profile directory', () => {
  assert.throws(
    () => parseAgentOptions(['--profile-directory', 'Default', 'prompt']),
    /requires --user-data-dir/,
  );
});

test('agent CLI rejects the browser default user-data directory', () => {
  if (process.platform !== 'darwin') return;
  assert.throws(
    () =>
      parseAgentOptions([
        '--browser',
        'edge',
        '--user-data-dir',
        `${process.env.HOME}/Library/Application Support/Microsoft Edge`,
        'prompt',
      ]),
    /disables remote debugging/,
  );
});
