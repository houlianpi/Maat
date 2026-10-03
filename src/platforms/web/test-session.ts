import { chromium } from 'playwright';
import { browserChannel, type BrowserName } from '../../browser/browser-options.ts';
import type { TestSession } from '../contracts.ts';

export async function createWebTestSession(setup: Record<string, unknown> = {}): Promise<TestSession> {
  const { expect } = await import('playwright/test');
  const browserName = (process.env.MAAT_WEB_BROWSER ?? (typeof setup.browser === 'string' ? setup.browser : 'chrome')) as BrowserName;
  const headless = process.env.MAAT_WEB_HEADED === '1' ? false : setup.headless !== false;
  const browser = await chromium.launch({ channel: browserChannel(browserName), headless });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  return {
    context: { page, context, browser, expect },
    async screenshot() { return { data: (await page.screenshot({ fullPage: true })).toString('base64'), mimeType: 'image/png' }; },
    async close() { try { await context.close(); } finally { await browser.close(); } },
  };
}
