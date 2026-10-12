import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { browserNames, nativeDeviceKinds, type MaatApi } from '@houlianpi/maat-core';
import { setupAgentContext, setupPanel } from '../setup-ui.ts';
import { resolveSetupLocale } from '../setup-i18n.ts';

export function createPlatformTools(maat: MaatApi): ToolDefinition<any, any, any>[] {
  return [
    defineTool({
      name: 'release_device_session',
      label: 'Release Phone Session',
      executionMode: 'sequential',
      description:
        'Release the owned Android or iPhone Worker and Appium Session when this conversation no longer needs phone interaction. Keep the Pi conversation, App data/login and external services. Do not release while waiting for a user action followed by more phone work or merely at model-turn end. Never infer business completion from release.',
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id, _input, _signal, _update, ctx) {
        const released = await maat.mobile.releaseCurrentSession();
        const locale = resolveSetupLocale(undefined, ctx);
        return {
          content: [
            {
              type: 'text',
              text:
                released.platform === 'ios'
                  ? locale === 'zh-CN'
                    ? '手机操作连接已释放，Pi 对话继续保留。未停止外部服务；释放不代表业务任务完成。'
                    : 'Phone control Session released; the Pi conversation remains available. External services were not stopped; release is not business validation.'
                  : locale === 'zh-CN'
                    ? '手机操作连接已释放，Pi 对话继续保留。未主动关闭 App 或停止外部连接服务。'
                    : 'Phone control Session released; the Pi conversation remains available. No explicit App termination or external-service stop was requested.',
            },
          ],
          details: released,
        };
      },
    }),
    defineTool({
      name: 'select_platform',
      label: 'Select Platform',
      executionMode: 'sequential',
      description:
        'Select the active UI platform adapter. Available adapters are returned dynamically by Maat.',
      parameters: Type.Object({ platform: Type.String() }),
      async execute(_id, input, _signal, _update, ctx) {
        const state = await maat.platforms.select(input.platform);
        const setup = input.platform === 'macos' ? maat.setup.current() : undefined;
        return {
          content: [
            {
              type: 'text',
              text: setup
                ? `${JSON.stringify(state)}\n\n${setupPanel(setup, resolveSetupLocale(undefined, ctx)).join('\n')}\n\n${setupAgentContext(setup, resolveSetupLocale(undefined, ctx))}`
                : JSON.stringify(state),
            },
          ],
          details: { state, setup },
        };
      },
    }),
    defineTool({
      name: 'list_platforms',
      label: 'List Platforms',
      description: 'List registered platform adapters and their JavaScript execution context.',
      parameters: Type.Object({}),
      async execute() {
        const platforms = maat.platforms.list().map((adapter) => ({
          id: adapter.id,
          label: adapter.label,
          codeContext: adapter.codeContext,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(platforms) }], details: platforms };
      },
    }),
    defineTool({
      name: 'configure_session',
      label: 'Configure Session',
      executionMode: 'sequential',
      description:
        'Provide connection hints to the active adapter. For Android/iPhone first-use readiness, configure the selected local physical device and server only; establish the base phone channel before launching an App through exe_js. App capabilities are optional and may change Session lifecycle.',
      parameters: Type.Object({
        serverUrl: Type.Optional(Type.String()),
        device: Type.Optional(
          Type.Object({
            kind: Type.Optional(Type.Union(nativeDeviceKinds.map((value) => Type.Literal(value)))),
            name: Type.Optional(Type.String()),
          }),
        ),
        capabilities: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        allowDataReset: Type.Optional(Type.Boolean()),
        clearAppTarget: Type.Optional(
          Type.Boolean({
            description:
              'Clear legacy App routing before a base Android/iPhone readiness check. Closes the existing Session using its current lifecycle; does not delete App data. Cannot be combined with a new App target.',
          }),
        ),
      }),
      async execute(_id, input) {
        await maat.platforms.configureSession(input);
        return {
          content: [
            {
              type: 'text',
              text: 'Session hints accepted. Maat will validate them while creating the Session.',
            },
          ],
          details: maat.platforms.status(),
        };
      },
    }),
    defineTool({
      name: 'list_devices',
      label: 'Discover Devices',
      description:
        'List sanitized current device facts for diagnostics. This does not select a target; use check_device_ready for lifecycle selection.',
      parameters: Type.Object({}),
      async execute() {
        const devices = await maat.platforms.inspectSetup({ kind: 'devices' });
        return { content: [{ type: 'text', text: JSON.stringify(devices) }], details: devices };
      },
    }),
    defineTool({
      name: 'find_applications',
      label: 'Find Applications',
      description: 'Find applications on the selected Appium device.',
      parameters: Type.Object({ query: Type.String() }),
      async execute(_id, input) {
        const apps = await maat.platforms.inspectSetup({
          kind: 'applications',
          query: input.query,
        });
        return { content: [{ type: 'text', text: JSON.stringify(apps) }], details: apps };
      },
    }),
    defineTool({
      name: 'configure_browser',
      label: 'Configure Browser',
      description: 'Configure browser, headed mode, or logical profile for the Web adapter.',
      parameters: Type.Object({
        browser: Type.Optional(Type.Union(browserNames.map((name) => Type.Literal(name)))),
        headless: Type.Optional(Type.Boolean()),
        profile: Type.Optional(Type.String()),
      }),
      async execute(_id, input) {
        if (maat.platforms.current().id !== 'web') {
          throw new Error('configure_browser requires the Web platform.');
        }
        const configuration = await maat.platforms.configure(input);
        return {
          content: [{ type: 'text', text: JSON.stringify(configuration) }],
          details: configuration,
        };
      },
    }),
    defineTool({
      name: 'get_browser_config',
      label: 'Get Browser Config',
      description: 'Return the Web adapter browser configuration.',
      parameters: Type.Object({}),
      async execute() {
        const adapter = maat.platforms.current();
        if (adapter.id !== 'web' || !('config' in adapter)) {
          throw new Error('get_browser_config requires the Web platform.');
        }
        const configuration = adapter.config;
        return {
          content: [{ type: 'text', text: JSON.stringify(configuration) }],
          details: configuration,
        };
      },
    }),
  ];
}
