/** Case ID: calculator-3-times-3-times-8; @maat-adapters web; Objective: 3 × 3 × 8 = 72. */
import { afterEach, beforeEach, describe, it } from 'mocha';
import { createMaatTest, type MaatTest } from '@houlianpi/maat/test';
describe('计算器验证 3 × 3 × 8 = 72 @calculator @smoke @suite:smoke', () => {
  let maat: MaatTest;
  beforeEach(async () => {
    maat = await createMaatTest('calculator-3-times-3-times-8', [
      { adapterId: 'web', setup: { browser: 'chrome', headless: true } },
    ]);
    await maat.setup();
  });
  afterEach(async function () {
    await maat.teardown({ passed: this.currentTest?.state === 'passed' });
  });
  it('calculator-3-times-3-times-8', async () => {
    await maat.step('计算 3 × 3 × 8', 'web', async ({ page, expect }) => {
      await page.goto('https://www.leaftools.net/calculator', { waitUntil: 'domcontentloaded' });
      await page.locator('[data-key="Clear"]').click();
      for (const key of ['3', '*', '3', '=', '*', '8', '='])
        await page.locator('[data-key="' + key + '"]').click();
      await expect(page.locator('.curr')).toHaveText('72');
    });
  });
});
