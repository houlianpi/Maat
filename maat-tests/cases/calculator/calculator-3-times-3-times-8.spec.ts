/** Case ID: calculator-3-times-3-times-8; @maat-adapters web; Objective: 3 × 3 × 8 = 72. */
import { describe, it } from 'mocha';
import { createMaatTest } from '../../../src/hosts/test/fixture.ts';
describe('计算器验证 3 × 3 × 8 = 72 @calculator @smoke @suite:smoke', () => {
  it('calculator-3-times-3-times-8', async () => {
    const maat = await createMaatTest('calculator-3-times-3-times-8', [
      { adapterId: 'web', setup: { browser: 'chrome', headless: true } },
    ]);
    let passed = false;
    try {
      await maat.step('计算 3 × 3 × 8', 'web', async ({ page, expect }) => {
        await page.goto('https://www.leaftools.net/calculator', { waitUntil: 'domcontentloaded' });
        await page.locator('[data-key="Clear"]').click();
        for (const key of ['3', '*', '3', '=', '*', '8', '='])
          await page.locator('[data-key="' + key + '"]').click();
        await expect(page.locator('.curr')).toHaveText('72');
      });
      passed = true;
    } finally {
      await maat.close(passed);
    }
  });
});
