import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MaatApi } from '../../packages/core/src/api/maat-api.ts';
import type { PlatformAdapter } from '../../packages/core/src/core/platforms/contracts.ts';
import { PlatformRegistry } from '../../packages/core/src/core/platforms/registry.ts';
import { identityFromLocalFact } from '../../packages/core/src/mobile/contracts/device.ts';
import {
  acquireDeviceLock,
  deviceLockReleaseCallCountsForTests,
  setDeviceLockStateDirectoryForTests,
  setDeviceLockUnlockFailureForTests,
} from '../../packages/core/src/mobile/devices/device-lock.ts';
import {
  AppiumPlatformAdapter,
  createAppiumPlatformAdapterWithInspectionProvidersForTests,
} from '../../packages/core/src/platforms/appium/appium-adapter.ts';
import { aggregateSetup } from '../../packages/core/src/setup-assistant/model.ts';

function safeCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as Error & { code?: string }).code)
    : undefined;
}

async function rejectedCode(operation: () => unknown | Promise<unknown>): Promise<string> {
  try {
    await operation();
  } catch (error) {
    const code = safeCode(error);
    assert.equal(code, 'lock-release-uncertain');
    assert.doesNotMatch(
      JSON.stringify(error),
      /FICTIONAL|owner|device key|[a-f0-9]{64}|[/\\].*device-lock/i,
    );
    return code;
  }
  throw new Error('Expected process lock-release barrier rejection.');
}

function webAdapter(id: 'web' | 'macos'): PlatformAdapter {
  return {
    id,
    label: id,
    codeContext: { language: 'javascript', globals: [], guidelines: [] },
    async initialize() {},
    async execute() {
      return [];
    },
    status() {
      return { id, label: id, session: 'idle' as const };
    },
    async close() {},
  };
}

async function runBarrierScenario(
  stateDirectory: string,
  routingId: string,
  behavior: 'barrier-abort' | 'barrier-active',
) {
  setDeviceLockStateDirectoryForTests(stateDirectory);
  const controller = new AbortController();
  const primary = new Error('private test abort');
  let deviceInspections = 0;
  let applicationInspections = 0;
  class AndroidAdapter extends AppiumPlatformAdapter {
    protected override async discoverSelectionDevices() {
      if (behavior === 'barrier-abort') controller.abort(primary);
      return [{ id: routingId, name: 'Fictional barrier phone', kind: 'device' as const }];
    }
  }
  const barrierOwner = new AndroidAdapter({
    id: 'android',
    label: 'Android',
    platformName: 'Android',
    automationName: 'UiAutomator2',
  });
  setDeviceLockUnlockFailureForTests(new Error('private injected unlock failure'));
  if (behavior === 'barrier-abort') {
    await assert.rejects(
      barrierOwner.selectReadinessTarget(undefined, controller.signal),
      (error: unknown) => error === primary,
    );
    assert.equal(barrierOwner.isMigratedLocalPhysicalRoute(), false);
    assert.equal((await barrierOwner.selectReadinessTarget())?.status, 'target-selected');
    await rejectedCode(() => barrierOwner.close());
    assert.equal(barrierOwner.isMigratedLocalPhysicalRoute(), true);
  } else {
    assert.equal((await barrierOwner.selectReadinessTarget())?.status, 'target-selected');
    await rejectedCode(() => barrierOwner.close());
    assert.equal(barrierOwner.isMigratedLocalPhysicalRoute(), true);
  }

  const providers = {
    async devices() {
      deviceInspections++;
      return [];
    },
    async applications() {
      applicationInspections++;
      return [];
    },
  };
  const android = createAppiumPlatformAdapterWithInspectionProvidersForTests(
    {
      id: 'android',
      label: 'Android',
      platformName: 'Android',
      automationName: 'UiAutomator2',
    },
    providers,
  );
  const ios = new AppiumPlatformAdapter({
    id: 'ios',
    label: 'iOS',
    platformName: 'iOS',
    automationName: 'XCUITest',
  });
  const apiA = new MaatApi(
    new PlatformRegistry([android, ios, webAdapter('web'), webAdapter('macos')], 'android'),
    stateDirectory,
    {
      detector: async () => aggregateSetup({ platform: 'macos', capabilities: [] }),
      preferencesFile: path.join(stateDirectory, 'setup.json'),
    },
  );

  const assertNoReflectedInspectionProviders = (adapter: AppiumPlatformAdapter) => {
    const objects = [adapter, Object.getPrototypeOf(adapter)];
    for (const object of objects) {
      const descriptors = Object.getOwnPropertyDescriptors(object);
      assert.equal(descriptors.inspectDevices, undefined);
      assert.equal(descriptors.inspectApplications, undefined);
      assert.equal(Reflect.get(object, 'inspectDevices'), undefined);
      assert.equal(Reflect.get(object, 'inspectApplications'), undefined);
      assert.deepEqual(
        Object.getOwnPropertySymbols(object).filter((symbol) =>
          /inspect.*(?:device|application)|provider/i.test(symbol.description ?? ''),
        ),
        [],
      );
      assert.deepEqual(
        Object.entries(descriptors)
          .filter(
            ([name, descriptor]) =>
              /inspect.*(?:device|application)|provider/i.test(name) &&
              typeof descriptor.value === 'function',
          )
          .map(([name]) => name),
        [],
      );
    }
  };
  assertNoReflectedInspectionProviders(android);
  assert.equal(Reflect.get(android, 'inspectDevices'), undefined);
  assert.equal(Reflect.get(android, 'inspectApplications'), undefined);
  assert.deepEqual(
    { deviceInspections, applicationInspections },
    {
      deviceInspections: 0,
      applicationInspections: 0,
    },
  );

  await rejectedCode(() => android.inspectSetup({ kind: 'devices' }));
  await rejectedCode(() => android.inspectSetup({ kind: 'applications', query: 'fictional' }));
  await rejectedCode(() => apiA.platforms.inspectSetup({ kind: 'devices' }));
  await rejectedCode(() =>
    apiA.platforms.inspectSetup({ kind: 'applications', query: 'fictional' }),
  );
  await rejectedCode(() => android.configureSession({ capabilities: {} }));
  await rejectedCode(() => android.executeReadiness('return 1;'));
  await rejectedCode(() => android.execute('return 1;'));
  await rejectedCode(() => android.selectReadinessTarget());
  await rejectedCode(() => android.close());

  assert.equal((await apiA.platforms.select('web')).id, 'web');
  assert.deepEqual(await apiA.exploration.executeJavaScript('web remains available'), []);
  assert.equal((await apiA.platforms.select('macos')).id, 'macos');
  assert.deepEqual(await apiA.exploration.executeJavaScript('macOS remains available'), []);
  await rejectedCode(() => apiA.platforms.select('ios'));
  await rejectedCode(() => apiA.platforms.select('android'));
  assert.equal(apiA.platforms.current().id, 'macos');

  const secondAndroid = createAppiumPlatformAdapterWithInspectionProvidersForTests(
    {
      id: 'android',
      label: 'second Android',
      platformName: 'Android',
      automationName: 'UiAutomator2',
    },
    providers,
  );
  assertNoReflectedInspectionProviders(secondAndroid);
  const apiB = new MaatApi(
    new PlatformRegistry([secondAndroid, webAdapter('web')], 'android'),
    stateDirectory,
  );
  await rejectedCode(() => apiB.platforms.select('android'));
  await rejectedCode(() => secondAndroid.inspectSetup({ kind: 'devices' }));
  await rejectedCode(() => secondAndroid.inspectSetup({ kind: 'applications' }));
  await rejectedCode(() => apiB.platforms.inspectSetup({ kind: 'devices' }));
  await rejectedCode(() => apiB.platforms.inspectSetup({ kind: 'applications' }));
  await rejectedCode(() => apiB.platforms.configureSession({ capabilities: {} }));
  await rejectedCode(() => apiB.setup.ready());
  await rejectedCode(() => apiB.exploration.executeJavaScript('return 1;'));
  await rejectedCode(() => apiB.mobile.releaseCurrentSession());
  await rejectedCode(() => apiB.close());

  assert.deepEqual(deviceLockReleaseCallCountsForTests(), { unlock: 1, close: 0 });
  assert.deepEqual(
    { deviceInspections, applicationInspections },
    {
      deviceInspections: 0,
      applicationInspections: 0,
    },
  );
  process.stdout.write(
    `${JSON.stringify({
      status: 'barrier-confirmed',
      behavior,
      code: 'lock-release-uncertain',
      unlock: 1,
      close: 0,
      current: apiA.platforms.current().id,
      deviceInspections,
      applicationInspections,
    })}\n`,
  );
}

async function runChild() {
  const [stateDirectory, routingId, behavior = 'hold'] = process.argv.slice(2);
  if (!stateDirectory || !routingId) throw new Error('Missing device-lock child arguments.');
  if (behavior === 'barrier-abort' || behavior === 'barrier-active') {
    await runBarrierScenario(stateDirectory, routingId, behavior);
    return;
  }
  const identity = identityFromLocalFact({
    source: 'local-adb',
    platform: 'android',
    device: { id: routingId, name: 'Fictional test phone', kind: 'device' },
  });

  try {
    const lease = acquireDeviceLock(identity, { stateDirectory });
    process.stdout.write(`${JSON.stringify({ status: 'acquired' })}\n`);
    if (behavior === 'release') {
      lease.release();
      process.stdout.write(`${JSON.stringify({ status: 'released' })}\n`);
    } else {
      process.stdin.resume();
      await once(process.stdin, 'data');
      if (behavior === 'uncertain') {
        await once(process.stdin, 'end');
      } else {
        lease.release();
        process.stdout.write(`${JSON.stringify({ status: 'released' })}\n`);
        process.stdin.pause();
      }
    }
  } catch (error) {
    const safe = error as Error & { code?: string };
    process.stdout.write(
      `${JSON.stringify({ status: 'error', name: safe.name, code: safe.code, message: safe.message })}\n`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runChild();
