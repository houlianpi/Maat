import path from 'node:path';
import { createDefaultPlatformRegistry } from '../../platforms/default-registry.ts';
import type { RuntimeRequirement } from '../../core/platforms/contracts.ts';
import { EvidenceStore } from '../../core/testing/evidence.ts';
import { SessionPool } from '../../core/testing/session-pool.ts';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { expect as playwrightExpect } from 'playwright/test';
import type { Browser as WebdriverBrowser } from 'webdriverio';
import type { expect as webdriverExpect } from 'expect-webdriverio';

type EvidenceContext = { screenshot(name?: string): Promise<void> };
type Display = (value: string | Uint8Array, name?: string) => Promise<void>;
export type WebTestContext = {
  page: Page;
  context: BrowserContext;
  browser: Browser;
  expect: typeof playwrightExpect;
  display: Display;
  evidence: EvidenceContext;
};
export type AppiumTestContext = {
  driver: WebdriverBrowser;
  browser: WebdriverBrowser;
  expect: typeof webdriverExpect;
  display: Display;
  evidence: EvidenceContext;
};

export type MaatTest = {
  step(
    name: string,
    adapterId: 'web',
    body: (context: WebTestContext) => Promise<void>,
  ): Promise<void>;
  step(
    name: string,
    adapterId: 'android' | 'ios' | 'macos',
    body: (context: AppiumTestContext) => Promise<void>,
  ): Promise<void>;
  step(
    name: string,
    adapterId: string,
    body: (context: Record<string, unknown>) => Promise<void>,
  ): Promise<void>;
  close(passed: boolean): Promise<void>;
};

export async function createMaatTest(
  caseId: string,
  requirements: RuntimeRequirement[],
): Promise<MaatTest> {
  const root = path.resolve(process.env.MAAT_TESTS_ROOT ?? 'maat-tests');
  const runDirectory = path.resolve(
    process.env.MAAT_RUN_DIRECTORY ?? path.join('artifacts', 'maat', 'manual'),
  );
  const registry = createDefaultPlatformRegistry(root);
  const sessions = new SessionPool(registry, requirements);
  const evidence = new EvidenceStore(path.join(runDirectory, 'cases', caseId));
  const step = async (
    name: string,
    adapterId: string,
    body: (context: Record<string, unknown>) => Promise<void>,
  ) => {
    const session = await sessions.acquire(adapterId);
    const display = async (value: string | Uint8Array, evidenceName = 'observation') => {
      const data = typeof value === 'string' ? value : Buffer.from(value).toString('base64');
      await evidence.image(name, adapterId, evidenceName, data);
    };
    try {
      await body({
        ...session.context,
        display,
        evidence: {
          screenshot: async (evidenceName = 'observation') => {
            const shot = await session.screenshot();
            await evidence.image(name, adapterId, evidenceName, shot.data, shot.mimeType);
          },
        },
      });
    } catch (error) {
      const shot = await session.screenshot().catch(() => undefined);
      if (shot) await evidence.image(name, adapterId, 'failure', shot.data, shot.mimeType);
      throw error;
    }
  };
  return {
    step: step as unknown as MaatTest['step'],
    async close(passed) {
      try {
        for (const [adapterId, session] of sessions.entries()) {
          const shot = await session.screenshot().catch(() => undefined);
          if (shot)
            await evidence.image(
              'final-state',
              adapterId,
              passed ? 'final-state' : 'failure-final-state',
              shot.data,
              shot.mimeType,
            );
        }
        await evidence.finish(passed);
      } finally {
        await sessions.close();
        await registry.close();
      }
    },
  };
}
