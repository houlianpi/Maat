import path from 'node:path';
import { AndroidPlatformAdapter } from './android/android-adapter.ts';
import { IosPlatformAdapter } from './ios/ios-adapter.ts';
import { MacosPlatformAdapter } from './macos/macos-adapter.ts';
import { PlatformRegistry } from '../core/platforms/registry.ts';
import { WebPlatformAdapter } from './web/web-adapter.ts';

/** Composition root for built-in adapters. Maat Core remains implementation-agnostic. */
export function createDefaultPlatformRegistry(workspaceRoot = process.cwd()): PlatformRegistry {
  return new PlatformRegistry([
    // Retain the existing read-only named-profile location, not a platform test root.
    new WebPlatformAdapter(path.resolve(workspaceRoot, 'maat-tests/web')),
    new AndroidPlatformAdapter(),
    new IosPlatformAdapter(),
    new MacosPlatformAdapter(),
  ]);
}
