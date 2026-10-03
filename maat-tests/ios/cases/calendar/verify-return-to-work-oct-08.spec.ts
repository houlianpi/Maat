/**
 * Case ID: verify-return-to-work-oct-08
 * 根据国庆假期核对10月8日返岗
 * 查看2026年中国大陆节假日日历中的国庆假期，验证假期于10月7日结束，其后首日为10月8日。不代表个人或公司的排班。
 * Preconditions:
 * 模拟器日历中启用了中国大陆节假日日历
 * 核对的是2026年国庆节后的返岗日期
 * Actions:
 * 打开日历，搜索国庆节（休）
 * 打开2026年的国庆假期详情
 * 核对假期结束于10月7日，次日为10月8日，保留截图
 * Objectives:
 * 依据2026年国庆假期结束日期，核对节后首日为10月8日
 * @maat-target {"appium:bundleId":"com.apple.mobilecal"}
 */
import { driver, browser, expect, describe, it, display, evidence } from "../../fixtures/maat-test.ts";

describe("根据国庆假期核对10月8日返岗 @ios @calendar", () => {
  it("verify-return-to-work-oct-08", async () => {
    await (async () => {
      await driver.activateApp('com.apple.mobilecal');
      const detailClose = await driver.$('~cancel-button');
      if (await detailClose.isDisplayed()) await detailClose.click();
      const searchClose = await driver.$('~Close');
      if (await searchClose.isDisplayed()) await searchClose.click();
      await driver.$('~searchbar-button').click();
      await driver.$('-ios class chain:**/XCUIElementTypeSearchField').setValue('国庆节');
    })();
    await (async () => {
      console.log((await driver.getPageSource()).split('\n').filter(l => /Cell|StaticText/.test(l) && /visible="true"/.test(l)).join('\n'));
    })();
    await (async () => {
      console.log((await driver.getPageSource()).split('\n').filter(l => /October|2026|国庆|Table|Cell|Header/.test(l)).join('\n'));
    })();
    await (async () => {
      await driver.$('-ios predicate string:type == "XCUIElementTypeStaticText" AND name == "国庆节（休）" AND visible == true').click();
      await expect(driver.$('~event-details-title-text')).toHaveAttribute('value', '国庆节（休）');
      await expect(driver.$('~Ends')).toHaveAttribute('value', 'to Wednesday, October 7, 2026');
      const holidayEndText = await driver.$('~Ends').getAttribute('value');
      const holidayEnd = new Date((holidayEndText ?? '').replace(/^to /, '') + ' 12:00:00 GMT');
      holidayEnd.setUTCDate(holidayEnd.getUTCDate() + 1);
      await expect({ year: holidayEnd.getUTCFullYear(), month: holidayEnd.getUTCMonth() + 1, day: holidayEnd.getUTCDate() }).toEqual({ year: 2026, month: 10, day: 8 });
      await evidence.screenshot('national-day-holiday-ends-oct-07');
    })();
  });
});
