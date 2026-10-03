import { attach } from 'webdriverio';
import { expect } from 'expect-webdriverio';
import type { ExplorationRuntime } from '../../core/exploration/runtime.ts';

export async function createRuntime(options: Parameters<typeof attach>[0]): Promise<ExplorationRuntime> {
  const driver = await attach(options);
  return {
    bindings: () => ({ driver, browser: driver, expect }),
    async screenshot() { return { data: await driver.takeScreenshot(), mimeType: 'image/png' }; },
    async close() {},
  };
}
