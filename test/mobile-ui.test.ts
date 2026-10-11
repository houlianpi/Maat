import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { initTheme, ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from '@earendil-works/pi-ai';
import { visibleWidth, type Component } from '@earendil-works/pi-tui';
import { createMaat } from '../packages/core/src/api/create-maat.ts';
import { createMobileUi } from '../packages/pi/src/mobile-ui.ts';
import { compactResult, toolTitles } from '../packages/pi/src/mobile-summary.ts';
import { createMaatPiTools } from '../packages/pi/src/tools.ts';
import { aggregateSetup } from '../packages/core/src/setup-assistant/model.ts';

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
type Tool = ToolDefinition<TSchema, unknown, Record<string, unknown>>;
type RenderContext = Parameters<NonNullable<Tool['renderResult']>>[3];
type Result = Parameters<NonNullable<Tool['renderResult']>>[0];
function renderContext(): RenderContext {
  return {
    args: {},
    toolCallId: 'call',
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
  };
}
function textResult(text = '', details?: unknown): Result {
  return { content: text ? [{ type: 'text', text }] : [], details };
}
const image = { type: 'image' as const, data: 'iVBORw0KGgo=', mimeType: 'image/png' };
const ready = aggregateSetup({
  platform: 'android',
  capabilities: [
    {
      id: 'appiumServer',
      required: true,
      status: 'ready',
      messageKey: 'capability.appium.ready',
    },
  ],
});
function harness(enabled = true) {
  const maat = createMaat();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let language = 'Continue with the phone';
  let widget: Component | undefined;
  let messageRenderer: Parameters<ExtensionAPI['registerMessageRenderer']>[1] | undefined;
  const pi = {
    getFlag(name: string) {
      assert.equal(name, 'maat-mobile-ui');
      return enabled;
    },
    registerFlag(name: string, options: { description: string; default: boolean }) {
      assert.equal(name, 'maat-mobile-ui');
      assert.equal(options.description, 'Compact Maat tool cards and concise status');
      assert.equal(options.default, false);
    },
    registerMessageRenderer(_name: string, renderer: typeof messageRenderer) {
      messageRenderer = renderer;
    },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: 'tui',
    sessionManager: {
      getEntries: () => [{ type: 'message', message: { role: 'user', content: language } }],
    },
    ui: {
      setWidget(_id: string, factory: () => Component) {
        widget = factory();
      },
    },
  } as unknown as ExtensionContext;
  const decorate = createMobileUi(pi, maat);
  const makeTool = (name: string) =>
    decorate({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      execute: async () => textResult(),
    } as Tool);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx);
  return {
    maat,
    decorate,
    makeTool,
    ctx,
    language(text: string) {
      language = text;
    },
    emit,
    start(name: string, id = name) {
      emit('tool_execution_start', { toolName: name, toolCallId: id });
    },
    end(name: string, result: unknown = textResult(), isError = false, id = name) {
      emit('tool_execution_end', { toolName: name, toolCallId: id, result, isError });
    },
    get widget() {
      return widget?.render(160).join('\n') ?? '';
    },
    widgetAt(width: number) {
      return widget?.render(width) ?? [];
    },
    get renderer() {
      return messageRenderer!;
    },
    dispose: () => maat.close(),
  };
}
function render(
  tool: Tool,
  result: Result,
  context = renderContext(),
  expanded = false,
  partial = false,
  width = 180,
) {
  return tool.renderResult!(result, { expanded, isPartial: partial }, theme, context)
    .render(width)
    .map((line) => line.trimEnd())
    .join('\n');
}

test('compact UI remains opt-in and never decorates execution or model content', async () => {
  const h = harness(false);
  const original = createMaatPiTools(h.maat)[0]!;
  assert.equal(h.decorate(original), original);
  h.emit('session_start');
  h.start('exe_js');
  h.end('exe_js', { content: [image] });
  assert.equal(h.widget, '');
  assert.equal(
    h.renderer(
      {
        role: 'custom',
        customType: 'maat-android-setup',
        content: 'full facts',
        display: true,
        details: {},
        timestamp: 0,
      },
      { expanded: false, outputPad: 0 },
      theme,
    ),
    undefined,
  );
  await h.dispose();
});

test('all Maat tools retain compact meaningful summaries, full expansion and neutral success', async () => {
  const h = harness();
  const originals = createMaatPiTools(h.maat);
  assert.equal(originals.length, 15);
  assert.deepEqual(Object.keys(toolTitles).sort(), originals.map((tool) => tool.name).sort());
  for (const original of originals) {
    const tool = h.decorate(original);
    assert.equal(tool.execute, original.execute);
    const result = textResult('Important short observation');
    const before = JSON.stringify(result);
    const compact = render(tool, result);
    assert.ok(compact.length > 0, tool.name);
    assert.ok(compact.split('\n').length <= 3, tool.name);
    assert.match(render(tool, result, renderContext(), true), /Important short observation/);
    assert.equal(JSON.stringify(result), before);
    const empty = render(tool, textResult());
    assert.doesNotMatch(empty, /observation|success|completed/i);
    const error = render(tool, textResult('TypeError: control unavailable'), {
      ...renderContext(),
      isError: true,
    });
    assert.match(error, /TypeError: control unavailable/);
    assert.match(error, /uncertain/);
    assert.match(error, /Next:/);
    assert.ok(error.split('\n').length <= 4, tool.name);
  }
  const platforms = h.decorate(originals.find((tool) => tool.name === 'list_platforms')!);
  const result = await platforms.execute('platforms', {}, undefined, undefined, h.ctx);
  assert.match(render(platforms, result), /Web · Android · iOS · macOS/);
  assert.doesNotMatch(render(platforms, result), /codeContext|guidelines|globals/);
  assert.match(render(platforms, result, renderContext(), true), /codeContext/);
  assert.match(
    render(
      h.makeTool('check_platform_setup'),
      textResult('', {
        snapshot: ready,
        privateDetail: 'full structured facts',
      }),
      renderContext(),
      true,
    ),
    /full structured facts/,
  );
  const colors: string[] = [];
  h.makeTool('exe_js').renderResult!(
    textResult('returned'),
    { expanded: false, isPartial: false },
    {
      fg(color: string, value: string) {
        colors.push(color);
        return value;
      },
    } as unknown as Theme,
    renderContext(),
  );
  assert.deepEqual(colors, ['toolOutput']);
  await h.dispose();
});

test('no-output, technical text, plain text and images have dense non-repeating summaries', async () => {
  const h = harness();
  const tool = h.makeTool('exe_js');
  assert.equal(render(tool, textResult()), 'Phone operation · Returned');
  assert.equal(render(tool, textResult('{"large":"payload"}')), '{"large":"payload"}');
  assert.equal(render(tool, textResult('Observed screen')), 'Observed screen');
  assert.equal(
    render(tool, { content: [image], details: undefined }),
    'Phone operation · Returned 1 image',
  );
  assert.equal(
    render(tool, { content: [image, image], details: undefined }),
    'Phone operation · Returned 2 images',
  );
  const mixed = {
    content: [{ type: 'text' as const, text: 'Observed screen' }, image],
    details: undefined,
  };
  const before = JSON.stringify(mixed);
  assert.equal(render(tool, mixed), 'Observed screen');
  assert.equal(JSON.stringify(mixed), before);
  assert.doesNotMatch(
    render(tool, textResult('text')),
    /0 image|Call returned|Text returned|details available/,
  );
  assert.equal(render(tool, mixed, { ...renderContext(), showImages: false }), render(tool, mixed));
  assert.equal(h.widget, ''); // Rendering has no lifecycle or host-setting side effects.
  await h.dispose();
});

test('raw execution previews keep image metadata and bound long text without altering results', async () => {
  const h = harness();
  const tool = h.makeTool('exe_js');
  const metadata =
    '[Image: original 1116x2484, displayed at 899x2000. Multiply coordinates by 1.24 to map to original image.]';
  assert.equal(render(tool, textResult(metadata)), metadata);
  for (const text of [
    '界'.repeat(500),
    '<hierarchy>' + 'x'.repeat(500),
    JSON.stringify({ text: 'x'.repeat(500) }),
    'first\nsecond\nthird\nfourth',
  ]) {
    const result = textResult(text);
    const before = JSON.stringify(result);
    const preview = render(tool, result, renderContext(), false, false, 1200);
    assert.ok(Array.from(preview).length <= 240);
    assert.ok(preview.split('\n').length <= 3);
    assert.ok(preview.endsWith('…'));
    assert.equal(JSON.stringify(result), before);
    assert.ok(render(tool, result, renderContext(), true, false, 1200).includes(text));
  }
  await h.dispose();
});

test('locale follows current session user language on session, agent and tool events', async () => {
  const h = harness();
  await h.maat.platforms.select('android');
  h.language('请继续操作手机');
  h.emit('session_start');
  assert.equal(h.widget, 'Android · 待连接');
  const tool = h.makeTool('exe_js');
  assert.equal(render(tool, textResult()), '手机操作 · 已返回');
  assert.equal(render(tool, { content: [image], details: undefined }), '手机操作 · 返回 1 张图片');
  assert.equal(
    render(h.makeTool('check_device_ready'), textResult('', { ready: true })),
    '检查手机通道 · 通道已确认',
  );
  h.language('Please continue');
  h.emit('before_agent_start');
  assert.equal(render(tool, textResult()), 'Phone operation · Returned');
  h.language('请检查');
  h.start('check_device_ready');
  assert.equal(h.widget, 'Android · 正在检查');
  h.end('check_device_ready', textResult('', { ready: true }));
  assert.equal(h.widget, 'Android · 就绪');
  h.language('Continue');
  h.emit('agent_end');
  assert.equal(h.widget, 'Android · Ready');
  h.language('继续');
  h.emit('session_tree');
  assert.equal(h.widget, 'Android · 待连接');
  await h.dispose();
});

test('mobile status distinguishes unchecked, absent, blocked and ready without connecting', async () => {
  const h = harness();
  h.language('请准备手机');
  h.emit('session_start');
  assert.equal(h.widget, '手机 · 待连接');
  assert.equal(h.maat.platforms.current().id, 'web');
  assert.equal(h.maat.platforms.status().session, 'idle');
  h.start('list_platforms');
  h.end('list_platforms');
  assert.equal(h.widget, '手机 · 待连接');
  await h.maat.platforms.select('android');
  h.end('select_platform');
  assert.equal(h.widget, 'Android · 待连接');
  const missing = aggregateSetup({
    platform: 'android',
    capabilities: [
      {
        id: 'androidDevice',
        required: true,
        status: 'action-required',
        messageKey: 'capability.androidDevice.missing',
      },
    ],
  });
  h.decorate.prepared(missing, h.ctx);
  assert.equal(h.widget, 'Android · 请连接手机');
  const blocked = aggregateSetup({
    platform: 'android',
    capabilities: [
      {
        id: 'adb',
        required: true,
        status: 'action-required',
        messageKey: 'capability.adb.install',
      },
    ],
  });
  h.decorate.prepared(blocked, h.ctx);
  assert.equal(h.widget, 'Android · 尚未准备');
  h.decorate.prepared(ready, h.ctx);
  assert.equal(h.widget, 'Android · 待连接');
  h.end('check_device_ready', textResult('', { ready: true }));
  assert.equal(h.widget, 'Android · 就绪');
  h.emit('agent_end');
  assert.equal(h.widget, 'Android · 就绪');
  h.end('release_device_session', textResult('', { released: true, platform: 'android' }));
  assert.equal(h.widget, 'Android · 待连接');
  assert.equal(h.maat.platforms.status().session, 'idle');
  await h.dispose();
});

test('public Pi component collapses completed call to identity and result to summary', async () => {
  initTheme('dark');
  const h = harness();
  h.emit('session_start');
  const tool = h.makeTool('exe_js');
  const component = new ToolExecutionComponent(
    'exe_js',
    'sdk-call',
    { code: 'original()' },
    {},
    tool,
    { requestRender() {} } as ConstructorParameters<typeof ToolExecutionComponent>[5],
    process.cwd(),
  );
  component.setArgsComplete();
  assert.match(component.render(120).join('\n'), /Queued/);
  component.markExecutionStarted();
  assert.match(component.render(120).join('\n'), /Executing/);
  component.updateResult({ ...textResult('{"raw":"unchanged"}'), isError: false }, true);
  assert.match(component.render(120).join('\n'), /Executing|Partial result/);
  component.updateResult({ ...textResult('{"raw":"unchanged"}'), isError: false }, false);
  const output = component.render(120).join('\n');
  assert.doesNotMatch(output, /Executing|Queued|Call returned|Text returned/);
  assert.equal((output.match(/Returned/g) ?? []).length, 0);
  assert.match(output, /raw/);
  assert.match(output, /Execute JavaScript/);
  assert.ok(output.split('\n').filter((line) => line.trim()).length <= 2);
  component.setExpanded(true);
  assert.match(
    component.render(120).join('\n'),
    /original\(\)|"raw": "unchanged"|"raw":"unchanged"/,
  );
  component.updateResult({ ...textResult('TypeError: original error'), isError: true }, false);
  component.setExpanded(false);
  assert.match(component.render(120).join('\n'), /TypeError: original error/);
  assert.doesNotMatch(component.render(120).join('\n'), /Executing|success|completed/);
  component.updateResult({ content: [image], isError: false }, false);
  component.setShowImages(false);
  assert.match(component.render(120).join('\n'), /Returned 1 image/);
  await h.dispose();
});

test('single-line status prioritizes user intervention and risk, never preparation as channel proof', async () => {
  const h = harness();
  await h.maat.platforms.select('android');
  h.language('继续');
  h.emit('session_start');
  h.end('check_platform_setup', textResult('', ready));
  assert.equal(h.widget, 'Android · 待连接');
  h.start('exe_js', 'active');
  assert.equal(h.widget, 'Android · 正在操作');
  h.start('list_platforms');
  h.end('list_platforms');
  assert.equal(h.widget, 'Android · 正在操作');
  h.end('exe_js', textResult('unknown transport failure'), true, 'active');
  assert.equal(h.widget, 'Android · 请检查连接');
  h.end('get_setup_diagnostics', textResult('', ready));
  h.end('configure_session');
  h.end('exe_js', { content: [image] });
  assert.equal(h.widget, 'Android · 请检查连接');
  h.end('check_device_ready', textResult('ANDROID_DEVICE_LOCKED: locked'), true);
  assert.equal(h.widget, 'Android · 请解锁手机');
  h.start('exe_js');
  assert.equal(h.widget, 'Android · 请解锁手机');
  h.end('exe_js');
  h.end('check_device_ready', textResult('', { ready: true }));
  assert.equal(h.widget, 'Android · 就绪');
  const narrow = h.widgetAt(18);
  assert.equal(narrow.length, 1);
  assert.ok(visibleWidth(narrow[0]!) <= 18);
  h.end('configure_session');
  assert.equal(h.widget, 'Android · 待连接');
  const authorization = aggregateSetup({
    platform: 'android',
    capabilities: [
      {
        id: 'androidDevice',
        required: true,
        status: 'action-required',
        messageKey: 'capability.androidDevice.unauthorized',
        action: { id: 'authorize-android-device', labelKey: 'action.authorizeAndroidDevice' },
      },
    ],
  });
  h.decorate.prepared(authorization, h.ctx);
  h.start('exe_js');
  assert.equal(h.widget, 'Android · 请允许 USB 调试');
  await h.dispose();
});

test('session and platform changes reset presentation, same-platform diagnostics preserve risk', async () => {
  const h = harness();
  await h.maat.platforms.select('android');
  for (const reason of ['startup', 'reload', 'new', 'resume', 'fork']) {
    h.end('exe_js', textResult('failure'), true);
    assert.equal(h.widget, 'Android · Check the connection');
    h.emit('session_start', { reason });
    assert.equal(h.widget, 'Android · Awaiting connection');
  }
  h.end('check_device_ready', textResult('', { ready: true }));
  await h.maat.platforms.select('web');
  h.end('select_platform');
  assert.equal(h.widget, 'Phone · Awaiting connection');
  h.emit('session_shutdown');
  await h.dispose();
});

test('failure cause, certainty and recovery are visible; raw envelope is unchanged', async () => {
  const h = harness();
  h.language('请解锁');
  h.emit('before_agent_start');
  const tool = h.makeTool('exe_js');
  const result = textResult(
    'MAAT_EXECUTION_FAILED\nsummary: original cause\nactionState: not-started\ncode: ANDROID_DEVICE_LOCKED\nphase: preflight',
  );
  const before = JSON.stringify(result);
  const error = render(tool, result, { ...renderContext(), isError: true });
  assert.match(error, /original cause/);
  assert.match(error, /未执行 UI 动作/);
  assert.match(error, /本人点亮并解锁/);
  assert.doesNotMatch(error, /执行不确定/);
  assert.match(
    render(tool, result, { ...renderContext(), isError: true }, true),
    /MAAT_EXECUTION_FAILED/,
  );
  assert.equal(JSON.stringify(result), before);
  await h.dispose();
});

test('setup user summary retains blockers and next step while expanded/model facts stay complete', async () => {
  const h = harness();
  const blocked = aggregateSetup({
    platform: 'android',
    capabilities: [
      {
        id: 'appiumServer',
        required: true,
        status: 'action-required',
        messageKey: 'capability.appium.start',
        errorCode: 'APPIUM_SERVER_UNAVAILABLE',
        action: { id: 'start-appium', labelKey: 'action.startAppium' },
      },
    ],
  });
  const result = textResult('Maat setup facts:\n{"large":"diagnosis"}', blocked);
  const summary = compactResult('check_platform_setup', result, 'zh-CN');
  assert.equal(summary.length, 3);
  assert.match(summary.join('\n'), /APPIUM_SERVER_UNAVAILABLE|下一步/);
  const message = {
    role: 'custom' as const,
    customType: 'maat-android-setup',
    content: 'full instructions and facts',
    display: true,
    details: { summary },
    timestamp: 0,
  };
  assert.doesNotMatch(
    h.renderer(message, { expanded: false, outputPad: 0 }, theme)!.render(180).join('\n'),
    /full instructions/,
  );
  assert.match(
    h.renderer(message, { expanded: true, outputPad: 0 }, theme)!.render(180).join('\n'),
    /full instructions and facts/,
  );
  const instruction = compactResult(
    'open_setup_step',
    textResult('full facts', {
      labelKey: 'action.startAppium',
      systemChangesExecuted: false,
    }),
    'zh-CN',
  );
  assert.match(instruction.join('\n'), /未执行系统修改/);
  await h.dispose();
});
