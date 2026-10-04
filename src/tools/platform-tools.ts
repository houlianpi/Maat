import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { CaseDraftManager } from '../core/cases/draft-manager.ts';
import { nativeDeviceKinds } from '../platforms/appium/schema.ts';
import type { MaatHarness } from '../core/harness.ts';

export function createPlatformTools(projects: MaatHarness, cases: CaseDraftManager) {
  return [
    defineTool({
      name: 'select_platform',
      label: 'Select Platform',
      executionMode: 'sequential',
      description:
        'Select the active UI platform adapter. Available adapters are returned dynamically by Maat.',
      parameters: Type.Object({ platform: Type.String() }),
      async execute(_id, input) {
        const state = await projects.select(input.platform);
        return { content: [{ type: 'text', text: JSON.stringify(state) }], details: state };
      },
    }),
    defineTool({
      name: 'list_platforms',
      label: 'List Platforms',
      description: 'List registered platform adapters and their JavaScript execution context.',
      parameters: Type.Object({}),
      async execute() {
        const platforms = projects.registry.list().map((adapter) => ({
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
        await projects.configureSession(input);
        return {
          content: [
            {
              type: 'text',
              text: 'Session hints accepted. Maat will validate them while creating the Session.',
            },
          ],
          details: projects.status(),
        };
      },
    }),
    defineTool({
      name: 'list_devices',
      label: 'Discover Devices',
      description: 'Discover online devices for the active Appium platform.',
      parameters: Type.Object({}),
      async execute() {
        const devices = await projects.inspectSetup({ kind: 'devices' });
        return { content: [{ type: 'text', text: JSON.stringify(devices) }], details: devices };
      },
    }),
    defineTool({
      name: 'find_applications',
      label: 'Find Applications',
      description: 'Find applications on the selected Appium device.',
      parameters: Type.Object({ query: Type.String() }),
      async execute(_id, input) {
        const apps = await projects.inspectSetup({ kind: 'applications', query: input.query });
        return { content: [{ type: 'text', text: JSON.stringify(apps) }], details: apps };
      },
    }),
  ];
}
