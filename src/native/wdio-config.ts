import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beginEvidence, evidence, finishEvidence } from './evidence.ts';
import { selectDevice } from './devices.ts';
import { capabilities, connection, readNativeTarget } from './config.ts';
import { appiumHome, availablePort } from './server.ts';

// Used by both WDIO formal runs and save validation. No model calls here.
export async function createNativeConfig(root: string) {
  // WDIO workers inherit this value, including when launched directly via wdio.
  const runDirectory = process.env.MAAT_NATIVE_RUN_DIR ?? path.resolve(root, '../../artifacts/native', path.basename(root), 'runs', randomUUID());
  process.env.MAAT_NATIVE_RUN_DIR = runDirectory;
  const target = await selectDevice(await readNativeTarget(process.env.MAAT_NATIVE_TARGET ?? path.join(root, 'native-target.local.json')));
  process.env.APPIUM_HOME = appiumHome();
  const port = target.serverUrl ? undefined : await availablePort();
  const endpoint = connection(target.serverUrl ?? `http://127.0.0.1:${port}/`);
  return {
    runner: 'local' as const, framework: 'mocha', maxInstances: 1,
    specs: [path.join(root, 'cases/**/*.spec.ts')],
    ...endpoint, capabilities: [capabilities(target)],
    services: target.serverUrl ? [] : [['appium', { args: { address: '127.0.0.1', port, basePath: '/' } }]],
    reporters: ['spec', ['junit', { outputDir: path.join(runDirectory, 'junit') }]],
    logLevel: 'error' as const, connectionRetryCount: 0, connectionRetryTimeout: 180_000,
    waitforTimeout: 10_000, mochaOpts: { timeout: 60_000 },
    beforeTest(test: { title: string; parent?: string; file?: string }) {
      beginEvidence(runDirectory, { title: test.title, parent: test.parent, file: test.file });
    },
    afterTest: async function (_test: unknown, _context: unknown, result: { passed: boolean }) {
      let screenshotError: string | undefined;
      try { await evidence.screenshot(result.passed ? 'final-state' : 'failure'); }
      catch (error) { screenshotError = String(error); console.error('Evidence capture failed:', screenshotError); }
      finally { finishEvidence(result.passed, screenshotError); }
    },
  };
}
