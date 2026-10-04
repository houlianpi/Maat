import path from 'node:path';
import { adapterRoot } from '../core/cases/paths.ts';
import { AndroidPlatformAdapter } from './android/android-adapter.ts';
import { IosPlatformAdapter } from './ios/ios-adapter.ts';
import { MacosPlatformAdapter } from './macos/macos-adapter.ts';
import { PlatformRegistry } from '../core/platforms/registry.ts';
import { WebPlatformAdapter } from './web/web-adapter.ts';

/** Composition root for built-in adapters. Maat Core remains implementation-agnostic. */
export function createDefaultPlatformRegistry(base = path.resolve('maat-tests')): PlatformRegistry {
  return new PlatformRegistry([
    new WebPlatformAdapter(adapterRoot(base, 'web')),
    new AndroidPlatformAdapter(adapterRoot(base, 'android')),
    new IosPlatformAdapter(adapterRoot(base, 'ios')),
    new MacosPlatformAdapter(adapterRoot(base, 'macos')),
  ]);
}
