/**
 * Case ID: calculator-32-plus-30
 * Name: 计算器验证 32 + 30 = 62
 *
 * Description:
 * 在在线计算器中输入 32 + 30 并计算，验证最终结果为 62。
 *
 * Preconditions:
 * 1. 计算器页面可访问
 *
 * Action steps:
 * 1. 打开 https://www.leaftools.net/calculator
 * 2. 输入 32
 * 3. 点击加号
 * 4. 输入 30
 * 5. 点击等号
 *
 * Test objectives:
 * 1. [objective-1] 验证 32 + 30 的最终结果为 62
 */

import { test, expect } from "../../fixtures/maat-test.ts";

test.describe("计算器验证 32 + 30 = 62", { tag: ["@calculator", "@smoke", "@suite:smoke"] }, () => {
  test("calculator-32-plus-30", async ({ page }) => {
    await page.goto("https://www.leaftools.net/calculator", {
      waitUntil: "domcontentloaded",
    });
    await page.locator('[data-key="Clear"]').click();
    for (const key of ["3", "2", "+", "3", "0", "="]) {
      await page.locator(`[data-key="${key}"]`).click();
    }
    await expect(page.locator(".curr")).toHaveText("62");
  });
});
