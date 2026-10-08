import { remote } from 'webdriverio';
import {
  capabilities,
  connection,
  type NativeAppTarget,
  type ResolvedNativeSession,
} from './schema.ts';
import type { TestSession } from '../../core/platforms/contracts.ts';

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
  const appId =
    typeof app?.['appium:appPackage'] === 'string'
      ? app['appium:appPackage']
      : typeof app?.['appium:bundleId'] === 'string'
        ? app['appium:bundleId']
        : undefined;
  return {
    context: {
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
    },
    async setup() {
      if (appId) await driver.activateApp(appId);
    },
    async screenshot() {
      return { data: await driver.takeScreenshot(), mimeType: 'image/png' };
    },
    async teardown() {
      try {
        if (appId) await driver.terminateApp(appId);
      } finally {
        await driver.deleteSession();
      }
    },
  };
}
