/** Case ID: calculator-32-plus-30; @maat-adapters web; Objective: 32 + 30 = 62. */
import { describe, it } from 'mocha';
import { createMaatTest } from 'maat/test';
describe('计算器验证 32 + 30 = 62 @calculator @smoke @suite:smoke', () => {
  it('calculator-32-plus-30', async () => {
    const maat = await createMaatTest('calculator-32-plus-30', [
      { adapterId: 'web', setup: { browser: 'chrome', headless: true } },
    ]);
    let passed = false;
    try {
      await maat.step('计算 32 + 30', 'web', async ({ page, expect }) => {
        await page.goto('https://www.leaftools.net/calculator', { waitUntil: 'domcontentloaded' });
        await page.locator('[data-key="Clear"]').click();
        for (const key of ['3', '2', '+', '3', '0', '='])
          await page.locator('[data-key="' + key + '"]').click();
        await expect(page.locator('.curr')).toHaveText('62');
      });
      passed = true;
    } finally {
      await maat.close(passed);
    }
  });
});
