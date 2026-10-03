import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { expect as playwrightExpect } from 'playwright/test';
import type { ExplorationRuntime } from '../../core/exploration/runtime.ts';

type Options = { channel?: string; executablePath?: string; headless?: boolean; userDataDir?: string; profileDirectory?: string; assertionTimeoutMs?: number };

export async function createRuntime(options: Options): Promise<ExplorationRuntime> {
  let browser: Browser | undefined; let context: BrowserContext; let page: Page;
  if (options.userDataDir) {
    context = await chromium.launchPersistentContext(options.userDataDir, { channel: options.channel, executablePath: options.executablePath, headless: options.headless ?? true, viewport: { width: 1440, height: 900 }, args: options.profileDirectory ? [`--profile-directory=${options.profileDirectory}`] : [] });
    browser = context.browser() ?? undefined;
  } else {
    browser = await chromium.launch({ channel: options.channel, executablePath: options.executablePath, headless: options.headless ?? true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  }
  page = context.pages()[0] ?? await context.newPage();
  context.setDefaultTimeout(10_000); context.setDefaultNavigationTimeout(15_000);
  const expect = playwrightExpect.configure({ timeout: options.assertionTimeoutMs ?? 5_000 });
  return {
    bindings: () => ({ page, context, browser, expect }),
    async screenshot() { return { data: (await page.screenshot({ fullPage: true })).toString('base64'), mimeType: 'image/png' }; },
    async close() { try { await context.close(); } finally { await browser?.close(); } },
  };
}
