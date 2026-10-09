import type { SetupCapability, SetupCapabilityId, SetupSnapshot } from '@houlianpi/maat-core';
import { setupMessage, type SetupLocale } from './setup-i18n.ts';

const ui = {
  en: {
    title: 'Maat · macOS',
    capability: 'Test capability',
    ready: 'Ready',
    partial: 'Partially ready',
    needsSetup: 'Setup required',
    reading: 'Read the UI',
    interaction: 'Interact with apps and run assertions',
    screenshot: 'Screenshot Evidence',
    optional: 'Optional enhancements',
    normal: 'Ready',
    unknown: 'Not checked',
    skipped: 'Skipped for now',
    automation: 'Automation Mode',
    video: 'video recording',
    optionalMissing: (items: string) => `${items} not configured (does not affect testing)`,
    optionalReady: 'All configured',
    next: 'Next',
    start: 'Start testing',
    minutes: (value: number) => `about ${value} min`,
    separator: ': ',
    aside: (value: string) => ` (${value})`,
    doctorTitle: 'Maat · macOS engineering diagnostics',
    conclusion: 'Conclusion',
    conclusions: {
      blocked: 'The test environment needs attention',
      partial: 'Core testing is available; optional enhancements remain',
      ready: 'The test environment is fully ready',
    },
    checkedAt: 'Checked at',
    core: 'Core capabilities',
    optionalSection: 'Optional enhancements (do not affect normal functional testing)',
    details: 'Processes, versions, and detection evidence',
    commands: 'Suggested commands',
  },
  'zh-CN': {
    title: 'Maat · macOS',
    capability: '测试能力',
    ready: '完全可用',
    partial: '部分可用',
    needsSetup: '需要设置',
    reading: '读取界面',
    interaction: '操作应用和断言',
    screenshot: '截图 Evidence',
    optional: '可选增强',
    normal: '正常',
    unknown: '尚未检测',
    skipped: '已暂时跳过',
    automation: 'Automation Mode',
    video: '视频录制',
    optionalMissing: (items: string) => `${items}尚未配置（不影响测试）`,
    optionalReady: '均已配置',
    next: '下一步',
    start: '开始测试',
    minutes: (value: number) => `约 ${value} 分钟`,
    separator: '：',
    aside: (value: string) => `（${value}）`,
    doctorTitle: 'Maat · macOS 工程诊断',
    conclusion: '结论',
    conclusions: {
      blocked: '测试环境需要处理',
      partial: '核心测试可用，存在可选增强项',
      ready: '测试环境完全就绪',
    },
    checkedAt: '检查时间',
    core: '核心能力',
    optionalSection: '可选增强（不影响普通功能测试）',
    details: '进程、版本与检测依据',
    commands: '建议命令',
  },
} as const;

export function setupPanel(snapshot: SetupSnapshot, locale: SetupLocale = 'en'): string[] {
  const text = ui[locale];
  const visibleCapabilityIds = new Set(['uiInteraction', 'accessibility', 'screenCapture']);
  const visibleCapabilities = snapshot.capabilities.filter((capability) =>
    visibleCapabilityIds.has(capability.id),
  );
  const coreReady =
    visibleCapabilities.length === visibleCapabilityIds.size &&
    visibleCapabilities.every((capability) => ['ready', 'skipped'].includes(capability.status));
  const capability = (id: SetupCapabilityId) =>
    snapshot.capabilities.find((candidate) => candidate.id === id);
  const userStatus = (item: SetupCapability | undefined) => {
    if (!item) return text.unknown;
    if (item.status === 'ready') return text.normal;
    if (item.status === 'skipped') return text.skipped;
    return setupMessage(locale, item.messageKey);
  };
  const optionalCandidates: Array<string | undefined> = [
    capability('automationMode')?.status === 'ready' ? undefined : text.automation,
    capability('videoRecording')?.status === 'ready' ? undefined : text.video,
  ];
  const optionalMissing = optionalCandidates.filter((value): value is string => Boolean(value));
  return [
    text.title,
    '',
    `${text.capability}${text.separator}${coreReady || snapshot.readiness === 'ready' ? text.ready : snapshot.readiness === 'partially-ready' ? text.partial : text.needsSetup}`,
    `1. ${text.reading}${text.separator}${userStatus(capability('accessibility'))}`,
    `2. ${text.interaction}${text.separator}${userStatus(capability('uiInteraction'))}`,
    `3. ${text.screenshot}${text.separator}${userStatus(capability('screenCapture'))}`,
    `4. ${text.optional}${text.separator}${optionalMissing.length ? text.optionalMissing(optionalMissing.join(locale === 'zh-CN' ? '、' : ', ')) : text.optionalReady}`,
    '',
    coreReady
      ? `${text.next}${text.separator}${text.start}`
      : snapshot.recommendedAction
        ? `${text.next}${text.separator}${setupMessage(locale, snapshot.recommendedAction.labelKey)}${snapshot.recommendedAction.estimatedMinutes ? text.aside(text.minutes(snapshot.recommendedAction.estimatedMinutes)) : ''}`
        : `${text.next}${text.separator}${text.start}`,
  ];
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'string') {
    const plain = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
    return plain.length > 2_000
      ? `${plain.slice(0, 2_000)}… [${plain.length - 2_000} characters omitted]`
      : plain;
  }
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

const capabilityLabels: Record<SetupLocale, Record<SetupCapabilityId, string>> = {
  en: {
    appiumServer: 'Appium service',
    mac2Driver: 'Mac2 Driver',
    automationMode: 'Automation Mode',
    accessibility: 'Read the UI',
    uiInteraction: 'App interaction and assertions',
    screenCapture: 'Screenshot Evidence',
    videoRecording: 'Video recording',
    fullDiskAccess: 'Attachment access',
  },
  'zh-CN': {
    appiumServer: 'Appium 服务',
    mac2Driver: 'Mac2 Driver',
    automationMode: 'Automation Mode',
    accessibility: '读取界面',
    uiInteraction: '操作应用和断言',
    screenCapture: '截图 Evidence',
    videoRecording: '视频录制',
    fullDiskAccess: '附件访问',
  },
};

const statusLabels: Record<SetupLocale, Record<SetupCapability['status'], string>> = {
  en: {
    unknown: 'Not checked',
    checking: 'Checking',
    ready: 'Ready',
    'action-required': 'Action required',
    'restart-required': 'Restart required',
    unavailable: 'Unavailable',
    skipped: 'Skipped',
  },
  'zh-CN': {
    unknown: '尚未检测',
    checking: '检测中',
    ready: '正常',
    'action-required': '需要操作',
    'restart-required': '需要重启',
    unavailable: '不可用',
    skipped: '已跳过',
  },
};

function detailLines(value: unknown, prefix = ''): string[] {
  const sanitized = redact(value);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return [];
  return Object.entries(sanitized as Record<string, unknown>).flatMap(([key, item]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    if (key === 'doctor' && typeof item === 'string') {
      const required = /([0-9]+) required fixes needed/i.exec(item)?.[1] ?? 'unknown';
      const optional = /([0-9]+) optional fixes possible/i.exec(item)?.[1] ?? 'unknown';
      const warnings = item
        .split('\n')
        .map((line) => line.replace(/^.*?(?:WARN Doctor\s+[✖➜]\s*)/, '').trim())
        .filter((line) => /requires user authentication|ffmpeg cannot be found/i.test(line));
      return [
        `- ${name}.requiredFixes: ${required}`,
        `- ${name}.optionalFixes: ${optional}`,
        ...warnings.map((warning) => `- ${name}.warning: ${warning}`),
      ];
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) return detailLines(item, name);
    return [`- ${name}: ${Array.isArray(item) ? item.join(', ') : String(item ?? '—')}`];
  });
}

export function setupDoctor(snapshot: SetupSnapshot, locale: SetupLocale = 'en'): string {
  const text = ui[locale];
  const coreIds = new Set<SetupCapabilityId>([
    'appiumServer',
    'mac2Driver',
    'accessibility',
    'uiInteraction',
    'screenCapture',
  ]);
  const required = snapshot.capabilities.filter((capability) => coreIds.has(capability.id));
  const optional = snapshot.capabilities.filter((capability) => !coreIds.has(capability.id));
  const formatCapability = (capability: SetupCapability) =>
    `- ${capabilityLabels[locale][capability.id]}: ${statusLabels[locale][capability.status]}${capability.errorCode ? ` · ${capability.errorCode}` : ''} — ${setupMessage(locale, capability.messageKey)}`;
  const commands = snapshot.capabilities
    .map((capability) => capability.action?.command)
    .filter((command): command is string => Boolean(command));
  return [
    text.doctorTitle,
    '',
    `${text.conclusion}${text.separator}${snapshot.readiness === 'blocked' ? text.conclusions.blocked : snapshot.readiness === 'partially-ready' ? text.conclusions.partial : text.conclusions.ready}`,
    `${text.checkedAt}${text.separator}${snapshot.checkedAt}`,
    '',
    text.core,
    ...required.map(formatCapability),
    '',
    text.optionalSection,
    ...optional.map(formatCapability),
    '',
    text.details,
    ...detailLines({ fingerprint: snapshot.fingerprint, ...snapshot.technicalDetails }),
    ...(commands.length ? ['', text.commands, ...commands.map((command) => `- ${command}`)] : []),
  ].join('\n');
}
