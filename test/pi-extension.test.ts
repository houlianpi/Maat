import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import maatPiExtension from '../src/hosts/pi/extension.ts';

test('Pi Extension registers the complete Maat tool surface and lifecycle', () => {
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
    'begin_case',
    'save_case',
    'list_evidence',
    'select_platform',
    'configure_session',
    'configure_browser',
    'set_work_mode',
  ]) {
    assert.ok(tools.includes(name), `${name} was not registered`);
  }
  assert.ok(commands.includes('maat-status'));
  assert.ok(commands.includes('mode'));
  assert.ok(events.includes('session_shutdown'));
  assert.ok(events.includes('before_agent_start'));
});
