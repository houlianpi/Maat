import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import maatPiExtension from '../packages/pi/src/extension.ts';
import { MAAT_SYSTEM_PROMPT } from '../packages/pi/src/system-prompt.ts';

test('Pi Extension registers execution/setup tools without legacy workflow tools', () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const pi = {
    registerFlag() {},
    getFlag(name: string) {
      assert.equal(name, 'maat-mobile-ui');
      return false;
    },
    registerMessageRenderer() {},
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
    'release_device_session',
    'check_platform_setup',
    'check_device_ready',
    'prepare_mobile',
    'open_setup_step',
    'retry_setup_step',
    'continue_without_capability',
    'select_platform',
    'configure_session',
    'configure_browser',
  ]) {
    assert.ok(tools.includes(name), `${name} was not registered`);
  }
  assert.ok(commands.includes('maat-setup'));
  assert.equal(commands.includes('maat-status'), false);
  assert.equal(commands.includes('maat-doctor'), false);
  for (const name of ['begin_case', 'save_case', 'list_evidence', 'set_work_mode'])
    assert.equal(tools.includes(name), false);
  assert.equal(commands.includes('mode'), false);
  assert.equal(events.includes('user_bash'), false);
  assert.ok(events.includes('session_shutdown'));
  assert.ok(events.includes('before_agent_start'));
});

test('mobile renderers activate after Pi applies command-line flags', async () => {
  let enabled = false;
  const tools: Array<{ name: string; renderCall?: unknown }> = [];
  const handlers = new Map<string, Function[]>();
  const pi = {
    registerFlag(name: string, options: { description: string; default: boolean }) {
      assert.equal(name, 'maat-mobile-ui');
      assert.equal(options.description, 'Compact Maat tool cards and concise status');
      assert.equal(options.default, false);
    },
    getFlag(name: string) {
      assert.equal(name, 'maat-mobile-ui');
      return enabled;
    },
    registerMessageRenderer() {},
    registerTool(tool: { name: string; renderCall?: unknown }) {
      tools.push(tool);
    },
    registerCommand() {},
    on(name: string, handler: Function) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  } as unknown as ExtensionAPI;
  maatPiExtension(pi);
  assert.equal(tools.find((tool) => tool.name === 'exe_js')?.renderCall, undefined);
  enabled = true;
  for (const handler of handlers.get('session_start')!) await handler({}, { mode: 'print' });
  assert.equal(
    typeof tools.filter((tool) => tool.name === 'exe_js').at(-1)?.renderCall,
    'function',
  );
  for (const handler of handlers.get('session_shutdown')!) await handler();
});

test('before_agent_start appends the Maat prompt and refreshes mobile status exactly once', async () => {
  const handlers = new Map<string, Function[]>();
  const pi = {
    registerFlag() {},
    getFlag: () => true,
    registerMessageRenderer() {},
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: Function) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  } as unknown as ExtensionAPI;
  maatPiExtension(pi);
  let refreshes = 0;
  const ctx = {
    mode: 'tui',
    ui: {
      setWidget(name: string) {
        assert.equal(name, 'maat-status');
        refreshes++;
      },
    },
  };
  try {
    const results = [];
    // Pi appends handlers; a Map<string, Function> silently hides this duplication.
    assert.equal(handlers.get('before_agent_start')!.length, 2);
    for (const handler of handlers.get('before_agent_start')!)
      results.push(await handler({ systemPrompt: 'Original prompt' }, ctx));
    assert.equal(refreshes, 1);
    assert.deepEqual(results.filter(Boolean), [
      { systemPrompt: `Original prompt\n\n${MAAT_SYSTEM_PROMPT}` },
    ]);
    assert.ok(handlers.has('tool_execution_end'));
    assert.ok(handlers.has('agent_end'));
  } finally {
    for (const handler of handlers.get('session_shutdown')!) await handler();
  }
});
