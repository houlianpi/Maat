import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { ProjectManager } from './project-manager.ts';
import type { BrowserManager } from '../browser/browser-manager.ts';
import type { CaseManager } from '../cases/case-manager.ts';
import { discoverDevices } from '../native/devices.ts';
import { capabilities } from '../native/config.ts';
import { discoverApplications } from '../native/applications.ts';

export function createProjectTools(projects: ProjectManager, browser: BrowserManager, cases: CaseManager) {
  return [
    defineTool({ name: 'find_applications', label: 'Find installed app', executionMode: 'sequential',
      description: 'Find installed applications by name/package for the selected local native target. Confirm ambiguous names. Does not launch, install or reset apps. Android matching uses package IDs; iOS uses devicectl (real devices).',
      parameters: Type.Object({ query: Type.String() }), async execute(_id, input) {
        const target = projects.native.currentTarget;
        if (!target) throw new Error('Select a native project first.');
        return { content: [{ type: 'text', text: JSON.stringify(await discoverApplications(target, input.query)) }], details: {} };
      } }),
    defineTool({ name: 'select_project', label: 'Select project', executionMode: 'sequential',
      description: 'Select a platform root: maat-tests/web, android, ios or macos. Never create app/device-named project roots. Business folders belong in begin_case.module. Config, fixtures and cases live together. Switching closes sessions and clears the Case draft.',
      parameters: Type.Object({ platform: Type.Union(['web','android','ios','macos'].map(v => Type.Literal(v))) }),
      async execute(_id, input) {
        if (!['web','android','ios','macos'].includes(input.platform)) throw new Error('Invalid platform.');
        const state = await projects.select(input.platform, input.platform as 'web'|'android'|'ios'|'macos', browser);
        cases.clear();
        return { content: [{ type: 'text', text: JSON.stringify(state) }], details: {} };
      } }),
    defineTool({ name: 'list_devices', label: 'Discover devices', executionMode: 'sequential',
      description: 'List online devices for the current native project. One device is selected automatically at execution; ask the user to choose when multiple devices are available. Remote Appium requires a configured device.',
      parameters: Type.Object({}), async execute() {
        if (projects.current.platform === 'web') throw new Error('Select a native project.');
        if (projects.native.currentTarget?.serverUrl) throw new Error('Remote discovery is server-specific; configure deviceName or udid.');
        return { content: [{ type: 'text', text: JSON.stringify(await discoverDevices(projects.current.platform)) }], details: {} };
      } }),
    defineTool({ name: 'configure_native', label: 'Configure native target', executionMode: 'sequential',
      description: 'Configure official Appium capabilities for the current project. Use appium:appPackage/appActivity for Android, appium:bundleId for iOS/macOS, appium:app for an install package, or omit app identifiers for current app. Only set noReset=false/fullReset=true when user explicitly requests clearing data. Set remote serverUrl to connect without owning the server. Settings stay in ignored local config.',
      parameters: Type.Object({ serverUrl: Type.Optional(Type.String()), capabilities: Type.Record(Type.String(), Type.Unknown()), allowDataReset: Type.Optional(Type.Boolean()) }),
      async execute(_id, input) {
        const platform = projects.current.platform;
        if (platform === 'web') throw new Error('Select a native project.');
        if ((input.capabilities['appium:noReset'] === false || input.capabilities['appium:fullReset'] === true) && !input.allowDataReset) throw new Error('Data reset requires explicit user instruction and allowDataReset=true.');
        // Updating an app/device must not erase signing or the existing server endpoint.
        const previous = projects.native.currentTarget;
        const target = { platform, serverUrl: input.serverUrl ?? previous?.serverUrl, capabilities: capabilities({ platform, capabilities: { ...previous?.capabilities, ...input.capabilities } }) };
        await projects.configure(target);
        return { content: [{ type: 'text', text: 'Native target configured. App data is retained unless explicitly reset.' }], details: {} };
      } }),
    defineTool({ name: 'exec_native', label: 'Execute native TypeScript', executionMode: 'sequential',
      description: 'Execute TypeScript in a persistent Worker: driver/browser are WebdriverIO clients; expect is expect-webdriverio. Use await driver.$(...), console.log, await evidence.screenshot(name) or display(await driver.takeScreenshot()). Await every operation/assertion. Do not import modules, write files, create directories, create/delete sessions, or reset app data. Evidence storage belongs to the shared fixture and WDIO hooks, not Case code. Generate assertions only for user objectives.',
      parameters: Type.Object({ code: Type.String() }), async execute(_id, input, signal) {
        if (projects.current.platform === 'web') throw new Error('Select a native project first.');
        try {
          const content = await projects.native.execute(input.code, signal);
          await cases.recordSuccessfulStep(input.code, content);
          return { content, details: {} };
        } catch (error) { await cases.recordFailedStep(input.code, error); throw error; }
      } }),
  ];
}
