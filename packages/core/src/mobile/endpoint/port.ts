import type { LifecycleTarget } from '../contracts/lifecycle.ts';

/**
 * Read-only endpoint facts. This is not Session readiness, device readiness, or proof that a
 * business operation can succeed. The endpoint itself remains backend-private.
 */
const endpointStatusBrand: unique symbol = Symbol('EndpointStatusView');

export type EndpointStatusView =
  | Readonly<{ state: 'not-configured'; [endpointStatusBrand]: true }>
  | Readonly<{ state: 'configured'; [endpointStatusBrand]: true }>
  | Readonly<{
      state: 'reachable';
      compatibility: 'compatible' | 'incompatible' | 'unknown';
      [endpointStatusBrand]: true;
    }>
  | Readonly<{
      state: 'unreachable' | 'unknown';
      errorCategory?: string;
      [endpointStatusBrand]: true;
    }>
  | Readonly<{ state: 'error'; errorCategory: string; [endpointStatusBrand]: true }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function validErrorCategory(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Create the sole constructible, immutable endpoint status representation. */
export function createEndpointStatusView(value: unknown): EndpointStatusView {
  if (!isRecord(value) || typeof value.state !== 'string')
    throw new Error('Invalid endpoint status.');

  switch (value.state) {
    case 'not-configured':
      if (!hasExactKeys(value, ['state'])) break;
      return Object.freeze({
        state: 'not-configured' as const,
        [endpointStatusBrand]: true as const,
      });
    case 'configured':
      if (!hasExactKeys(value, ['state'])) break;
      return Object.freeze({
        state: 'configured' as const,
        [endpointStatusBrand]: true as const,
      });
    case 'reachable':
      if (
        !hasExactKeys(value, ['state', 'compatibility']) ||
        (value.compatibility !== 'compatible' &&
          value.compatibility !== 'incompatible' &&
          value.compatibility !== 'unknown')
      )
        break;
      return Object.freeze({
        state: value.state,
        compatibility: value.compatibility,
        [endpointStatusBrand]: true as const,
      });
    case 'unreachable':
    case 'unknown':
      if (
        !hasExactKeys(value, ['state'], ['errorCategory']) ||
        (value.errorCategory !== undefined && !validErrorCategory(value.errorCategory))
      )
        break;
      return Object.freeze({
        state: value.state,
        ...(value.errorCategory === undefined ? {} : { errorCategory: value.errorCategory }),
        [endpointStatusBrand]: true as const,
      });
    case 'error':
      if (
        !hasExactKeys(value, ['state', 'errorCategory']) ||
        !validErrorCategory(value.errorCategory)
      )
        break;
      return Object.freeze({
        state: value.state,
        errorCategory: value.errorCategory,
        [endpointStatusBrand]: true as const,
      });
  }
  throw new Error('Invalid endpoint status.');
}

/**
 * G3 read-only seam. LifecycleTarget is used instead of a bare EndpointKey so a backend can check
 * the already-pinned platform and endpoint without accepting an unscoped routing key.
 */
export interface EndpointStatusPort {
  inspect(target: LifecycleTarget, signal?: AbortSignal): Promise<EndpointStatusView>;
}
