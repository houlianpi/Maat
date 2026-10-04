/** Case ID: calculator-12-plus-30; @maat-adapters web; Objective: 12 + 30 = 42. */
import { describe, it } from 'mocha';
import { createMaatTest } from '../../../src/hosts/test/fixture.ts';
describe('计算器加法验证 12 + 30 = 42 @calculator @smoke @suite:smoke', () => {
  it('calculator-12-plus-30', async () => {
    const maat = await createMaatTest('calculator-12-plus-30', [
      { adapterId: 'web', setup: { browser: 'chrome', headless: true } },
    ]);
    let passed = false;
    try {
      await maat.step('计算 12 + 30', 'web', async ({ page, expect }) => {
        await page.goto('https://www.leaftools.net/calculator', { waitUntil: 'domcontentloaded' });
        await page.locator('[data-key="Clear"]').click();
        for (const key of ['1', '2', '+', '3', '0', '='])
          await page.locator('[data-key="' + key + '"]').click();
        await expect(page.locator('.curr')).toHaveText('42');
      });
      passed = true;
    } finally {
      await maat.close(passed);
    }
  });
});
