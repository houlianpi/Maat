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
  const title =
    input.state === 'checking'
      ? '正在检查 macOS 测试环境'
      : input.state === 'unknown'
        ? '尚未检查 macOS 测试环境'
        : readiness === 'ready'
          ? 'macOS 测试环境已就绪'
          : readiness === 'partially-ready'
            ? 'macOS 测试环境部分可用'
            : '完成一个设置后即可测试 macOS';
  const summary =
    input.state === 'checking'
      ? '正在确认应用操作与 Evidence 能力。'
      : input.state === 'unknown'
        ? '选择 macOS 后，Maat 会自动检查测试能力。'
        : readiness === 'ready'
          ? '应用操作、业务断言和 Evidence 均可使用。'
          : readiness === 'partially-ready'
            ? '功能测试可以继续，部分 Evidence 能力暂不可用。'
            : (blocking[0]?.summary ?? '需要完成 macOS 测试环境设置。');
  return {
    platform: input.platform,
    state,
    readiness,
    title,
    summary,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    capabilities: ordered,
    available: ordered
      .filter((capability) => capability.status === 'ready')
      .map((capability) => capability.summary),
    unavailable: ordered
      .filter((capability) => !['ready', 'skipped'].includes(capability.status))
      .map((capability) => capability.summary),
    ...(recommended ? { recommendedAction: recommended as SetupAction } : {}),
    canContinue: ordered.length > 0 && !blocking.length,
    restartRequired,
    fingerprint: input.fingerprint ?? {},
    ...(input.technicalDetails ? { technicalDetails: input.technicalDetails } : {}),
  };
}
