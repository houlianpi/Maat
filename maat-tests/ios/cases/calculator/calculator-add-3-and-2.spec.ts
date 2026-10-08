/** Case ID: calculator-add-3-and-2; @maat-adapters ios; Objective: iOS Calculator 3 + 2 = 5. */
import { afterEach, beforeEach, describe, it } from 'mocha';
import { createMaatTest, type MaatTest } from '@houlianpi/maat/test';
describe('验证 iPhone 计算器 3 + 2 = 5 @ios @calculator @suite:smoke', () => {
  let maat: MaatTest;
  beforeEach(async () => {
    maat = await createMaatTest('calculator-add-3-and-2', [
      { adapterId: 'ios', setup: { app: { 'appium:bundleId': 'com.apple.calculator' } } },
    ]);
    await maat.setup();
  });
  afterEach(async function () {
    await maat.teardown({ passed: this.currentTest?.state === 'passed' });
  });
  it('calculator-add-3-and-2', async () => {
    await maat.step('计算 3 + 2', 'ios', async ({ driver, expect }) => {
      await driver.$('~AllClear').click();
      await driver.$('~Three').click();
      await driver.$('~Add').click();
      await driver.$('~Two').click();
      await driver.$('~Equals').click();
      await expect(
        driver.$(
          '//XCUIElementTypeScrollView[@name="StandardInputView"]//XCUIElementTypeStaticText',
        ),
      ).toHaveText('\u200e5');
    });
  });
});
