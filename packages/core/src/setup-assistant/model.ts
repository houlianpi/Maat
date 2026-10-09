import type { SetupAction, SetupCapability, SetupSnapshot, SetupState } from './types.ts';

const priority: SetupCapability['id'][] = [
  'appiumServer',
  'mac2Driver',
  'accessibility',
  'uiInteraction',
  'screenCapture',
  'automationMode',
  'fullDiskAccess',
  'videoRecording',
];

export function aggregateSetup(input: {
  platform: string;
  capabilities: SetupCapability[];
  checkedAt?: string;
  fingerprint?: SetupSnapshot['fingerprint'];
  technicalDetails?: Record<string, unknown>;
  waitingForRecheck?: boolean;
  state?: Extract<SetupState, 'unknown' | 'checking'>;
}): SetupSnapshot {
  const ordered = [...input.capabilities].sort(
    (left, right) => priority.indexOf(left.id) - priority.indexOf(right.id),
  );
  const blocking = ordered.filter(
    (capability) => capability.required && !['ready', 'skipped'].includes(capability.status),
  );
  const degraded = ordered.filter(
    (capability) => !capability.required && !['ready', 'skipped'].includes(capability.status),
  );
  const skipped = ordered.filter((capability) => capability.status === 'skipped');
  const restartRequired = ordered.some((capability) => capability.status === 'restart-required');
  const readiness = !ordered.length
    ? 'blocked'
    : blocking.length
      ? 'blocked'
      : degraded.length || skipped.length
        ? 'partially-ready'
        : 'ready';
  const state: SetupState = input.state
    ? input.state
    : input.waitingForRecheck
      ? 'waiting-for-recheck'
      : readiness === 'ready'
        ? 'ready'
        : readiness === 'partially-ready'
          ? 'partially-ready'
          : 'action-required';
  const recommended = [...blocking, ...degraded].find((capability) => capability.action)?.action;
  const titleKey =
    input.state === 'checking'
      ? 'setup.title.checking'
      : input.state === 'unknown'
        ? 'setup.title.unknown'
        : readiness === 'ready'
          ? 'setup.title.ready'
          : readiness === 'partially-ready'
            ? 'setup.title.partial'
            : 'setup.title.blocked';
  const summaryKey =
    input.state === 'checking'
      ? 'setup.summary.checking'
      : input.state === 'unknown'
        ? 'setup.summary.unknown'
        : readiness === 'ready'
          ? 'setup.summary.ready'
          : readiness === 'partially-ready'
            ? 'setup.summary.partial'
            : 'setup.summary.blocked';
  return {
    platform: input.platform,
    state,
    readiness,
    titleKey,
    summaryKey,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    capabilities: ordered,
    available: ordered
      .filter((capability) => capability.status === 'ready')
      .map((capability) => capability.id),
    unavailable: ordered
      .filter((capability) => !['ready', 'skipped'].includes(capability.status))
      .map((capability) => capability.id),
    ...(recommended ? { recommendedAction: recommended as SetupAction } : {}),
    canContinue: ordered.length > 0 && !blocking.length,
    restartRequired,
    fingerprint: input.fingerprint ?? {},
    ...(input.technicalDetails ? { technicalDetails: input.technicalDetails } : {}),
  };
}
