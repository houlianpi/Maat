/**
 * Case ID: calculator-3-times-3-times-8
 * Name: 计算器验证 3 × 3 × 8 = 72
 *
 * Description:
 * 在在线计算器中执行 3 × 3 × 8，验证最终结果为 72。
 *
 * Preconditions:
 * 1. 计算器页面可访问
 *
 * Action steps:
 * 1. 打开 https://www.leaftools.net/calculator
 * 2. 清空计算器
 * 3. 依次输入 3 × 3 = × 8 =
 *
 * Test objectives:
 * 1. [objective-1] 验证 3 × 3 × 8 的最终结果为 72
 */

import { test, expect } from "../../fixtures/maat-test.ts";

test.describe("计算器验证 3 × 3 × 8 = 72", { tag: ["@calculator", "@smoke", "@suite:smoke"] }, () => {
  test("calculator-3-times-3-times-8", async ({ page }) => {
    await page.goto("https://www.leaftools.net/calculator", {
      waitUntil: "domcontentloaded",
    });
    await page.locator('[data-key="Clear"]').click();
    for (const key of ["3", "*", "3", "=", "*", "8", "="]) {
      await page.locator(`[data-key="${key}"]`).click();
    }
    await expect(page.locator(".curr")).toHaveText("72");
  });
});
