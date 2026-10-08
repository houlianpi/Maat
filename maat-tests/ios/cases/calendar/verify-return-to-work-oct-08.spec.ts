/** Case ID: verify-return-to-work-oct-08; @maat-adapters ios; Objective: verify the holiday ends October 7, 2026. */
import { afterEach, beforeEach, describe, it } from 'mocha';
import { createMaatTest, type MaatTest } from '@houlianpi/maat-core/test';
describe('根据国庆假期核对10月8日返岗 @ios @calendar', () => {
  let maat: MaatTest;
  beforeEach(async () => {
    maat = await createMaatTest('verify-return-to-work-oct-08', [
      { adapterId: 'ios', setup: { app: { 'appium:bundleId': 'com.apple.mobilecal' } } },
    ]);
    await maat.setup();
  });
  afterEach(async function () {
    await maat.teardown({ passed: this.currentTest?.state === 'passed' });
  });
  it('verify-return-to-work-oct-08', async () => {
    await maat.step('核对国庆假期', 'ios', async ({ driver, expect, evidence }) => {
      const detailClose = await driver.$('~cancel-button');
      if (await detailClose.isDisplayed()) await detailClose.click();
      await driver.$('~searchbar-button').click();
      await driver.$('-ios class chain:**/XCUIElementTypeSearchField').setValue('国庆节');
      await driver
        .$(
          '-ios predicate string:type == "XCUIElementTypeStaticText" AND name == "国庆节（休）" AND visible == true',
        )
        .click();
      await expect(driver.$('~Ends')).toHaveAttribute('value', 'to Wednesday, October 7, 2026');
      await evidence.screenshot('national-day-holiday-ends-oct-07');
    });
  });
});
