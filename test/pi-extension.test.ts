import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import maatPiExtension from '../packages/pi/src/extension.ts';

test('Pi Extension registers execution/setup tools without legacy workflow tools', () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const pi = {
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    on(event: string) {
      events.push(event);
      return () => {};
    },
  } as unknown as ExtensionAPI;

  maatPiExtension(pi);

  for (const name of [
    'exe_js',
    'check_platform_setup',
    'check_device_ready',
    'open_setup_step',
    'retry_setup_step',
    'continue_without_capability',
    'select_platform',
    'configure_session',
    'configure_browser',
  ]) {
    assert.ok(tools.includes(name), `${name} was not registered`);
  }
  assert.ok(commands.includes('maat-status'));
  assert.ok(commands.includes('maat-setup'));
  assert.ok(commands.includes('maat-doctor'));
  for (const name of ['begin_case', 'save_case', 'list_evidence', 'set_work_mode'])
    assert.equal(tools.includes(name), false);
  assert.equal(commands.includes('mode'), false);
  assert.equal(events.includes('user_bash'), false);
  assert.ok(events.includes('session_shutdown'));
  assert.ok(events.includes('before_agent_start'));
});
