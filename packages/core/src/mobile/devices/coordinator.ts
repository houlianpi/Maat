let activeOwner: symbol | undefined;

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

function acquireMobileOperation(): MobileOperationLease {
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

export async function runMobileOperation<T>(operation: () => Promise<T>): Promise<T> {
  const lease = acquireMobileOperation();
  try {
    return await operation();
  } finally {
    lease.release();
  }
}

export function isMobilePlatform(id: string): id is 'android' | 'ios' {
  return id === 'android' || id === 'ios';
}
