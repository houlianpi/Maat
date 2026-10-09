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
      'MACOS_SCREEN_CAPTURE_PERMISSION_REQUIRED: App control and assertions remain available, but screenshot Evidence needs macOS Screen Recording permission. Open /maat-setup to continue.',
    );
  }
  return { data: selected.payload, mimeType: 'image/png' };
}
