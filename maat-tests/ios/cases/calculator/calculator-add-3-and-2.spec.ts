/**
 * Case ID: calculator-add-3-and-2
 * 验证 iPhone 计算器 3 + 2 = 5
 * 在用户确认的真实 iPhone 计算器中验证加法结果。
 * Preconditions:
 * 已连接用户确认的 iPhone，计算器已打开
 * 保留应用数据，仅清除当前算式
 * Actions:
 * 点击全部清除
 * 依次点击 3、+、2、=
 * 验证结果为 5 并截图
 * Objectives:
 * 计算器执行 3 + 2 = 后，最终结果为 5
 */
import { driver, expect, describe, it } from '../../fixtures/maat-test.ts';

describe("验证 iPhone 计算器 3 + 2 = 5 @ios @calculator @suite:smoke", () => {
  it("calculator-add-3-and-2", async () => {
    await (async () => {
      await driver.$('~AllClear').click();
      await driver.$('~Three').click();
      await driver.$('~Add').click();
      await driver.$('~Two').click();
      await driver.$('~Equals').click();
      console.log(await driver.$('//XCUIElementTypeScrollView[@name="StandardInputView"]//XCUIElementTypeStaticText').getText());
    })();
    await (async () => {
      await expect(driver.$('//XCUIElementTypeScrollView[@name="StandardInputView"]//XCUIElementTypeStaticText')).toHaveText('\u200e5');
    })();
  });
});
