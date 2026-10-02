import { test as base, expect } from "playwright/test";

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    try {
      await use(page);
    } finally {
      if (!page.isClosed()) {
        const body = await page.screenshot({ fullPage: true });
        await testInfo.attach("final-state", {
          body,
          contentType: "image/png",
        });
      }
    }
  },
});

export { expect };
