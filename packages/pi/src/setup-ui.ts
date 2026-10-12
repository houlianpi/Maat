import type { SetupCapability, SetupCapabilityId, SetupSnapshot } from '@houlianpi/maat-core';
import { setupMessage, type SetupLocale } from './setup-i18n.ts';
import { MAAT_SETUP_SKILL_PATH } from './system-prompt.ts';
import path from 'node:path';

const ui = {
  en: {
    title: 'Maat · macOS',
    capability: 'Execution capability',
    ready: 'Ready',
    partial: 'Partially ready',
    needsSetup: 'Setup required',
    reading: 'Read the UI',
    interaction: 'Interact with apps',
    screenshot: 'Screenshot observation',
    optional: 'Optional enhancements',
    normal: 'Ready',
    unknown: 'Not checked',
    skipped: 'Skipped for now',
    automation: 'Automation Mode',
    video: 'video recording',
    optionalMissing: (items: string) => `${items} not configured`,
    optionalReady: 'All configured',
    next: 'Next',
    start: 'Read the current UI and continue',
    minutes: (value: number) => `about ${value} min`,
    separator: ': ',
    aside: (value: string) => ` (${value})`,
    doctorTitle: 'Maat · macOS engineering diagnostics',
    conclusion: 'Conclusion',
    conclusions: {
      blocked: 'The execution environment needs attention',
      partial: 'Core execution is available; optional capabilities remain',
      ready: 'The execution environment is ready',
    },
    checkedAt: 'Checked at',
    core: 'Core capabilities',
    optionalSection: 'Optional capabilities',
    details: 'Processes, versions, and detection evidence',
    commands: 'Suggested commands',
  },
  'zh-CN': {
    title: 'Maat · macOS',
    capability: '操作能力',
    ready: '完全可用',
    partial: '部分可用',
    needsSetup: '需要设置',
    reading: '读取界面',
    interaction: '操作应用',
    screenshot: '截图观察',
    optional: '可选增强',
    normal: '正常',
    unknown: '尚未检测',
    skipped: '已暂时跳过',
    automation: 'Automation Mode',
    video: '视频录制',
    optionalMissing: (items: string) => `${items}尚未配置`,
    optionalReady: '均已配置',
    next: '下一步',
    start: '读取当前界面后继续任务',
    minutes: (value: number) => `约 ${value} 分钟`,
    separator: '：',
    aside: (value: string) => `（${value}）`,
    doctorTitle: 'Maat · macOS 工程诊断',
    conclusion: '结论',
    conclusions: {
      blocked: '操作环境需要处理',
      partial: '核心操作可用，存在未就绪的可选能力',
      ready: '操作环境已就绪',
    },
    checkedAt: '检查时间',
    core: '核心能力',
    optionalSection: '可选能力',
    details: '进程、版本与检测依据',
    commands: '建议命令',
  },
} as const;

export function setupAgentContext(snapshot: SetupSnapshot, locale: SetupLocale = 'en'): string {
  const script = path.join(path.dirname(MAAT_SETUP_SKILL_PATH), 'scripts', 'android-tools.mjs');
  const quoted =
    process.platform === 'win32'
      ? `'${script.replace(/'/g, "''")}'`
      : `'${script.replace(/'/g, "'\\''")}'`;
  const commands: Record<string, string> = {
    'install-adb': `node ${quoted} prepare`,
    'configure-android-sdk': `node ${quoted} prepare`,
    'start-adb': `node ${quoted} adb`,
    'start-appium': `node ${quoted} appium`,
    'install-appium': 'npm install --global appium@3.7.0',
    'install-uiautomator2': 'appium driver install uiautomator2@8.7.0',
    'install-xcuitest': 'appium driver install xcuitest@12.13.2',
  };
  const facts = snapshot.technicalDetails ?? {};
  const inheritedWarnings = Array.isArray(facts.androidToolsWarnings)
    ? facts.androidToolsWarnings.flatMap((item: unknown) => {
        if (!item || typeof item !== 'object' || !('code' in item)) return [];
        if (item.code !== 'ANDROID_SDK_INVALID' && item.code !== 'ANDROID_SDK_ROOT_CONFLICT')
          return [];
        return [
          {
            code: item.code,
            summary:
              locale === 'zh-CN'
                ? '继承的 SDK 路径不可用；保留原配置，按当前工具检查结果继续准备。'
                : 'The inherited SDK path is unusable; preserve it and continue preparation using the current tool checks.',
          },
        ];
      })
    : [];
  const action = snapshot.recommendedAction;
  const command = action
    ? snapshot.platform === 'android'
      ? commands[action.id]
      : snapshot.platform === 'ios'
        ? (action.command ??
          (action.id === 'install-appium' || action.id === 'install-xcuitest'
            ? commands[action.id]
            : undefined))
        : action.command
    : undefined;
  return `Maat setup facts:\n${JSON.stringify({
    platform: snapshot.platform,
    preparationOnly: true,
    canContinue: snapshot.canContinue,
    capabilities: snapshot.capabilities.map((item) => ({
      id: item.id,
      status: item.status,
      ...(item.errorCode ? { errorCode: item.errorCode } : {}),
      message: setupMessage(locale, item.messageKey),
    })),
    ...(snapshot.platform === 'android'
      ? {
          toolsSource: facts.androidToolsSource,
          toolsReason: facts.androidToolsReason,
          inheritedSdkWarnings: inheritedWarnings,
          adbServer: facts.adbServer,
          appiumCli: facts.appiumCli,
          setupSkill: MAAT_SETUP_SKILL_PATH,
        }
      : {}),
    ...(snapshot.platform === 'ios'
      ? {
          appiumCli: facts.appiumCli,
          xcodeVersion: facts.xcodeVersion,
          wda: facts.wda,
          setupSkill: MAAT_SETUP_SKILL_PATH,
          preparationGuidance:
            'Use the iOS section of the setup Skill, not project source or Android SDK tools. Reuse Xcode, XCUITest, existing Appium and WDA verified against the selected physical iPhone; an open WDA port or simulator is not device proof. Do not ask for Apple credentials or silently change signing, Developer Mode, trust or device selection. WDA signing/deployment is not verified by doctor.',
          coldReadiness:
            'IOS_DEVICE_LOCK_STATE_UNKNOWN blocks cold Session initialization by default. CoreDevice passcodeRequired:false and unlockedSinceBoot:true do not prove current unlock/screen state. Only explicit user authorization for this attempt after explaining WDA effects permits check_device_ready({allowWdaInitialization:true}); it is transient, not unlock proof or signing authorization. Live WDA unlock and real UI observations are still required. IOS_WDA_SECURITY_REJECTED may involve signing, entitlements or profile trust; if developer App trust is absent or already granted, inspect signing/profile expiry, not a retry loop.',
          serviceStartup:
            'Use the host-supported tracked background mechanism for the selected endpoint. Preserve existing services. If unavailable, report the host limitation; do not count manual terminal startup as autonomous setup success.',
        }
      : {}),
    nextStep: action
      ? {
          id: action.id,
          ...(command ? { command } : {}),
          instruction: setupMessage(locale, action.labelKey),
        }
      : snapshot.canContinue
        ? {
            tool:
              snapshot.platform === 'android' || snapshot.platform === 'ios'
                ? 'check_device_ready'
                : 'exe_js',
            instruction: 'Read the current UI before continuing.',
          }
        : {
            instruction:
              'Use the platform section of the setup Skill to diagnose the failed check; do not inspect project source or ask the user to locate tool paths.',
          },
    ...(snapshot.platform === 'android'
      ? {
          preparationGuidance:
            'Inherited SDK variables are candidates, not user requirements. Explain their warning and use verified tools. Do authorized preparation directly. Ask only for user-only actions or actual license acceptance. Do not modify global configuration, request repeated permission to look for tools, or read Maat source to recover.',
          serviceStartup:
            'This appium command is foreground. Use the host-supported background mechanism if available and retain its handle. If no background mechanism is available, report that exact host limitation; do not repeatedly run the foreground command with a timeout or falsely claim autonomous setup passed.',
        }
      : {}),
  })}`;
}

export function setupPanel(snapshot: SetupSnapshot, locale: SetupLocale = 'en'): string[] {
  if (snapshot.platform === 'android' || snapshot.platform === 'ios') {
    const chinese = locale === 'zh-CN';
    const summary =
      snapshot.state === 'checking'
        ? chinese
          ? '结论：正在检查，尚不能开始手机任务'
          : 'Conclusion: checking; phone tasks cannot start yet'
        : snapshot.state === 'unknown'
          ? chinese
            ? '结论：尚不能开始手机任务，尚未检查准备条件'
            : 'Conclusion: phone tasks cannot start; preparation has not been checked'
          : snapshot.canContinue
            ? chinese
              ? '结论：尚不能开始手机任务。电脑侧准备已完成，手机操作通道尚需确认'
              : 'Conclusion: phone tasks cannot start yet. Computer preparation is complete; verify the phone control channel'
            : chinese
              ? '结论：尚不能开始手机任务，还需完成以下准备'
              : 'Conclusion: phone tasks cannot start; preparation still needs attention';
    const next = snapshot.recommendedAction
      ? setupMessage(locale, snapshot.recommendedAction.labelKey)
      : snapshot.canContinue
        ? chinese
          ? '检查手机通道并读取当前界面'
          : 'Check the phone channel and read its current UI'
        : chinese
          ? '检查环境，确认具体缺项'
          : 'Check the environment for the specific missing condition';
    return [
      `Maat · ${snapshot.platform === 'ios' ? 'iOS' : 'Android'}`,
      summary,
      ...(snapshot.platform === 'android' &&
      Array.isArray(snapshot.technicalDetails?.androidToolsWarnings) &&
      snapshot.technicalDetails.androidToolsWarnings.length > 0
        ? [
            chinese
              ? '旧 SDK 路径不可用，保留原配置并继续检查可用的连接工具。'
              : 'The old SDK path is unusable; preserve it and continue checking available connection tools.',
          ]
        : []),
      ...snapshot.capabilities.map((item) => `- ${setupMessage(locale, item.messageKey)}`),
      `${chinese ? '下一步：' : 'Next: '}${next}`,
    ];
  }
  const text = ui[locale];
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
    `${text.capability}${text.separator}${snapshot.readiness === 'ready' ? text.ready : snapshot.readiness === 'partially-ready' ? text.partial : text.needsSetup}`,
    `1. ${text.reading}${text.separator}${userStatus(capability('accessibility'))}`,
    `2. ${text.interaction}${text.separator}${userStatus(capability('uiInteraction'))}`,
    `3. ${text.screenshot}${text.separator}${userStatus(capability('screenCapture'))}`,
    `4. ${text.optional}${text.separator}${optionalMissing.length ? text.optionalMissing(optionalMissing.join(locale === 'zh-CN' ? '、' : ', ')) : text.optionalReady}`,
    '',
    snapshot.canContinue
      ? `${text.next}${text.separator}${text.start}`
      : snapshot.recommendedAction
        ? `${text.next}${text.separator}${setupMessage(locale, snapshot.recommendedAction.labelKey)}${snapshot.recommendedAction.estimatedMinutes ? text.aside(text.minutes(snapshot.recommendedAction.estimatedMinutes)) : ''}`
        : `${text.next}${text.separator}${text.unknown}`,
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
    appiumCli: 'Appium installation',
    adbServer: 'ADB connection daemon',
    adb: 'ADB',
    androidSdk: 'Android tools',
    uiautomator2Driver: 'Android automation driver',
    androidDevice: 'Android phone',
    xcode: 'Xcode',
    xcuitestDriver: 'iOS automation driver',
    iosDevice: 'iPhone',
    iosDeveloperMode: 'iPhone Developer Mode',
    mac2Driver: 'Mac2 Driver',
    automationMode: 'Automation Mode',
    accessibility: 'Read the UI',
    uiInteraction: 'App interaction',
    screenCapture: 'Screenshot observation',
    videoRecording: 'Video recording',
    fullDiskAccess: 'Attachment access',
  },
  'zh-CN': {
    appiumServer: 'Appium 服务',
    appiumCli: '连接服务软件',
    adbServer: 'Android 连接服务',
    adb: 'Android 连接工具',
    androidSdk: 'Android 工具',
    uiautomator2Driver: 'Android 自动化驱动',
    androidDevice: 'Android 手机',
    xcode: 'Xcode',
    xcuitestDriver: 'iOS 自动化驱动',
    iosDevice: 'iPhone',
    iosDeveloperMode: 'iPhone 开发者模式',
    mac2Driver: 'Mac2 Driver',
    automationMode: 'Automation Mode',
    accessibility: '读取界面',
    uiInteraction: '操作应用',
    screenCapture: '截图观察',
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
  if (snapshot.platform === 'android' || snapshot.platform === 'ios')
    return [
      ...setupPanel(snapshot, locale),
      '',
      `${locale === 'zh-CN' ? '检查时间：' : 'Checked at: '}${snapshot.checkedAt}`,
      locale === 'zh-CN'
        ? '诊断不会创建手机 Session，也不代表手机操作或业务结果已验证。'
        : 'Diagnosis does not create a phone Session or prove phone operation or business outcomes.',
      ...snapshot.capabilities.map(
        (item) =>
          `- ${item.id}: ${statusLabels[locale][item.status]}${item.errorCode ? ` · ${item.errorCode}` : ''}`,
      ),
      ...detailLines(snapshot.technicalDetails),
      ...snapshot.capabilities.flatMap((item) =>
        item.action?.command ? [`- ${item.action.command}`] : [],
      ),
    ].join('\n');
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
