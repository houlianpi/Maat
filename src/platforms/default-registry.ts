import path from 'node:path';
import type { BrowserManager } from '../browser/browser-manager.ts';
import { platformRoot } from '../projects/layout.ts';
import { AndroidPlatformAdapter } from './android/android-adapter.ts';
import { IosPlatformAdapter } from './ios/ios-adapter.ts';
import { MacosPlatformAdapter } from './macos/macos-adapter.ts';
import { PlatformRegistry } from './registry.ts';
import { WebPlatformAdapter } from './web/web-adapter.ts';

/** Composition root for built-in adapters. Maat Core remains implementation-agnostic. */
export function createDefaultPlatformRegistry(
  base = path.resolve('maat-tests'),
  browser?: BrowserManager,
): PlatformRegistry {
  return new PlatformRegistry([
    new WebPlatformAdapter(platformRoot(base, 'web'), browser),
    new AndroidPlatformAdapter(platformRoot(base, 'android')),
    new IosPlatformAdapter(platformRoot(base, 'ios')),
    new MacosPlatformAdapter(platformRoot(base, 'macos')),
  ]);
}
