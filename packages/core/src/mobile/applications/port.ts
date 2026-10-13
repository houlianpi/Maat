import type { LifecycleTarget } from '../contracts/lifecycle.ts';

/**
 * The only application capabilities exposed by the read-only inspection seam. They identify an
 * installed application; filesystem paths, endpoint data and Session capabilities do not belong
 * in this view.
 */
export type ApplicationCapabilities =
  | Readonly<{ 'appium:appPackage': string; 'appium:bundleId'?: never }>
  | Readonly<{ 'appium:bundleId': string; 'appium:appPackage'?: never }>;

const applicationFactBrand: unique symbol = Symbol('ApplicationFact');

/** Host-safe installed-application facts, matching the existing name/id/capabilities semantics. */
export type ApplicationFact = Readonly<{
  name: string;
  id: string;
  capabilities: ApplicationCapabilities;
  [applicationFactBrand]: true;
}>;

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  return (
    keys.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key))
  );
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate backend application metadata at the internal boundary. Unknown top-level fields and
 * nested capabilities are rejected rather than copied, so routing data, paths and Session details
 * cannot cross this seam through a non-fresh object.
 */
export function createApplicationFact(target: LifecycleTarget, value: unknown): ApplicationFact {
  const invalid = () => new Error(`Invalid ${target.identity.platform} application fact.`);
  if (!isRecord(value) || !hasExactKeys(value, ['name', 'id', 'capabilities'])) throw invalid();
  const { name, id, capabilities } = value;
  if (!isNonemptyString(name) || !isNonemptyString(id) || !isRecord(capabilities)) throw invalid();

  const capabilityName =
    target.identity.platform === 'android' ? 'appium:appPackage' : 'appium:bundleId';
  if (
    !hasExactKeys(capabilities, [capabilityName]) ||
    !isNonemptyString(capabilities[capabilityName]) ||
    capabilities[capabilityName] !== id
  )
    throw invalid();

  const safeCapabilities: ApplicationCapabilities =
    target.identity.platform === 'android'
      ? Object.freeze({ 'appium:appPackage': id })
      : Object.freeze({ 'appium:bundleId': id });
  return Object.freeze({
    name,
    id,
    capabilities: safeCapabilities,
    [applicationFactBrand]: true as const,
  });
}

/**
 * G3 read-only seam. The lifecycle target supplies the exact device identity and endpoint; raw
 * serials, UDIDs, endpoint strings and other routing IDs are deliberately not accepted.
 */
export interface ApplicationInspectionPort {
  inspect(
    target: LifecycleTarget,
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly ApplicationFact[]>;
}
