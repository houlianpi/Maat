import { launcher as AppiumLauncher } from '@wdio/appium-service';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import logger from '@wdio/logger';

export function appiumHome(): string { return process.env.MAAT_APPIUM_HOME ?? path.join(homedir(), '.maat', 'appium'); }
export function appiumEntry(): string {
  return path.join(path.dirname(createRequire(import.meta.url).resolve('appium/package.json')), 'index.js');
}

export async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No Appium port allocated.');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

// Reuse WDIO's service for owned server startup and process-tree shutdown.
export async function startOwnedServer() {
  logger.setLevel('@wdio/appium-service', 'silent');
  process.env.APPIUM_HOME = appiumHome();
  const port = await availablePort();
  const caps = [{ platformName: 'Android', 'appium:automationName': 'UiAutomator2' }];
  const config = { hostname: '127.0.0.1', port, path: '/', capabilities: caps };
  const launcher = new AppiumLauncher({
    args: { address: '127.0.0.1', port, basePath: '/' },
  }, caps, config);
  try { await launcher.onPrepare(); } catch (error) { await launcher.onComplete(1, config, caps); throw error; }
  return { url: `http://127.0.0.1:${port}/`, close: () => launcher.onComplete(0, config, caps) };
}
