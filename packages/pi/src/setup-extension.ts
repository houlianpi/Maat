import { execFile } from 'node:child_process';
import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
} from '@earendil-works/pi-coding-agent';
import type { MaatApi, SetupSnapshot } from '@houlianpi/maat-core';
import { setupAgentContext, setupPanel } from './setup-ui.ts';
import { resolveSetupLocale, setupMessage } from './setup-i18n.ts';
import { MAAT_SETUP_SKILL_PATH } from './system-prompt.ts';
import { preparationSummary } from './mobile-summary.ts';

function setupTarget(args: string, maat: MaatApi) {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const requested = tokens.find((token) =>
    maat.platforms.list().some((adapter) => adapter.id === token),
  );
  const language = tokens.filter((token) => token !== requested).join(' ');
  if (language && !/^(zh|zh-cn|中文|en|en-us|english)$/i.test(language))
    throw new Error('Use /maat-setup [android|macos] [zh-CN|en].');
  const current = maat.platforms.current().id;
  return { platform: requested ?? (current === 'web' ? 'android' : current), language };
}

export function registerMaatSetupCommands(
  pi: ExtensionAPI,
  maat: MaatApi,
  onPrepared?: (snapshot: SetupSnapshot, ctx: ExtensionContext) => void,
): void {
  pi.registerCommand('maat-setup', {
    description: 'Prepare Android through the host Agent, or guide macOS setup',
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      ctx.signal?.throwIfAborted();
      const { platform, language } = setupTarget(args, maat);
      const locale = resolveSetupLocale(language, ctx);
      if (platform !== 'android' && platform !== 'macos') {
        ctx.ui.notify(
          locale === 'zh-CN'
            ? `当前 ${platform} 平台没有准备向导。Android 手机请使用 /maat-setup android；不会替你切换已有设备。`
            : `No preparation workflow is available for ${platform}. Use /maat-setup android for a local Android phone; the current device was not changed.`,
          'warning',
        );
        return;
      }
      if (platform === 'android') {
        if (maat.platforms.current().id !== 'android') await maat.platforms.select('android');
        const snapshot = await maat.setup.check({ platform: 'android', signal: ctx.signal });
        onPrepared?.(snapshot, ctx);
        pi.sendMessage(
          {
            customType: 'maat-android-setup',
            content: [
              locale === 'zh-CN'
                ? `用户请求准备当前 Android 手机。请用宿主文件工具读取 Maat 内部准备工作流 ${MAAT_SETUP_SKILL_PATH}，在授权范围内使用宿主工具处理必要准备；需要本人操作时明确等待，完成后调用 check_device_ready 并继续原任务。`
                : `The user requested preparation of the current Android phone. Read Maat's internal setup workflow at ${MAAT_SETUP_SKILL_PATH} with the host file tool, use authorized host tools for necessary preparation, wait for user-only actions, then call check_device_ready and continue the original task.`,
              ...setupPanel(snapshot, locale),
              setupAgentContext(snapshot, locale),
            ].join('\n'),
            display: true,
            details: { summary: preparationSummary(snapshot, locale) },
          },
          { triggerTurn: true },
        );
        return;
      }
      const copy =
        locale === 'zh-CN'
          ? {
              resumed: '准备状态已重新检查，请读取当前界面后继续原任务。',
              open: '打开 macOS 系统设置？Maat 不会自动修改权限。',
              screen: '请允许 Xcode、启动 Appium 的终端，以及列表中的 macOS 自动化组件。\n',
              done: '完成后回到这里再次运行 /maat-setup，重新检查准备状态。',
            }
          : {
              resumed: 'Preparation was rechecked. Read the current UI before continuing.',
              open: 'Open macOS System Settings? Maat will not change permissions automatically.',
              screen:
                'Allow Xcode, the terminal that starts Appium, and the listed macOS automation component.\n',
              done: 'When finished, return here and run /maat-setup again to recheck preparation.',
            };
      if (maat.platforms.current().id !== 'macos') await maat.platforms.select('macos');
      const snapshot = await maat.setup.check({ platform, signal: ctx.signal });
      onPrepared?.(snapshot, ctx);
      const resumed = maat.setup.resume();
      ctx.ui.notify(
        `${setupPanel(snapshot, locale).join('\n')}${resumed ? `\n\n${copy.resumed}` : ''}`,
        snapshot.canContinue ? 'info' : 'warning',
      );
      const action = snapshot.recommendedAction;
      if (!action || ctx.mode !== 'tui' || !action.settingsUrl) return;
      if (
        await ctx.ui.confirm(
          setupMessage(locale, action.labelKey),
          `${setupMessage(locale, snapshot.summaryKey)}\n\n${copy.open}`,
        )
      ) {
        maat.setup.interrupt({ platform: 'macos', pendingAction: action.id });
        const selected = await maat.setup.action(action.id);
        await new Promise<void>((resolve, reject) => {
          execFile('open', [selected.settingsUrl!], (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        ctx.ui.notify(
          `${selected.id === 'open-screen-recording' ? copy.screen : ''}${copy.done}`,
          'info',
        );
      }
    },
  });
}

export function createMaatSetupExtension(maat: MaatApi): InlineExtension {
  return {
    name: 'maat-setup-assistant',
    hidden: true,
    factory: (pi) => registerMaatSetupCommands(pi, maat),
  };
}

export function notifySetupPanel(ctx: ExtensionContext, maat: MaatApi): void {
  const snapshot = maat.setup.current();
  if (ctx.mode === 'tui' && snapshot.state !== 'unknown')
    ctx.ui.setWidget('maat-setup', setupPanel(snapshot, resolveSetupLocale(undefined, ctx)), {
      placement: 'aboveEditor',
    });
}
