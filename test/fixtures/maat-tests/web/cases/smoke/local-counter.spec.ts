import { afterEach, beforeEach, describe, it } from 'mocha';
import { createMaatTest, type MaatTest } from '@houlianpi/maat-core/test';

describe('Local counter @smoke @suite:smoke', () => {
  let maat: MaatTest;

  beforeEach(async () => {
    maat = await createMaatTest('local-counter', [
      { adapterId: 'web', setup: { browser: 'chromium', headless: true } },
    ]);
    await maat.setup();
  });

  afterEach(async function () {
    await maat.teardown({ passed: this.currentTest?.state === 'passed' });
  });

  it('increments from zero to one', async () => {
    await maat.step('Increment counter', 'web', async ({ page, expect, evidence }) => {
      await page.setContent(
        '<span id="count">0</span><button onclick="count.textContent=1">Increment</button>',
      );
      await page.getByRole('button', { name: 'Increment' }).click();
      await expect(page.locator('#count')).toHaveText('1');
      await evidence.screenshot('counter-result');
    });
  });
});
