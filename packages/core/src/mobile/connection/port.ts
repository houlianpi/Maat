import type { LifecycleTarget } from '../contracts/lifecycle.ts';
import type { ConnectionJobState } from '../contracts/connection.ts';

declare const connectionJobKeyBrand: unique symbol;
export type ConnectionJobKey = string & { readonly [connectionJobKeyBrand]: true };

export type { ConnectionJobState } from '../contracts/connection.ts';

/** Sanitized job view: routing keys and backend resource handles deliberately remain absent. */
export type ConnectionJobView = Readonly<{
  job: ConnectionJobKey;
  operation: 'prepare' | 'recover';
  state: ConnectionJobState;
  createdAt: string;
  deadlineAt: string;
  completedAt?: string;
  errorCategory?: string;
}>;

/**
 * G2 contract only: there is no production consumer in G2. Connection facade orchestration starts
 * in G3 and preparation execution joins it in G3P. Legacy retirement remains gated on migrated
 * consumers plus G5/G5M/G6/G7 and explicit deletion authorization.
 */
export interface MobileConnectionPort {
  start(
    target: LifecycleTarget,
    operation: ConnectionJobView['operation'],
    deadlineMs: number,
    signal?: AbortSignal,
  ): Promise<ConnectionJobView>;

  query(job: ConnectionJobKey, signal?: AbortSignal): Promise<ConnectionJobView>;
  cancel(job: ConnectionJobKey, signal?: AbortSignal): Promise<ConnectionJobView>;
}
