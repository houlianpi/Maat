import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { browserNames, nativeDeviceKinds, type MaatApi } from '@houlianpi/maat-core';

export function createPlatformTools(maat: MaatApi): ToolDefinition<any, any, any>[] {
  return [
    defineTool({
      name: 'select_platform',
      label: 'Select Platform',
      executionMode: 'sequential',
      description:
        'Select the active UI platform adapter. Available adapters are returned dynamically by Maat.',
      parameters: Type.Object({ platform: Type.String() }),
      async execute(_id, input) {
        const state = await maat.platforms.select(input.platform);
        return { content: [{ type: 'text', text: JSON.stringify(state) }], details: state };
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
        'Provide Session hints to the active adapter. Appium adapters determine platformName and automationName; serverUrl, device and app capabilities are optional and resolved when possible.',
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
      description: 'Discover online devices for the active Appium platform.',
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
