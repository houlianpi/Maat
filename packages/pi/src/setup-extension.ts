import { execFile } from 'node:child_process';
import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
} from '@earendil-works/pi-coding-agent';
import type { MaatApi } from '@houlianpi/maat-core';
import { maatStatusLines } from './status.ts';
import { setupDoctor, setupPanel } from './setup-ui.ts';

export function registerMaatSetupCommands(pi: ExtensionAPI, maat: MaatApi): void {
  pi.registerCommand('maat-status', {
    description: 'Show Maat capabilities and the recommended next action',
    handler: async (_args, ctx) => {
      const status = maat.platforms.status();
      const lines = maatStatusLines(status, maat.drafts);
      if (status.id === 'macos') {
        const snapshot = await maat.setup.check({ platform: 'macos' });
        lines.push('', ...setupPanel(snapshot));
      }
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });

  pi.registerCommand('maat-setup', {
    description: 'Guide macOS setup with one recommended next action',
    handler: async (_args, ctx) => {
      const snapshot = await maat.setup.check({ platform: maat.platforms.current().id });
      const resumed = maat.setup.resume();
      ctx.ui.notify(
        `${setupPanel(snapshot).join('\n')}${resumed ? `\n\n已恢复 Case ${resumed.caseId ?? ''}，请从中断位置继续。` : ''}`,
        snapshot.canContinue ? 'info' : 'warning',
      );
      const action = snapshot.recommendedAction;
      if (!action || ctx.mode !== 'tui' || !action.settingsUrl) return;
      if (
        await ctx.ui.confirm(
          action.label,
          `${snapshot.summary}\n\n打开 macOS 系统设置？Maat 不会自动修改权限。`,
        )
      ) {
        maat.setup.interrupt({
          platform: maat.platforms.current().id,
          caseId: maat.cases.current()?.id,
          pendingAction: action.id,
          workMode: 'case',
        });
        const selected = await maat.setup.action(action.id);
        execFile('open', [selected.settingsUrl!], () => undefined);
        ctx.ui.notify(
          `${
            selected.id === 'open-screen-recording'
              ? '请允许 Xcode、启动 Appium 的终端，以及列表中的 macOS 自动化组件。\n'
              : ''
          }完成后回到这里再次运行 /maat-setup。Maat 会保留当前 Case。`,
          'info',
        );
      }
    },
  });

  pi.registerCommand('maat-doctor', {
    description: 'Show redacted technical Maat setup diagnostics',
    handler: async (_args, ctx) => {
      const snapshot = await maat.setup.check({ platform: maat.platforms.current().id });
      ctx.ui.notify(setupDoctor(snapshot), snapshot.canContinue ? 'info' : 'warning');
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
    ctx.ui.setWidget('maat-setup', setupPanel(snapshot), { placement: 'aboveEditor' });
}
