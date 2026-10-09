import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createMaat } from '../packages/core/src/api/create-maat.ts';
import { aggregateSetup } from '../packages/core/src/setup-assistant/model.ts';
import type { SetupSnapshot } from '../packages/core/src/setup-assistant/types.ts';
import { createPlatformTools } from '../packages/pi/src/tools/platform-tools.ts';
import { createSetupTools } from '../packages/pi/src/tools/setup-tools.ts';
import { registerMaatSetupCommands } from '../packages/pi/src/setup-extension.ts';

const fingerprint = { appiumPid: 10, appiumStartedAt: 'now', wdaPid: 20, wdaStartedAt: 'now' };

function partialSnapshot(): SetupSnapshot {
  return aggregateSetup({
    platform: 'macos',
    fingerprint,
    capabilities: [
      { id: 'appiumServer', status: 'ready', required: true, summary: '测试服务已连接' },
      { id: 'uiInteraction', status: 'ready', required: true, summary: '可以操作应用并运行断言' },
      {
        id: 'screenCapture',
        status: 'action-required',
        required: false,
        summary: '截图 Evidence 尚未开启',
        action: { id: 'open-screen-recording', label: '开启截图权限' },
      },
    ],
  });
}

function toolByName(tools: ReturnType<typeof createSetupTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} was not created`);
  return tool;
}

const context = {} as ExtensionContext;

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const content = result.content.find((item) => item.type === 'text');
  assert.ok(content?.text);
  return content.text;
}

test('select_platform automatically returns the macOS setup action panel', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maat-setup-tools-'));
  const maat = createMaat({
    workspaceRoot: directory,
    setupAssistant: {
      preferencesFile: path.join(directory, 'setup.json'),
      detector: async () => partialSnapshot(),
    },
  });
  try {
    const tool = createPlatformTools(maat).find(
      (candidate) => candidate.name === 'select_platform',
    );
    assert.ok(tool);
    const result = await tool.execute(
      'select',
      { platform: 'macos' },
      undefined,
      undefined,
      context,
    );
    assert.match(textContent(result), /Maat · macOS/);
    assert.match(textContent(result), /下一步：开启截图权限/);
  } finally {
    await maat.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('setup tools persist degradation in the Draft and resume the interrupted Case', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maat-setup-tools-'));
  const maat = createMaat({
    workspaceRoot: directory,
    setupAssistant: {
      preferencesFile: path.join(directory, 'setup.json'),
      detector: async () => partialSnapshot(),
    },
  });
  try {
    await maat.platforms.select('macos');
    maat.cases.begin({
      id: 'calculator',
      name: 'Calculator',
      description: 'Verify a calculation',
      objectives: ['Result is 7'],
    });
    const tools = createSetupTools(maat);
    await toolByName(tools, 'check_platform_setup').execute(
      'check',
      {},
      undefined,
      undefined,
      context,
    );
    await toolByName(tools, 'continue_without_capability').execute(
      'skip',
      { capability: 'screenCapture' },
      undefined,
      undefined,
      context,
    );
    assert.deepEqual(maat.cases.current()?.skippedCapabilities, ['screenCapture']);

    maat.setup.interrupt({
      platform: 'macos',
      caseId: 'calculator',
      pendingAction: 'screenshot',
      workMode: 'case',
    });
    const retried = await toolByName(tools, 'retry_setup_step').execute(
      'retry',
      context,
      undefined,
      undefined,
      context,
    );
    assert.match(textContent(retried), /已恢复 Case calculator/);
    assert.equal(maat.setup.pendingInterruption(), undefined);
  } finally {
    await maat.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a Case requiring screenshots cannot choose screenshot degradation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maat-setup-tools-'));
  const maat = createMaat({
    workspaceRoot: directory,
    setupAssistant: {
      preferencesFile: path.join(directory, 'setup.json'),
      detector: async () => partialSnapshot(),
    },
  });
  try {
    await maat.platforms.select('macos');
    maat.cases.begin({
      id: 'required-evidence',
      name: 'Required Evidence',
      description: 'Screenshot required',
      objectives: ['Screenshot exists'],
      requireScreenshotEvidence: true,
    });
    await assert.rejects(
      toolByName(createSetupTools(maat), 'continue_without_capability').execute(
        'skip',
        { capability: 'screenCapture' },
        undefined,
        undefined,
        context,
      ),
      /requires screenshot Evidence/,
    );
  } finally {
    await maat.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('/maat-setup in non-TUI mode reports status without confirmation or system changes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maat-setup-command-'));
  const maat = createMaat({
    workspaceRoot: directory,
    setupAssistant: {
      preferencesFile: path.join(directory, 'setup.json'),
      detector: async () => partialSnapshot(),
    },
  });
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
  const pi = {
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: ExtensionContext) => unknown },
    ) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  let confirms = 0;
  const notifications: string[] = [];
  const commandContext = {
    mode: 'print',
    ui: {
      confirm: async () => {
        confirms += 1;
        return true;
      },
      notify: (message: string) => notifications.push(message),
    },
  } as unknown as ExtensionContext;
  try {
    await maat.platforms.select('macos');
    registerMaatSetupCommands(pi, maat);
    await commands.get('maat-setup')?.handler('', commandContext);
    assert.equal(confirms, 0);
    assert.match(notifications.join('\n'), /下一步：开启截图权限/);
    assert.equal(maat.setup.current().state, 'partially-ready');
  } finally {
    await maat.close();
    await rm(directory, { recursive: true, force: true });
  }
});
