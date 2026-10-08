import type { Browser as WebdriverBrowser } from 'webdriverio';

type MacScreenshot = { id?: unknown; isMain?: unknown; payload?: unknown };

export async function takeAppiumScreenshot(
  driver: WebdriverBrowser,
  platform: 'android' | 'ios' | 'macos',
): Promise<{ data: string; mimeType: 'image/png' }> {
  if (platform !== 'macos') {
    return { data: await driver.takeScreenshot(), mimeType: 'image/png' };
  }
  const result = (await driver.execute('macos: screenshots', {})) as Record<string, MacScreenshot>;
  const screenshots = Object.values(result ?? {});
  const selected = screenshots.find((item) => item.isMain === true) ?? screenshots[0];
  if (!selected || typeof selected.payload !== 'string' || !selected.payload) {
    throw new Error(
      'Mac2 returned no screenshot. Grant Screen Recording permission to the Appium/Xcode process and restart Appium.',
    );
  }
  return { data: selected.payload, mimeType: 'image/png' };
}
