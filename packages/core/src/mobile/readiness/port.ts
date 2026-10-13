import type { LifecycleTarget } from '../contracts/lifecycle.ts';
import type { SessionKey } from '../session/port.ts';

declare const observationKeyBrand: unique symbol;
export type ObservationKey = string & { readonly [observationKeyBrand]: true };

/** Safe reference only; sensitive source/image payloads stay in their backend-private store. */
export type ReadinessObservation<
  Kind extends 'source' | 'viewport' | 'screenshot' = 'source' | 'viewport' | 'screenshot',
  Generation extends number = number,
> = Readonly<{
  key: ObservationKey;
  kind: Kind;
  capturedAt: string;
  generation: Generation;
}>;

type ReadinessNonReadyResult =
  | Readonly<{ state: 'service-ready' }>
  | Readonly<{
      state: 'human-takeover-required';
      reason: 'locked' | 'pairing' | 'trust' | 'developer-mode' | 'signing' | 'authentication';
    }>
  | Readonly<{ state: 'recovering' }>
  | Readonly<{ state: 'recovery-required'; reasonCategory: string }>
  | Readonly<{ state: 'failed'; errorCategory: string }>;

const readinessReadyProofBrand: unique symbol = Symbol('ReadinessReadyProof');

type ReadinessReadyProof<IncludeScreenshot extends boolean, Generation extends number> = Readonly<{
  [readinessReadyProofBrand]: true;
  phoneUnlocked: true;
  source: ReadinessObservation<'source', Generation>;
  viewport: ReadinessObservation<'viewport', Generation>;
}> &
  (IncludeScreenshot extends true
    ? Readonly<{ screenshot: ReadinessObservation<'screenshot', Generation> }>
    : Readonly<{ screenshot?: never }>);

export type ReadinessReadyResult<
  IncludeScreenshot extends boolean,
  Generation extends number = number,
> = IncludeScreenshot extends boolean
  ? Readonly<{
      state: 'ready';
      generation: Generation;
      proof: ReadinessReadyProof<IncludeScreenshot, Generation>;
    }>
  : never;

export type ReadinessResult<
  IncludeScreenshot extends boolean = boolean,
  Generation extends number = number,
> = ReadinessNonReadyResult | ReadinessReadyResult<IncludeScreenshot, Generation>;

export type ReadinessReadyResultInput<
  IncludeScreenshot extends boolean,
  Generation extends number = number,
> = Readonly<{
  generation: Generation;
  phoneUnlocked: true;
  source: ReadinessObservation<'source', Generation>;
  viewport: ReadinessObservation<'viewport', Generation>;
}> &
  (IncludeScreenshot extends true
    ? Readonly<{ screenshot: ReadinessObservation<'screenshot', Generation> }>
    : Readonly<{ screenshot?: never }>);

export function createReadinessReadyResult<Generation extends number>(
  options: Readonly<{ includeScreenshot: true }>,
  input: ReadinessReadyResultInput<true, Generation>,
): ReadinessReadyResult<true, Generation>;
export function createReadinessReadyResult<Generation extends number>(
  options: Readonly<{ includeScreenshot: false }>,
  input: ReadinessReadyResultInput<false, Generation>,
): ReadinessReadyResult<false, Generation>;
export function createReadinessReadyResult(
  options: Readonly<{ includeScreenshot: boolean }>,
  input: ReadinessReadyResultInput<boolean>,
): ReadinessReadyResult<boolean> {
  const { generation, source, viewport } = input;
  const screenshot = 'screenshot' in input ? input.screenshot : undefined;
  if (source.generation !== generation || viewport.generation !== generation) {
    throw new Error('Ready observations must match the readiness generation.');
  }
  if (options.includeScreenshot && screenshot === undefined) {
    throw new Error('A screenshot observation is required when requested.');
  }
  if (screenshot !== undefined && screenshot.generation !== generation) {
    throw new Error('Ready observations must match the readiness generation.');
  }

  const sharedProof = {
    [readinessReadyProofBrand]: true as const,
    phoneUnlocked: true as const,
    source: Object.freeze({ ...source }),
    viewport: Object.freeze({ ...viewport }),
  };
  if (options.includeScreenshot) {
    const proof = Object.freeze({
      ...sharedProof,
      screenshot: Object.freeze({ ...screenshot! }),
    });
    return Object.freeze({ state: 'ready' as const, generation, proof });
  }
  const proof = Object.freeze(sharedProof);
  return Object.freeze({ state: 'ready' as const, generation, proof });
}

/**
 * G2 contract only: there is no production consumer in G2. Readiness integration begins at G4.
 * Legacy probes are retired only after consumers migrate and G5/G5M/G6/G7 plus explicit deletion
 * authorization permit removal.
 */
export interface MobileReadinessPort {
  probe(
    target: LifecycleTarget,
    session: SessionKey,
    options: Readonly<{ includeScreenshot: true }>,
    signal?: AbortSignal,
  ): Promise<ReadinessResult<true>>;

  probe(
    target: LifecycleTarget,
    session: SessionKey,
    options: Readonly<{ includeScreenshot: false }>,
    signal?: AbortSignal,
  ): Promise<ReadinessResult<false>>;
}
