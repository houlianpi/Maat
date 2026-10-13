import type { MobilePlatform } from '../contracts/device.ts';
import type { LifecycleTarget } from '../contracts/lifecycle.ts';

declare const preparationFactsKeyBrand: unique symbol;
declare const preparationPlanKeyBrand: unique symbol;
declare const preparationGrantKeyBrand: unique symbol;

export type PreparationFactsKey = string & { readonly [preparationFactsKeyBrand]: true };
export type PreparationPlanKey = string & { readonly [preparationPlanKeyBrand]: true };
export type PreparationGrantKey = string & { readonly [preparationGrantKeyBrand]: true };

export type PreparationOperation =
  | 'install-ios-wda'
  | 'resign-ios-wda'
  | 'connect-appium-automation-backend'
  | 'restart-user-appium'
  | 'reboot-ios-device'
  | 'deploy-android-helper';

export type PreparationFactsView = Readonly<{
  key: PreparationFactsKey;
  platform: MobilePlatform;
  capturedAt: string;
  policyVersion: string;
  compatibility: 'compatible' | 'incompatible' | 'unknown';
  blockerCategories: readonly string[];
}>;

export type PreparationPlanView = Readonly<{
  key: PreparationPlanKey;
  state: 'satisfied' | 'waiting-user' | 'authorization-required' | 'executable' | 'blocked';
  operations: readonly PreparationOperation[];
  compatibility: PreparationFactsView['compatibility'];
  blockerCategories: readonly string[];
}>;

export type PreparationResultView = Readonly<{
  state: 'satisfied' | 'completed' | 'waiting-user' | 'blocked' | 'uncertain' | 'failed';
  operation?: PreparationOperation;
  compatibility: PreparationFactsView['compatibility'];
  blockerCategories: readonly string[];
  errorCategory?: string;
}>;

/**
 * G2 contract only: there is no production consumer in G2. Preparation moves behind this port in
 * G3P. Legacy preparation can be retired only after migration and the G5/G5M/G6/G7 deletion gates
 * plus explicit deletion authorization.
 */
export interface MobilePreparationPort {
  inspect(target: LifecycleTarget, signal?: AbortSignal): Promise<PreparationFactsView>;
  plan(target: LifecycleTarget, facts: PreparationFactsKey): Promise<PreparationPlanView>;
  execute(
    target: LifecycleTarget,
    plan: PreparationPlanKey,
    grant: PreparationGrantKey | undefined,
    signal?: AbortSignal,
  ): Promise<PreparationResultView>;
}
