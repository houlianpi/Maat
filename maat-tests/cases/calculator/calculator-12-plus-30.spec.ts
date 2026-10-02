/**
 * Case ID: calculator-12-plus-30
 * Name: 计算器加法验证 12 + 30 = 42
 *
 * Description:
 * 在在线计算器页面中输入 12 + 30，验证计算结果显示为 42。
 *
 * Preconditions:
 * 1. 计算器页面可正常访问
 *
 * Action steps:
 * 1. 打开计算器页面 https://www.leaftools.net/calculator
 * 2. 点击按键输入 12
 * 3. 点击加号键 +
 * 4. 点击按键输入 30
 * 5. 点击等号键 = 并验证计算结果为 42
 *
 * Test objectives:
 * 1. [objective-1] 验证 12 + 30 的最终结果为 42
 */

import { test, expect } from "../../fixtures/maat-test.ts";

test.describe("计算器加法验证 12 + 30 = 42", {
  tag: ["@calculator", "@smoke", "@suite:smoke"],
  annotation: [
    { type: "Case ID", description: "calculator-12-plus-30" },
    { type: "Description", description: "在在线计算器页面中输入 12 + 30，验证计算结果显示为 42。" },
    { type: "Preconditions", description: "计算器页面可正常访问" },
    { type: "Action steps", description: "打开计算器页面\n输入 12\n点击加号\n输入 30\n点击等号" },
    { type: "Test objectives", description: "[objective-1] 验证 12 + 30 的最终结果为 42" },
  ],
}, () => {
  test("calculator-12-plus-30", async ({ page }) => {
    await page.goto("https://www.leaftools.net/calculator", {
      waitUntil: "domcontentloaded",
    });
    await page.locator('[data-key="Clear"]').click();
    for (const key of ["1", "2", "+", "3", "0", "="]) {
      await page.locator(`[data-key="${key}"]`).click();
    }
    await expect(page.locator(".curr")).toHaveText("42");
  });
});
