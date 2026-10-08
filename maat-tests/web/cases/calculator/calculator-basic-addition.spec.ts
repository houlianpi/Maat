/** Case ID: calculator-basic-addition; @maat-adapters web; Objective: 12 + 30 = 42. */
import { describe, it } from 'mocha';
import { createMaatTest } from '@houlianpi/maat/test';
describe('基础加法计算 @calculator @smoke @suite:smoke', () => {
  it('calculator-basic-addition', async () => {
    const maat = await createMaatTest('calculator-basic-addition', [
      { adapterId: 'web', setup: { browser: 'chrome', headless: true } },
    ]);
    let passed = false;
    try {
      await maat.step('计算 12 + 30', 'web', async ({ page, expect }) => {
        await page.goto('https://www.leaftools.net/calculator', { waitUntil: 'domcontentloaded' });
        await page.locator('.btn[data-key="Clear"]').click();
        for (const key of ['1', '2', '+', '3', '0', '='])
          await page.locator('.btn[data-key="' + key + '"]').click();
        await expect(page.locator('.curr')).toHaveText('42');
      });
      passed = true;
    } finally {
      await maat.close(passed);
    }
  });
});
