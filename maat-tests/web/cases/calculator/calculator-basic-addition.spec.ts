/** Case ID: calculator-basic-addition; @maat-adapters web; Objective: 12 + 30 = 42. */
import { afterEach, beforeEach, describe, it } from 'mocha';
import { createMaatTest, type MaatTest } from '@houlianpi/maat/test';
describe('基础加法计算 @calculator @smoke @suite:smoke', () => {
  let maat: MaatTest;
  beforeEach(async () => {
    maat = await createMaatTest('calculator-basic-addition', [
      { adapterId: 'web', setup: { browser: 'chrome', headless: true } },
    ]);
    await maat.setup();
  });
  afterEach(async function () {
    await maat.teardown({ passed: this.currentTest?.state === 'passed' });
  });
  it('calculator-basic-addition', async () => {
    await maat.step('计算 12 + 30', 'web', async ({ page, expect }) => {
      await page.goto('https://www.leaftools.net/calculator', { waitUntil: 'domcontentloaded' });
      await page.locator('.btn[data-key="Clear"]').click();
      for (const key of ['1', '2', '+', '3', '0', '='])
        await page.locator('.btn[data-key="' + key + '"]').click();
      await expect(page.locator('.curr')).toHaveText('42');
    });
  });
});
