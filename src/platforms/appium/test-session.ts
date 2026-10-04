import { remote } from 'webdriverio';
import {
  capabilities,
  connection,
  type NativeAppTarget,
  type ResolvedNativeSession,
} from './schema.ts';
import type { TestSession } from '../contracts.ts';

export async function createAppiumTestSession(
  resolved: ResolvedNativeSession,
  app?: NativeAppTarget,
): Promise<TestSession> {
  const { expect } = await import('expect-webdriverio');
  const endpoint = connection(resolved.environment.serverUrl!);
  const driver = await remote({
    ...endpoint,
    capabilities: capabilities({ ...resolved, app }),
    logLevel: 'silent',
    connectionRetryCount: 0,
    connectionRetryTimeout: 180_000,
  });
  return {
    context: { driver, browser: driver, expect },
    async screenshot() {
      return { data: await driver.takeScreenshot(), mimeType: 'image/png' };
    },
    async close() {
      await driver.deleteSession();
    },
  };
}
