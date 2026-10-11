import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
} from '@earendil-works/pi-coding-agent';

import type { PlatformStatus } from '@houlianpi/maat-core';

export function maatStatusLines(platform: PlatformStatus): string[] {
  const platformLine = [`Platform ${platform.label}`, platform.detail, platform.session]
    .filter(Boolean)
    .join(' · ');
  return [platformLine, 'UI execution · observations are not business validation'];
}

export function createMaatExtension(platformStatus: () => PlatformStatus): InlineExtension {
  const factory = (pi: ExtensionAPI) => {
    const applyUi = (ctx: ExtensionContext) => {
      if (ctx.mode !== 'tui') return;
      ctx.ui.setTitle('Maat');
      setTimeout(() => ctx.ui.setTitle('Maat'), 0);
      ctx.ui.setHeader((_tui, theme) => ({
        render(_width: number) {
          const title = theme.bold(theme.fg('accent', 'Maat'));
          const subtitle = theme.fg(
            'muted',
            'UI execution for Coding Agents · observe → act → inspect',
          );
          return ['', `  ${title}`, `  ${subtitle}`];
        },
        invalidate() {},
      }));
      ctx.ui.setWidget('maat-status', maatStatusLines(platformStatus()), {
        placement: 'aboveEditor',
      });
    };

    pi.on('session_start', async (_event, ctx) => applyUi(ctx));
    pi.on('tool_execution_end', async (_event, ctx) => applyUi(ctx));
  };

  return {
    name: 'maat-ui',
    hidden: true,
    factory,
  };
}
