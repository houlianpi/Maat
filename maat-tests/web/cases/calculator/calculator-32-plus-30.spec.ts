/** Case ID: calculator-32-plus-30; @maat-adapters web; Objective: 32 + 30 = 62. */
import { afterEach, beforeEach, describe, it } from 'mocha';
import { createMaatTest, type MaatTest } from '@houlianpi/maat/test';
describe('计算器验证 32 + 30 = 62 @calculator @smoke @suite:smoke', () => {
  let maat: MaatTest;
  beforeEach(async () => {
    maat = await createMaatTest('calculator-32-plus-30', [
      { adapterId: 'web', setup: { browser: 'chrome', headless: true } },
    ]);
    await maat.setup();
  });
  afterEach(async function () {
    await maat.teardown({ passed: this.currentTest?.state === 'passed' });
  });
  it('calculator-32-plus-30', async () => {
    await maat.step('计算 32 + 30', 'web', async ({ page, expect }) => {
      await page.goto('https://www.leaftools.net/calculator', { waitUntil: 'domcontentloaded' });
      await page.locator('[data-key="Clear"]').click();
      for (const key of ['3', '2', '+', '3', '0', '='])
        await page.locator('[data-key="' + key + '"]').click();
      await expect(page.locator('.curr')).toHaveText('62');
    });
  });
});
