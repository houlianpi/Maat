import { MobileBusyError } from '../devices/coordinator.ts';

let activeOwner: symbol | undefined;

export function acquireConnectionJobSlot(): { owner: symbol; release(): void } {
  if (activeOwner) throw new MobileBusyError();
  const owner = Symbol('connection-job-owner');
  activeOwner = owner;
  let released = false;
  return {
    owner,
    release() {
      if (released) return;
      released = true;
      if (activeOwner === owner) activeOwner = undefined;
    },
  };
}

export function assertConnectionJobAccess(owner?: symbol): void {
  if (activeOwner && activeOwner !== owner) throw new MobileBusyError();
}
