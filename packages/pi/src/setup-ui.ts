import type { SetupSnapshot } from '@houlianpi/maat-core';

function marker(status: string): string {
  if (status === 'ready') return '✓';
  if (status === 'skipped') return '–';
  return '!';
}

export function setupPanel(snapshot: SetupSnapshot): string[] {
  const visibleCapabilityIds = new Set(['uiInteraction', 'accessibility', 'screenCapture']);
  return [
    'Maat · macOS',
    '',
    `测试能力：${snapshot.readiness === 'ready' ? '完全可用' : snapshot.readiness === 'partially-ready' ? '部分可用' : '需要设置'}`,
    ...snapshot.capabilities
      .filter((capability) => visibleCapabilityIds.has(capability.id))
      .map((capability) => `${marker(capability.status)} ${capability.summary}`),
    '',
    snapshot.recommendedAction
      ? `下一步：${snapshot.recommendedAction.label}${snapshot.recommendedAction.estimatedMinutes ? `（约 ${snapshot.recommendedAction.estimatedMinutes} 分钟）` : ''}`
      : '下一步：开始测试',
  ];
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'string')
    return value.length > 2_000
      ? `${value.slice(0, 2_000)}… [${value.length - 2_000} characters omitted]`
      : value;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (/prompt|page.?text|screenshot|payload|image/i.test(key)) return [key, '[omitted]'];
      return [
        key,
        /key|token|secret|password|credential|auth/i.test(key) ? '[redacted]' : redact(item),
      ];
    }),
  );
}

export function setupDoctor(snapshot: SetupSnapshot): string {
  return JSON.stringify(
    redact({
      platform: snapshot.platform,
      state: snapshot.state,
      readiness: snapshot.readiness,
      checkedAt: snapshot.checkedAt,
      fingerprint: snapshot.fingerprint,
      capabilities: snapshot.capabilities.map((capability) => ({
        id: capability.id,
        status: capability.status,
        required: capability.required,
        errorCode: capability.errorCode,
        action: capability.action,
        details: capability.details,
      })),
      technicalDetails: snapshot.technicalDetails,
    }),
    null,
    2,
  );
}
