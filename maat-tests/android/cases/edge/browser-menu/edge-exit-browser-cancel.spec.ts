/**
 * Case ID: edge-exit-browser-cancel
 * Name: Exit browser with confirmation - Cancel option
 * @maat-adapters android
 *
 * 在 Android Microsoft Edge 新标签页，从菜单第二页选择 Exit browser，验证退出确认框；
 * 点击 Cancel，验证确认框消失并返回新标签页。
 *
 * Preconditions:
 * 1. Android Edge 正式版已安装且初始设置完成
 * 2. 从 New Tab Page 开始
 * 3. 保留应用数据及登录状态
 *
 * Test objectives:
 * 1. 选择 Exit browser 后显示 Exit Microsoft Edge 确认对话框
 * 2. 点击 Cancel 后确认对话框消失
 * 3. 点击 Cancel 后返回 New Tab Page
 */

import { afterEach, beforeEach, describe, it } from 'mocha';
import { createMaatTest, type MaatTest } from '@houlianpi/maat/test';

describe('Exit browser with confirmation - Cancel option @p0 @edge @android @suite:p0', () => {
  let maat: MaatTest;

  beforeEach(async () => {
    maat = await createMaatTest('edge-exit-browser-cancel', [
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

  it('edge-exit-browser-cancel', async () => {
    await maat.step('Open the Edge overflow menu', 'android', async ({ driver, app }) => {
      const dismissButton = driver.$(app.resourceId('title_bar_dismiss_button'));
      if (await dismissButton.isDisplayed()) await dismissButton.click();
      await driver.$(app.resourceId('edge_ntp_scrollview')).waitForDisplayed();
      await driver.$(app.resourceId('overflow_button_bottom')).click();
    });

    await maat.step(
      'Open Exit browser from the second menu page',
      'android',
      async ({ driver, app }) => {
        const menuPager = await driver.$(app.resourceId('action_grid_pager'));
        await driver.execute('mobile: swipeGesture', {
          elementId: menuPager.elementId,
          direction: 'left',
          percent: 0.8,
        });
        await driver.$('~退出浏览器').click();
      },
    );

    await maat.step('Verify the exit confirmation', 'android', async ({ driver, expect, app }) => {
      await expect(driver.$(app.resourceId('title_bar_title'))).toHaveText('退出 Microsoft Edge？');
      await expect(driver.$('~退出 Microsoft Edge？')).toBeDisplayed();
    });

    await maat.step(
      'Cancel exit and return to the New Tab Page',
      'android',
      async ({ driver, expect, evidence, app }) => {
        await driver.$(app.resourceId('default_secondary_button')).click();
        await expect(driver.$('~退出 Microsoft Edge？')).not.toBeDisplayed();
        await expect(driver.$(app.resourceId('edge_ntp_scrollview'))).toBeDisplayed();
        await evidence.screenshot('edge-new-tab-after-cancel');
      },
    );
  });
});
