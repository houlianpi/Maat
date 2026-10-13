import type { LifecycleTarget, LifecycleTargetKey } from '../contracts/lifecycle.ts';
import type { MobileResourceOwnership } from '../contracts/ownership.ts';

declare const sessionKeyBrand: unique symbol;

/**
 * Process-local lifecycle correlation key. The Appium Session handle is backend-private and is
 * intentionally not represented by this type or any Session port result.
 */
export type SessionKey = string & { readonly [sessionKeyBrand]: true };

export type SessionView = Readonly<{
  key: SessionKey;
  target: LifecycleTargetKey;
  platform: LifecycleTarget['identity']['platform'];
  generation: number;
  backend: 'appium';
  state: 'ready' | 'degraded' | 'recovering' | 'closing';
  ownership: MobileResourceOwnership;
}>;

/**
 * G2 contract only: there is no production consumer in G2. Session integration begins at G4.
 * Legacy Session code is retired only after consumers migrate and G5/G5M/G6/G7 plus explicit
 * deletion authorization permit removal.
 */
export interface MobileSessionPort {
  acquire(target: LifecycleTarget, signal?: AbortSignal): Promise<SessionView>;
  inspect(session: SessionKey, signal?: AbortSignal): Promise<SessionView>;
  close(session: SessionKey, signal?: AbortSignal): Promise<void>;
}
