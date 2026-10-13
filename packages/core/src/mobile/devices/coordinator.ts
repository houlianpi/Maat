import { PhoneSessionCreationUncertainError } from '../contracts/device.ts';
import { assertConnectionJobAccess } from '../connection/job-slot.ts';

let activeOwner: symbol | undefined;
let creationBarrier: Readonly<{ state: 'creation-uncertain'; causeCategory: string }> | undefined;

export class MobileBusyError extends Error {
  readonly code = 'mobile-busy';

  constructor() {
    super('Another mobile operation is already in progress.');
    this.name = 'MobileBusyError';
  }
}

type MobileOperationLease = {
  release(): void;
};

function acquireMobileOperation(
  protectedRoute: () => boolean,
  connectionJobOwner?: symbol,
): MobileOperationLease {
  assertConnectionJobAccess(connectionJobOwner);
  assertMobileCreationAllowed(protectedRoute());
  if (activeOwner) throw new MobileBusyError();
  const owner = Symbol('mobile-operation-owner');
  activeOwner = owner;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      if (activeOwner === owner) activeOwner = undefined;
    },
  };
}

export async function runMobileOperation<T>(
  operation: () => Promise<T>,
  protectedRoute: boolean | (() => boolean) = false,
  connectionJobOwner?: symbol,
): Promise<T> {
  const isProtectedRoute =
    typeof protectedRoute === 'function' ? protectedRoute : () => protectedRoute;
  const lease = acquireMobileOperation(isProtectedRoute, connectionJobOwner);
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof PhoneSessionCreationUncertainError ||
      (error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'phone-session-creation-uncertain')
    ) {
      if (isProtectedRoute()) installMobileCreationBarrier('session-create');
    }
    throw error;
  } finally {
    lease.release();
  }
}

/** Internal process-lifetime safety state. There is deliberately no clear operation. */
export function installMobileCreationBarrier(causeCategory: string): void {
  creationBarrier ??= Object.freeze({ state: 'creation-uncertain', causeCategory });
}

export function assertMobileCreationAllowed(protectedRoute: boolean): void {
  if (protectedRoute && creationBarrier) throw new PhoneSessionCreationUncertainError();
}

export function isMobilePlatform(id: string): id is 'android' | 'ios' {
  return id === 'android' || id === 'ios';
}
