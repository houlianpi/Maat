import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SetupMessageKey } from '@houlianpi/maat-core';

export type SetupLocale = 'en' | 'zh-CN';

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
