import { execFile } from 'node:child_process';
import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
} from '@earendil-works/pi-coding-agent';
import type { MaatApi } from '@houlianpi/maat-core';
import { maatStatusLines } from './status.ts';
import { setupDoctor, setupPanel } from './setup-ui.ts';
import { resolveSetupLocale, setupMessage } from './setup-i18n.ts';

export function registerMaatSetupCommands(pi: ExtensionAPI, maat: MaatApi): void {
  pi.registerCommand('maat-status', {
    description: 'Show Maat capabilities and the recommended next action',
    handler: async (args, ctx) => {
      const locale = resolveSetupLocale(args, ctx);
      const status = maat.platforms.status();
      const lines = maatStatusLines(status, maat.drafts);
      if (status.id === 'macos') {
        const snapshot = await maat.setup.check({ platform: 'macos' });
        lines.push('', ...setupPanel(snapshot, locale));
      }
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });

  pi.registerCommand('maat-setup', {
    description: 'Guide macOS setup with one recommended next action',
    handler: async (args, ctx) => {
      const locale = resolveSetupLocale(args, ctx);
      const copy =
        locale === 'zh-CN'
          ? {
              resumed: (id: string) => `已恢复 Case ${id}，请从中断位置继续。`,
              open: '打开 macOS 系统设置？Maat 不会自动修改权限。',
              screen: '请允许 Xcode、启动 Appium 的终端，以及列表中的 macOS 自动化组件。\n',
              done: '完成后回到这里再次运行 /maat-setup。Maat 会保留当前 Case。',
            }
          : {
              resumed: (id: string) => `Resumed Case ${id}. Continue from the interruption.`,
              open: 'Open macOS System Settings? Maat will not change permissions automatically.',
              screen:
                'Allow Xcode, the terminal that starts Appium, and the listed macOS automation component.\n',
              done: 'When finished, return here and run /maat-setup again. Maat will preserve the current Case.',
            };
      const snapshot = await maat.setup.check({ platform: 'macos', signal: ctx.signal });
      const resumed = maat.setup.resume();
      ctx.ui.notify(
        `${setupPanel(snapshot, locale).join('\n')}${resumed?.caseId ? `\n\n${copy.resumed(resumed.caseId)}` : ''}`,
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
        const activeCase = maat.cases.current();
        if (activeCase)
          maat.setup.interrupt({
            platform: 'macos',
            caseId: activeCase.id,
            pendingAction: action.id,
            workMode: 'case',
          });
        const selected = await maat.setup.action(action.id);
        execFile('open', [selected.settingsUrl!], () => undefined);
        ctx.ui.notify(
          `${selected.id === 'open-screen-recording' ? copy.screen : ''}${copy.done}`,
          'info',
        );
      }
    },
  });

  pi.registerCommand('maat-doctor', {
    description: 'Show redacted technical Maat setup diagnostics',
    handler: async (args, ctx) => {
      const locale = resolveSetupLocale(args, ctx);
      const snapshot = await maat.setup.check({ platform: 'macos', signal: ctx.signal });
      ctx.ui.notify(setupDoctor(snapshot, locale), snapshot.canContinue ? 'info' : 'warning');
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
