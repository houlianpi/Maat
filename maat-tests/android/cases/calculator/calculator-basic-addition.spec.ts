/**
 * Case ID: calculator-basic-addition
 * Name: Android 计算器基础加法
 * @maat-adapters android
 *
 * 在 OPPO 计算器输入 12 + 30，点击等号，验证结果为 42 并截图。保留应用数据。
 *
 * Preconditions:
 * 1. Android 真机已连接并授权 USB 调试
 * 2. Appium 服务可用且已安装 UiAutomator2 驱动
 * 3. 已安装 com.coloros.calculator
 *
 * Action steps:
 * 1. 打开计算器并清空当前计算输入
 * 2. 输入 12 + 30
 * 3. 点击等号
 * 4. 验证结果为 42 并保存截图
 *
 * Test objectives:
 * 1. 12 + 30 的计算结果为 42
 *
 */

import { afterEach, beforeEach, describe, it } from 'mocha';
import { createMaatTest, type MaatTest } from '@houlianpi/maat/test';

describe('Android 计算器基础加法 @calculator @android @smoke @suite:smoke', () => {
  let maat: MaatTest;

  beforeEach(async () => {
    maat = await createMaatTest('calculator-basic-addition', [
      {
        adapterId: 'android',
        setup: { app: 'runtime' },
      },
    ]);
    await maat.setup();
  });

  afterEach(async function () {
    await maat.teardown({ passed: this.currentTest?.state === 'passed' });
  });

  it('calculator-basic-addition', async () => {
    await maat.step('Calculate 12 + 30', 'android', async ({ driver, app }) => {
      await driver.$(app.resourceId('clr')).click();
      await driver.$(app.resourceId('digit_1')).click();
      await driver.$(app.resourceId('digit_2')).click();
      await driver.$(app.resourceId('op_add')).click();
      await driver.$(app.resourceId('digit_3')).click();
      await driver.$(app.resourceId('digit_0')).click();
      await driver.$(app.resourceId('eq')).click();
    });
    await maat.step('Verify the result', 'android', async ({ driver, expect, evidence, app }) => {
      await expect(driver.$(app.resourceId('result'))).toHaveText('42');
      await evidence.screenshot('calculator-result-42');
    });
  });
});
