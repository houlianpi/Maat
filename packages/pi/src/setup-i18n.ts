import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SetupMessageKey } from '@houlianpi/maat-core';

export type SetupLocale = 'en' | 'zh-CN';

const messages: Record<SetupLocale, Record<SetupMessageKey, string>> = {
  en: {
    'setup.title.checking': 'Checking the macOS test environment',
    'setup.title.unknown': 'The macOS test environment has not been checked',
    'setup.title.ready': 'The macOS test environment is ready',
    'setup.title.partial': 'The macOS test environment is partially ready',
    'setup.title.blocked': 'Complete one setup step to test macOS',
    'setup.summary.checking': 'Checking UI interaction and Evidence capabilities.',
    'setup.summary.unknown': 'Maat checks macOS capabilities when macOS is selected.',
    'setup.summary.ready': 'UI interaction, assertions, and Evidence are available.',
    'setup.summary.partial':
      'Functional testing is available; optional enhancements are incomplete.',
    'setup.summary.blocked': 'The macOS test environment needs setup.',
    'capability.appium.ready': 'Appium is connected',
    'capability.appium.start': 'The macOS test service must be started',
    'capability.mac2.ready': 'The macOS automation component is installed',
    'capability.mac2.install': 'The macOS automation component must be installed',
    'capability.automation.ready': 'Automation Mode is ready',
    'capability.automation.auth': 'Automation may require system confirmation',
    'capability.automation.unavailable': 'Automation Mode is not enabled',
    'capability.accessibility.ready': 'UI reading is available',
    'capability.accessibility.required': 'Allow Maat to read and control apps',
    'capability.interaction.ready': 'App interaction and assertions are available',
    'capability.interaction.required': 'App interaction is not ready',
    'capability.screenshot.ready': 'Screenshot Evidence is available',
    'capability.screenshot.required': 'Screenshot Evidence is not enabled',
    'capability.screenshot.unknown': 'Screenshot capability has not been checked',
    'capability.interaction.unknown': 'App interaction has not been checked',
    'capability.screenshot.restart':
      'Restart the macOS test service to apply the updated permission',
    'capability.fullDisk.ready': 'Test attachment access is available',
    'capability.fullDisk.required': 'Video attachments require Full Disk Access',
    'capability.video.ready': 'Video recording is available',
    'capability.video.unavailable': 'Video recording is not installed',
    'action.startAppium': 'Show the start command',
    'action.installMac2': 'Show the install command',
    'action.automationMode': 'Show setup instructions',
    'action.openAccessibility': 'Open Accessibility settings',
    'action.openScreenRecording': 'Enable screenshot permission',
    'action.openFullDiskAccess': 'Open Full Disk Access settings',
    'action.installFfmpeg': 'Show the optional install command',
    'action.restartAppium': 'Restart the macOS test service',
    'action.recheck': 'Check again',
  },
  'zh-CN': {
    'setup.title.checking': '正在检查 macOS 测试环境',
    'setup.title.unknown': '尚未检查 macOS 测试环境',
    'setup.title.ready': 'macOS 测试环境已就绪',
    'setup.title.partial': 'macOS 测试环境部分可用',
    'setup.title.blocked': '完成一个设置后即可测试 macOS',
    'setup.summary.checking': '正在确认应用操作与 Evidence 能力。',
    'setup.summary.unknown': '选择 macOS 后，Maat 会自动检查测试能力。',
    'setup.summary.ready': '应用操作、业务断言和 Evidence 均可使用。',
    'setup.summary.partial': '功能测试可用，仍有可选增强项未配置。',
    'setup.summary.blocked': '需要完成 macOS 测试环境设置。',
    'capability.appium.ready': 'Appium 已连接',
    'capability.appium.start': '需要启动 macOS 测试服务',
    'capability.mac2.ready': 'macOS 自动化组件已安装',
    'capability.mac2.install': '需要安装 macOS 自动化组件',
    'capability.automation.ready': 'Automation Mode 已就绪',
    'capability.automation.auth': '自动化操作可能要求系统确认',
    'capability.automation.unavailable': 'Automation Mode 尚未开启',
    'capability.accessibility.ready': '可以读取界面',
    'capability.accessibility.required': '需要允许 Maat 操作和读取应用',
    'capability.interaction.ready': '可以操作应用并运行断言',
    'capability.interaction.required': '应用操作尚未就绪',
    'capability.screenshot.ready': '可以保存截图 Evidence',
    'capability.screenshot.required': '截图 Evidence 尚未开启',
    'capability.screenshot.unknown': '截图能力尚未检测',
    'capability.interaction.unknown': '应用操作能力尚未检测',
    'capability.screenshot.restart': '需要重启 macOS 测试服务以应用新权限',
    'capability.fullDisk.ready': '测试附件访问正常',
    'capability.fullDisk.required': '视频附件需要完全磁盘访问权限',
    'capability.video.ready': '可以录制测试视频',
    'capability.video.unavailable': '视频录制组件未安装',
    'action.startAppium': '查看启动命令',
    'action.installMac2': '查看安装命令',
    'action.automationMode': '查看设置方法',
    'action.openAccessibility': '打开辅助功能设置',
    'action.openScreenRecording': '开启截图权限',
    'action.openFullDiskAccess': '打开完全磁盘访问设置',
    'action.installFfmpeg': '查看可选安装命令',
    'action.restartAppium': '重启 macOS 测试服务',
    'action.recheck': '重新检测',
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
