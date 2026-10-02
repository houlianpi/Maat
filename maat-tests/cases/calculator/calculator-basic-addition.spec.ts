/**
 * Case ID: calculator-basic-addition
 * Name: 基础加法计算
 *
 * Description:
 * 清空计算器，输入 12 + 30，验证最终结果显示 42。
 *
 * Preconditions:
 * None.
 *
 * Action steps:
 * 1. 打开 https://www.leaftools.net/calculator
 * 2. 点击 C 清空计算器
 * 3. 依次输入 12 + 30
 * 4. 点击 = 执行计算
 *
 * Test objectives:
 * 1. [objective-1] 最终结果显示 42
 */

import { test, expect } from "../../fixtures/maat-test.ts";

test.describe("基础加法计算", { tag: ["@calculator", "@smoke", "@suite:smoke"] }, () => {
  test("calculator-basic-addition", async ({ page }) => {
    await page.goto("https://www.leaftools.net/calculator", {
      waitUntil: "domcontentloaded",
    });
    await page.locator('.btn[data-key="Clear"]').click();

    for (const key of ["1", "2", "+", "3", "0", "="]) {
      await page.locator(`.btn[data-key="${key}"]`).click();
    }

    await expect(page.locator(".curr")).toHaveText("42");
  });
});
