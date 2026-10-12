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

export function setupAgentContext(
  snapshot: SetupSnapshot,
  locale: SetupLocale = 'en',
  options: { prepareAvailable?: boolean } = {},
): string {
  const script = path.join(path.dirname(MAAT_SETUP_SKILL_PATH), 'scripts', 'android-tools.mjs');
  const quoted =
    process.platform === 'win32'
      ? `'${script.replace(/'/g, "''")}'`
      : `'${script.replace(/'/g, "'\\''")}'`;
  const commands: Record<string, string> = {
    'install-adb': `node ${quoted} prepare`,
    'configure-android-sdk': `node ${quoted} prepare`,
    'start-adb': `node ${quoted} adb`,
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
  const mobile = snapshot.platform === 'android' || snapshot.platform === 'ios';
  const serviceStartup = options.prepareAvailable
    ? {
        status: 'available',
        tool: 'prepare_mobile',
        instruction:
          'Use prepare_mobile({action:"start-appium",taskId:null,waitSeconds:20}) for the selected endpoint. Poll the same returned taskId with prepare_mobile({action:"status",taskId:<returned taskId>,waitSeconds:20}); wait expiry never restarts work. Preserve existing services. Ready means serviceResponding only, not deviceReady or business success.',
      }
    : {
        status: 'unavailable',
        category: 'HOST_TRACKED_PREPARATION_UNAVAILABLE',
        instruction:
          'This host has no tracked mobile preparation capability; report this limitation. Autonomous Appium startup is unavailable. Preserve existing services; do not bypass this limitation with foreground command timeouts or untracked shell startup.',
      };
  const command =
    mobile && action?.id === 'start-appium'
      ? undefined
      : action
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
    ...(mobile ? { serviceStartup } : {}),
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
            'Use the iOS section of the setup Skill, not project source or Android SDK tools. Diagnose actual conditions and reuse Xcode, XCUITest, the exact selected Appium endpoint and device-bound WDA. A valid local build is not proof of WDA installed on the phone; an open WDA port or simulator is not device proof. Do not ask for Apple credentials or silently change signing, Developer Mode, trust or device selection. Doctor does not verify WDA signing or phone installation.',
          configurationGuidance:
            locale === 'zh-CN'
              ? 'IOS_WDA_CONFIGURATION_CONFLICT 表示签名 hint 不匹配/手机有其它 testRunner，避免 Appium cleanup 删除。IOS_READINESS_UNSUPPORTED 表示 useNewWDA、autoAcceptAlerts/autoDismissAlerts、禁 prebuilt、强 preinstalled 或自定义 suffix 不符合安全复用路径。只报告明确配置问题并只读核查，不自动改配置、重装、改 Team、删除组件或改变用户服务/手机数据；首次安装授权不允许重签名，也不能绕过配置冲突。'
              : 'IOS_WDA_CONFIGURATION_CONFLICT means signing hints mismatch/another phone testRunner, preventing Appium cleanup deletion. IOS_READINESS_UNSUPPORTED means useNewWDA, autoAcceptAlerts/autoDismissAlerts, disabled prebuilt, forced preinstalled or custom suffix is incompatible with safe reuse. Report explicit configuration problems and inspect read-only; do not automatically change configuration, reinstall, change Team, delete helpers or modify user services/phone data. First-install approval neither authorizes re-signing nor bypasses configuration conflicts.',
          coldReadiness:
            locale === 'zh-CN'
              ? '普通手机任务默认允许建立必要控制连接；已有有效构建和手机 helper 时直接 check_device_ready({screenshot:false}) 并继续原任务，不询问每个冷 Session 的初始化授权。CoreDevice passcodeRequired:false/unlockedSinceBoot:true 不是当前解锁证明；已知锁定必须拦截，连接后由 live WDA 确认布尔锁状态。IOS_DEVICE_LOCK_STATE_UNKNOWN 只代表真实锁查询失败/无布尔；可用性未确认前无 source、截图或业务 UI，不自动解锁、不重放。IOS_WDA_INSTALLATION_AUTHORIZATION_REQUIRED 单独请求所选手机首次安装授权，未授权停在 POST 前；仅明确获准后内部传 allowWdaInstallation:true，不自动勾选、不让用户配置参数。IOS_WDA_SIGNING_REQUIRED 不得自动续签；首次安装、签名和重启仍独立授权，一次合并必要的具体影响说明。IOS_WDA_INSPECTION_FAILED 保留实际安装/签名检查失败，不把本机有效构建当手机已安装。IOS_CONNECTION_INITIALIZATION_DISABLED 仅为旧调用方 existingSession opt-out，不是新的授权门槛。IOS_WDA_SECURITY_REJECTED 可能涉及签名、权限或信任；已信任或无入口时只读核查签名/有效期，不循环重装。'
              : 'Ordinary phone tasks allow necessary control connection initialization by default. With a current valid build and existing phone helper, call check_device_ready({screenshot:false}) directly and continue the original task; do not ask for initialization authorization for every cold Session. CoreDevice passcodeRequired:false/unlockedSinceBoot:true is not current-unlock proof; known locks must block, then live WDA must confirm boolean lock state after connection. IOS_DEVICE_LOCK_STATE_UNKNOWN means an actual lock-query failure/missing boolean only; until usability is confirmed, no source, screenshot or business UI, no automatic unlock and no replay. IOS_WDA_INSTALLATION_AUTHORIZATION_REQUIRED separately requests first installation on the selected phone and stops before POST without approval; only after explicit approval internally pass allowWdaInstallation:true, never auto-select it or ask users to configure parameters. IOS_WDA_SIGNING_REQUIRED must not auto-renew; first installation, signing and restart still need separate grants, combining necessary concrete effects in one request. IOS_WDA_INSPECTION_FAILED preserves actual installation/signature inspection failure; a valid local build is not phone installation proof. IOS_CONNECTION_INITIALIZATION_DISABLED is a legacy existingSession caller opt-out, not a new authorization gate. IOS_WDA_SECURITY_REJECTED may involve signing, entitlements or trust; if trusted or absent, inspect signing/profile expiry read-only, not a reinstall loop.',
        }
      : {}),
    nextStep: action
      ? {
          id: action.id,
          ...(command ? { command } : {}),
          ...(mobile && action.id === 'start-appium' && options.prepareAvailable
            ? {
                tool: 'prepare_mobile',
                arguments: { action: 'start-appium', taskId: null, waitSeconds: 20 },
              }
            : {}),
          instruction:
            mobile && action.id === 'start-appium'
              ? serviceStartup.instruction
              : setupMessage(locale, action.labelKey),
        }
      : snapshot.canContinue
        ? {
            tool:
              snapshot.platform === 'android' || snapshot.platform === 'ios'
                ? 'check_device_ready'
                : 'exe_js',
            instruction:
              snapshot.platform === 'ios'
                ? locale === 'zh-CN'
                  ? '默认建立必要连接，确认 live WDA 当前解锁后才读取 UI；复用返回观察继续原任务。'
                  : 'Establish the necessary connection by default and confirm live WDA unlocked state before UI; reuse returned observations to continue the original task.'
                : 'Read the current UI before continuing.',
          }
        : {
            instruction:
              'Use the platform section of the setup Skill to diagnose the failed check; do not inspect project source or ask the user to locate tool paths.',
          },
    ...(snapshot.platform === 'android'
      ? {
          preparationGuidance:
            'Inherited SDK variables are candidates, not user requirements. Explain their warning and use verified tools. Do authorized preparation directly. Ask only for user-only actions or actual license acceptance. Do not modify global configuration, request repeated permission to look for tools, or read Maat source to recover.',
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
        item.action?.command && item.action.id !== 'start-appium'
          ? [`- ${item.action.command}`]
          : [],
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
