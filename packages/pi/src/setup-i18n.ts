import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SetupMessageKey } from '@houlianpi/maat-core';

export type SetupLocale = 'en' | 'zh-CN';

/** Known readiness errors only; never infer current lock state from preparation facts. */
export function phoneReadinessGuidance(message: string, locale: SetupLocale): string | undefined {
  const zh = locale === 'zh-CN';
  if (/\bIOS_WDA_SECURITY_REJECTED\b/.test(message))
    return zh
      ? 'IOS_WDA_SECURITY_REJECTED：iOS 拒绝 WDA，可能涉及签名、权限或开发者描述文件信任。请本人检查“设置 > 通用 > VPN与设备管理”的开发者 App 信任状态；若已信任或没有入口，核查 WDA 签名及描述文件有效期。不要循环重试或重装；更改签名、重新部署须另获明确授权，不索取 Apple 凭据。'
      : 'IOS_WDA_SECURITY_REJECTED: iOS rejected WDA; signing, entitlements or developer-profile trust may be involved. Check developer App trust in Settings > General > VPN & Device Management yourself; if already trusted or no entry exists, inspect WDA signing and profile expiry. Do not loop retries or reinstall. Signing changes and redeployment require separate explicit authorization; never request Apple credentials.';
  if (/\bIOS_DEVICE_LOCK_STATE_UNKNOWN\b/.test(message))
    return zh
      ? 'IOS_DEVICE_LOCK_STATE_UNKNOWN：无法证明当前 iPhone 已点亮并解锁，默认阻止冷 Session 初始化。请本人确认手机状态；说明 WDA 初始化可能点亮屏幕或触发系统提示后，仅在明确授权本次初始化时使用 allowWdaInitialization=true。授权不是当前解锁证明，不重放之前的动作。'
      : 'IOS_DEVICE_LOCK_STATE_UNKNOWN: the current awake/unlocked iPhone state is unproven; cold Session initialization is blocked by default. Confirm the phone state yourself. Only after explaining possible screen wake/system prompts and obtaining explicit authorization for this attempt may allowWdaInitialization=true be used. Authorization is not current-unlock proof; do not replay previous actions.';
  const code = /\b(?:ANDROID|IOS)_DEVICE_LOCKED\b/.exec(message)?.[0];
  if (code)
    return zh
      ? `${code}：手机已锁定或熄屏。请本人点亮并解锁手机，完成后重新检查；不要重启服务或重复之前的操作。`
      : `${code}: the phone is locked or its screen is off. Wake and unlock it yourself, then recheck; do not restart the service or repeat previous actions.`;
}

const messages: Record<SetupLocale, Record<SetupMessageKey, string>> = {
  en: {
    'setup.title.checking': 'Checking the macOS execution environment',
    'setup.title.unknown': 'The macOS execution environment has not been checked',
    'setup.title.ready': 'The macOS execution environment is ready',
    'setup.title.partial': 'The macOS execution environment is partially ready',
    'setup.title.blocked': 'Complete the recommended setup step',
    'setup.summary.checking': 'Checking UI interaction and observation capabilities.',
    'setup.summary.unknown': 'Maat checks macOS capabilities when macOS is selected.',
    'setup.summary.ready': 'UI interaction and observation are available.',
    'setup.summary.partial': 'UI execution is available; optional capabilities are incomplete.',
    'setup.summary.blocked': 'The macOS execution environment needs setup.',
    'capability.appium.ready': 'Appium is connected',
    'capability.appium.start': 'The connection service is stopped or unreachable',
    'capability.appiumCli.ready': 'The connection service software is installed',
    'capability.appiumCli.install': 'The connection service software needs installation',
    'capability.appiumCli.unknown': 'The connection service installation could not be checked',
    'capability.adbServer.ready': 'The local Android connection daemon is running',
    'capability.adbServer.start': 'The local Android connection daemon needs to be started',
    'capability.adbServer.unknown': 'The local Android connection daemon could not be checked',
    'capability.adb.ready': 'ADB is available',
    'capability.adb.install': 'Android connection tools are missing',
    'capability.adb.unknown': 'Android connection tools could not be checked',
    'capability.androidSdk.ready': 'Required Android tools are available',
    'capability.androidSdk.required':
      'Required Android tools or their configuration are incomplete',
    'capability.androidSdk.unknown': 'Android tools could not be checked',
    'capability.uiautomator2.ready': 'The Android automation driver is installed',
    'capability.uiautomator2.install': 'The Android automation driver is missing',
    'capability.uiautomator2.unknown': 'The Android automation driver could not be checked',
    'capability.androidDevice.ready': 'The selected phone is connected and authorized',
    'capability.androidDevice.missing': 'No matching Android phone is connected',
    'capability.androidDevice.unauthorized': 'Accept the USB debugging prompt on the phone',
    'capability.androidDevice.offline': 'The Android phone is offline',
    'capability.androidDevice.select': 'Choose which Android phone to use',
    'capability.androidDevice.unknown': 'Android device state could not be checked',
    'capability.xcode.ready': 'Xcode is available',
    'capability.xcode.required':
      'Local iPhone preparation requires a working full Xcode installation',
    'capability.xcode.unknown': 'Xcode could not be checked',
    'capability.xcuitest.ready': 'The iOS automation driver is installed',
    'capability.xcuitest.install': 'The iOS automation driver is missing',
    'capability.xcuitest.unknown': 'The iOS automation driver could not be checked',
    'capability.iosDevice.ready': 'The selected iPhone is connected and paired',
    'capability.iosDevice.missing': 'No matching physical iPhone is connected',
    'capability.iosDevice.offline': 'The selected iPhone is offline',
    'capability.iosDevice.trust': 'Trust this computer on the iPhone',
    'capability.iosDevice.select': 'Choose which physical iPhone to use',
    'capability.iosDevice.unknown': 'iPhone connection state could not be checked',
    'capability.iosDeveloperMode.ready': 'iPhone Developer Mode is enabled',
    'capability.iosDeveloperMode.required': 'Enable Developer Mode on the iPhone',
    'capability.iosDeveloperMode.unknown': 'iPhone Developer Mode could not be checked',
    'capability.mac2.ready': 'The macOS automation component is installed',
    'capability.mac2.install': 'The macOS automation component must be installed',
    'capability.automation.ready': 'Automation Mode is ready',
    'capability.automation.auth': 'Automation may require system confirmation',
    'capability.automation.unavailable': 'Automation Mode is not enabled',
    'capability.accessibility.ready': 'UI reading is available',
    'capability.accessibility.required': 'Allow Maat to read and control apps',
    'capability.interaction.ready': 'App interaction is available',
    'capability.interaction.required': 'App interaction is not ready',
    'capability.screenshot.ready': 'Screenshot observation is available',
    'capability.screenshot.required': 'Screenshot observation is not enabled',
    'capability.screenshot.unknown': 'Screenshot capability has not been checked',
    'capability.interaction.unknown': 'App interaction has not been checked',
    'capability.screenshot.restart':
      'Restart the macOS connection service to apply the updated permission',
    'capability.fullDisk.ready': 'Attachment access is available',
    'capability.fullDisk.required': 'Video attachments require Full Disk Access',
    'capability.video.ready': 'Video recording is available',
    'capability.video.unavailable': 'Video recording is not installed',
    'action.startAppium': 'Start the local connection service',
    'action.installAppium': 'Install the local connection service',
    'action.startAdb': 'Start the local Android connection daemon',
    'action.installMac2': 'Show the install command',
    'action.automationMode': 'Show setup instructions',
    'action.openAccessibility': 'Open Accessibility settings',
    'action.openScreenRecording': 'Enable screenshot permission',
    'action.openFullDiskAccess': 'Open Full Disk Access settings',
    'action.installFfmpeg': 'Show the optional install command',
    'action.restartAppium': 'Restart the macOS connection service',
    'action.recheck': 'Check again',
    'action.installAdb': 'Prepare the Android connection tools',
    'action.configureAndroidSdk': 'Prepare the required Android connection tools',
    'action.installUiAutomator2': 'Prepare the Android automation driver',
    'action.connectAndroidDevice': 'Connect the intended phone and check again',
    'action.authorizeAndroidDevice': 'Allow USB debugging on the phone, then continue',
    'action.selectAndroidDevice': 'Select the phone for this task',
    'action.configureXcode': 'Check Xcode installation, selection and first-launch requirements',
    'action.installXcuitest': 'Prepare the iOS automation driver',
    'action.connectIosDevice': 'Connect and unlock the intended iPhone, then recheck',
    'action.trustIosDevice': 'Trust this computer on the iPhone, then continue',
    'action.selectIosDevice': 'Select the iPhone for this task',
    'action.enableIosDeveloperMode':
      'Enable Developer Mode yourself and confirm any required restart',
  },
  'zh-CN': {
    'setup.title.checking': '正在检查 macOS 操作环境',
    'setup.title.unknown': '尚未检查 macOS 操作环境',
    'setup.title.ready': 'macOS 操作环境已就绪',
    'setup.title.partial': 'macOS 操作环境部分可用',
    'setup.title.blocked': '请完成推荐的准备步骤',
    'setup.summary.checking': '正在确认应用操作与观察能力。',
    'setup.summary.unknown': '选择 macOS 后，Maat 会自动检查操作能力。',
    'setup.summary.ready': '应用操作和界面观察均可使用。',
    'setup.summary.partial': '应用操作可用，仍有可选能力未配置。',
    'setup.summary.blocked': '需要完成 macOS 操作环境设置。',
    'capability.appium.ready': 'Appium 已连接',
    'capability.appium.start': '连接服务尚未启动或无法访问',
    'capability.appiumCli.ready': '连接服务软件已安装',
    'capability.appiumCli.install': '需要安装连接服务软件',
    'capability.appiumCli.unknown': '未能检查连接服务软件',
    'capability.adbServer.ready': '本地 Android 连接服务正在运行',
    'capability.adbServer.start': '需要启动本地 Android 连接服务',
    'capability.adbServer.unknown': '未能检查本地 Android 连接服务',
    'capability.adb.ready': 'Android 连接工具可用',
    'capability.adb.install': '还缺少 Android 连接工具',
    'capability.adb.unknown': '未能检查 Android 连接工具',
    'capability.androidSdk.ready': '所需 Android 工具已准备好',
    'capability.androidSdk.required': '所需 Android 工具或路径配置还不完整',
    'capability.androidSdk.unknown': '未能检查 Android 工具',
    'capability.uiautomator2.ready': 'Android 自动化驱动已安装',
    'capability.uiautomator2.install': '还缺少 Android 自动化驱动',
    'capability.uiautomator2.unknown': '未能检查 Android 自动化驱动',
    'capability.androidDevice.ready': '目标手机已连接并授权',
    'capability.androidDevice.missing': '尚未发现匹配的 Android 手机',
    'capability.androidDevice.unauthorized': '请在手机上允许 USB 调试',
    'capability.androidDevice.offline': 'Android 手机连接已断开',
    'capability.androidDevice.select': '请选择本次使用的 Android 手机',
    'capability.androidDevice.unknown': '未能检查 Android 手机状态',
    'capability.xcode.ready': 'Xcode 可用',
    'capability.xcode.required': '本地 iPhone 准备需要完整且可用的 Xcode',
    'capability.xcode.unknown': '未能检查 Xcode',
    'capability.xcuitest.ready': 'iOS 自动化驱动已安装',
    'capability.xcuitest.install': '还缺少 iOS 自动化驱动',
    'capability.xcuitest.unknown': '未能检查 iOS 自动化驱动',
    'capability.iosDevice.ready': '目标 iPhone 已连接并配对',
    'capability.iosDevice.missing': '尚未发现匹配的 iPhone 真机',
    'capability.iosDevice.offline': '目标 iPhone 连接已断开',
    'capability.iosDevice.trust': '请在 iPhone 上信任此电脑',
    'capability.iosDevice.select': '请选择本次使用的 iPhone 真机',
    'capability.iosDevice.unknown': '未能检查 iPhone 连接状态',
    'capability.iosDeveloperMode.ready': 'iPhone 开发者模式已开启',
    'capability.iosDeveloperMode.required': '请在 iPhone 上开启开发者模式',
    'capability.iosDeveloperMode.unknown': '未能检查 iPhone 开发者模式',
    'capability.mac2.ready': 'macOS 自动化组件已安装',
    'capability.mac2.install': '需要安装 macOS 自动化组件',
    'capability.automation.ready': 'Automation Mode 已就绪',
    'capability.automation.auth': '自动化操作可能要求系统确认',
    'capability.automation.unavailable': 'Automation Mode 尚未开启',
    'capability.accessibility.ready': '可以读取界面',
    'capability.accessibility.required': '需要允许 Maat 操作和读取应用',
    'capability.interaction.ready': '可以操作应用',
    'capability.interaction.required': '应用操作尚未就绪',
    'capability.screenshot.ready': '可以读取截图',
    'capability.screenshot.required': '截图能力尚未开启',
    'capability.screenshot.unknown': '截图能力尚未检测',
    'capability.interaction.unknown': '应用操作能力尚未检测',
    'capability.screenshot.restart': '需要重启 macOS 连接服务以应用新权限',
    'capability.fullDisk.ready': '附件访问正常',
    'capability.fullDisk.required': '视频附件需要完全磁盘访问权限',
    'capability.video.ready': '可以录制视频',
    'capability.video.unavailable': '视频录制组件未安装',
    'action.startAppium': '启动本地连接服务',
    'action.installAppium': '安装本地连接服务',
    'action.startAdb': '启动本地 Android 连接服务',
    'action.installMac2': '查看安装命令',
    'action.automationMode': '查看设置方法',
    'action.openAccessibility': '打开辅助功能设置',
    'action.openScreenRecording': '开启截图权限',
    'action.openFullDiskAccess': '打开完全磁盘访问设置',
    'action.installFfmpeg': '查看可选安装命令',
    'action.restartAppium': '重启 macOS 连接服务',
    'action.recheck': '重新检测',
    'action.installAdb': '准备 Android 连接工具',
    'action.configureAndroidSdk': '准备所需的 Android 连接工具',
    'action.installUiAutomator2': '准备 Android 自动化驱动',
    'action.connectAndroidDevice': '连接目标手机后重新检查',
    'action.authorizeAndroidDevice': '在手机上允许 USB 调试，完成后继续',
    'action.selectAndroidDevice': '选择本次操作的手机',
    'action.configureXcode': '检查 Xcode 安装、当前选择与首次启动条件',
    'action.installXcuitest': '准备 iOS 自动化驱动',
    'action.connectIosDevice': '连接并解锁目标 iPhone 后重新检查',
    'action.trustIosDevice': '在 iPhone 上信任此电脑，完成后继续',
    'action.selectIosDevice': '选择本次操作的 iPhone',
    'action.enableIosDeveloperMode': '请本人开启开发者模式，并确认可能需要的重启',
  },
};

export function setupMessage(locale: SetupLocale, key: SetupMessageKey): string {
  return messages[locale][key];
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item): item is { type: 'text'; text: string } =>
      Boolean(item && typeof item === 'object' && (item as { type?: string }).type === 'text'),
    )
    .map((item) => item.text)
    .join(' ');
}

export function resolveSetupLocale(
  explicit?: string,
  context?: Pick<ExtensionContext, 'sessionManager'>,
): SetupLocale {
  const requested = explicit?.trim().toLowerCase();
  if (requested && /^(zh|zh-cn|中文)$/.test(requested)) return 'zh-CN';
  if (requested && /^(en|en-us|english)$/.test(requested)) return 'en';
  const recentUserText = context?.sessionManager
    ?.getEntries()
    .toReversed()
    .find(
      (entry) =>
        entry.type === 'message' &&
        'role' in entry.message &&
        entry.message.role === 'user' &&
        'content' in entry.message,
    );
  if (recentUserText?.type === 'message' && 'content' in recentUserText.message) {
    const text = messageText(recentUserText.message.content);
    if (/\p{Script=Han}/u.test(text)) return 'zh-CN';
    if (/[A-Za-z]/.test(text)) return 'en';
  }
  const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  return systemLocale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}
