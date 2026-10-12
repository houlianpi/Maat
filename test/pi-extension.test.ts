import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEventBus,
  createExtensionRuntime,
  DefaultResourceLoader,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
// Exercise the installed CLI parser and flag application, not an imitation of them.
import { parseArgs } from '../node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js';
import { createAgentSessionServices } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-services.js';
import { loadExtensionFromFactory } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
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

test('real Pi SDK applies CLI flags before session_start decoration, with raw taking precedence', async (t) => {
  for (const [name, args, compact] of [
    ['unspecified flags default to compact', [], true],
    ['valueless raw opt-out restores original tools', ['--maat-raw-ui'], false],
    ['existing valueless mobile flag remains compatible', ['--maat-mobile-ui'], true],
    ['raw wins over explicit mobile flag', ['--maat-mobile-ui', '--maat-raw-ui'], false],
    ['boolean equals-false is presence, not an opt-out', ['--maat-mobile-ui=false'], true],
  ] as const) {
    await t.test(name, async (t) => {
      const runtime = createExtensionRuntime();
      const extension = await loadExtensionFromFactory(
        maatPiExtension,
        process.cwd(),
        createEventBus(),
        runtime,
      );
      const originals = new Map(
        [...extension.tools].map(([name, tool]) => [name, tool.definition]),
      );
      assert.equal(extension.flags.get('maat-mobile-ui')?.type, 'boolean');
      assert.equal(extension.flags.get('maat-mobile-ui')?.default, true);
      assert.equal(extension.flags.get('maat-raw-ui')?.type, 'boolean');
      assert.equal(extension.flags.get('maat-raw-ui')?.default, false);
      assert.equal(runtime.flagValues.get('maat-raw-ui'), false);
      for (const tool of originals.values()) {
        assert.equal(tool.renderCall, undefined);
        assert.equal(tool.renderResult, undefined);
      }
      // Isolate resource discovery and model refresh: no config, credentials, network,
      // model request, device request or tool execution is needed for flag application.
      t.mock.method(DefaultResourceLoader.prototype, 'reload', async () => {});
      t.mock.method(DefaultResourceLoader.prototype, 'getExtensions', () => ({
        extensions: [extension],
        errors: [],
        runtime,
      }));
      let refreshes = 0;
      const modelRuntime = {
        async refresh(options: { allowNetwork: boolean }) {
          assert.equal(options.allowNetwork, false);
          refreshes++;
        },
      } as unknown as ModelRuntime;
      const parsed = parseArgs([...args]);
      if (args.some((arg) => arg === '--maat-mobile-ui=false'))
        assert.equal(parsed.unknownFlags.get('maat-mobile-ui'), 'false');
      let compactStatus = false;
      const ctx = {
        mode: 'tui',
        sessionManager: { getEntries: () => [] },
        ui: {
          setWidget(_name: string, widget: unknown) {
            compactStatus = typeof widget === 'function';
          },
        },
      } as unknown as ExtensionContext;
      try {
        const services = await createAgentSessionServices({
          cwd: process.cwd(),
          settingsManager: SettingsManager.inMemory(),
          modelRuntime,
          extensionFlagValues: parsed.unknownFlags,
        });
        assert.deepEqual(services.diagnostics, []);
        assert.equal(refreshes, 1);
        assert.equal(runtime.flagValues.get('maat-mobile-ui'), true);
        assert.equal(runtime.flagValues.get('maat-raw-ui'), !compact);
        for (const handler of extension.handlers.get('session_start')!)
          await handler({ type: 'session_start', reason: 'startup' }, ctx);
        assert.equal(compactStatus, compact);
        for (const [name, tool] of extension.tools) {
          const original = originals.get(name)!;
          assert.equal(tool.definition.execute, original.execute);
          if (compact) {
            assert.equal(typeof tool.definition.renderCall, 'function');
            assert.equal(typeof tool.definition.renderResult, 'function');
            assert.equal(tool.definition.renderShell, 'self');
          } else {
            assert.equal(tool.definition, original);
          }
        }
      } finally {
        for (const handler of extension.handlers.get('session_shutdown')!)
          await handler({ type: 'session_shutdown' }, ctx);
      }
    });
  }
});

test('before_agent_start appends the Maat prompt and refreshes mobile status exactly once', async () => {
  const handlers = new Map<string, Function[]>();
  const pi = {
    registerFlag() {},
    getFlag: (name: string) => name === 'maat-mobile-ui',
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
