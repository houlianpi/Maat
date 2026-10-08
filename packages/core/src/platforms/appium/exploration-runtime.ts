import { attach } from 'webdriverio';
import { expect } from 'expect-webdriverio';
import type { ExplorationRuntime } from '../../core/exploration/runtime.ts';
import { takeAppiumScreenshot } from './screenshot.ts';

export async function createRuntime(
  options: Parameters<typeof attach>[0] & {
    maatAppId?: string;
    maatPlatform: 'android' | 'ios' | 'macos';
  },
): Promise<ExplorationRuntime> {
  const driver = await attach(options);
  const appId = options.maatAppId;
  return {
    bindings: () => ({
      driver,
      browser: driver,
      expect,
      ...(appId
        ? {
            app: {
              id: appId,
              resourceId: (name: string) => `id=${appId}:id/${name}`,
            },
          }
        : {}),
    }),
    async screenshot() {
      return takeAppiumScreenshot(driver, options.maatPlatform);
    },
    async close() {},
  };
}
