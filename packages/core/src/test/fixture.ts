import path from 'node:path';
import { createDefaultPlatformRegistry } from '../platforms/default-registry.ts';
import type { RuntimeRequirement } from '../core/platforms/contracts.ts';
import { EvidenceStore } from '../core/testing/evidence.ts';
import { SessionPool } from '../core/testing/session-pool.ts';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { expect as playwrightExpect } from 'playwright/test';
import type { Browser as WebdriverBrowser } from 'webdriverio';
import type { expect as webdriverExpect } from 'expect-webdriverio';

type EvidenceContext = { screenshot(name?: string): Promise<void> };
type Display = (value: string | Uint8Array, name?: string) => Promise<void>;
export type AppTargetContext = {
  id: string;
  resourceId(name: string): string;
};
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
  app: AppTargetContext;
};

export type MaatTest = {
  setup(): Promise<void>;
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
  teardown(result: { passed: boolean }): Promise<void>;
};

export async function createMaatTest(
  caseId: string,
  requirements: RuntimeRequirement[],
  options: { requireScreenshotEvidence?: boolean; skippedCapabilities?: string[] } = {},
): Promise<MaatTest> {
  const root = path.resolve(process.env.MAAT_TESTS_ROOT ?? 'maat-tests');
  const runDirectory = path.resolve(
    process.env.MAAT_RUN_DIRECTORY ?? path.join('artifacts', 'maat', 'manual'),
  );
  const registry = createDefaultPlatformRegistry(root);
  const sessions = new SessionPool(registry, requirements);
  const evidence = new EvidenceStore(path.join(runDirectory, 'cases', caseId));
  let started = false;
  let finished = false;
  let setupFailure: unknown;
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
            try {
              const shot = await session.screenshot();
              await evidence.image(name, adapterId, evidenceName, shot.data, shot.mimeType);
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              evidence.unavailable(
                name,
                adapterId,
                evidenceName,
                reason,
                options.requireScreenshotEvidence === true,
                options.skippedCapabilities?.includes('screenCapture') === true,
              );
              if (options.requireScreenshotEvidence) throw error;
            }
          },
        },
      });
    } catch (error) {
      const shot = await session.screenshot().catch(() => undefined);
      if (shot) await evidence.image(name, adapterId, 'failure', shot.data, shot.mimeType);
      throw error;
    }
  };
  const teardown = async ({ passed }: { passed: boolean }) => {
    if (finished) return;
    finished = true;
    if (setupFailure) return;
    let evidenceFailure: unknown;
    try {
      for (const [adapterId, session] of sessions.entries()) {
        const shot = await session.screenshot().catch((error) => {
          evidence.unavailable(
            'final-state',
            adapterId,
            passed ? 'final-state' : 'failure-final-state',
            error instanceof Error ? error.message : String(error),
            options.requireScreenshotEvidence === true,
            options.skippedCapabilities?.includes('screenCapture') === true,
          );
          if (options.requireScreenshotEvidence) evidenceFailure ??= error;
          return undefined;
        });
        if (shot)
          await evidence.image(
            'final-state',
            adapterId,
            passed ? 'final-state' : 'failure-final-state',
            shot.data,
            shot.mimeType,
          );
      }
      if (options.requireScreenshotEvidence && !evidence.hasCapturedImage())
        evidenceFailure ??= new Error(
          'Screenshot Evidence is required but no screenshot was captured.',
        );
      await evidence.finish(passed);
      if (evidenceFailure) throw evidenceFailure;
    } finally {
      try {
        await sessions.teardown();
      } finally {
        await registry.close();
      }
    }
  };
  return {
    async setup() {
      if (started) return;
      started = true;
      try {
        await sessions.setup();
        if (options.skippedCapabilities?.includes('screenCapture')) {
          for (const requirement of requirements)
            evidence.unavailable(
              'setup',
              requirement.adapterId,
              'screenshot',
              'User chose to continue without screenshot Evidence.',
              false,
              true,
            );
        }
      } catch (error) {
        setupFailure = error;
        try {
          await evidence.finish(false);
        } finally {
          await registry.close();
        }
        throw error;
      }
    },
    step: step as unknown as MaatTest['step'],
    teardown,
  };
}
