import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
} from '@earendil-works/pi-coding-agent';

import type { CaseDraftManager, PlatformStatus } from '@houlianpi/maat-core';

export function maatStatusLines(platform: PlatformStatus, caseManager: CaseDraftManager): string[] {
  const draft = caseManager.current;
  const platformLine = [`Platform ${platform.label}`, platform.detail, platform.session]
    .filter(Boolean)
    .join(' · ');
  const caseLine = draft
    ? `Case     ${draft.id} · ${draft.steps.length} steps · ${draft.failures.length} failed attempts`
    : 'Case     no active Case';
  const evidenceLine = draft
    ? `Evidence ${draft.evidence.length} items · ${draft.objectives.length} objectives`
    : 'Evidence 0 items';
  return [platformLine, caseLine, evidenceLine];
}

export function createMaatExtension(
  caseManager: CaseDraftManager,
  platformStatus: () => PlatformStatus,
): InlineExtension {
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
            'Conversational UI verification · intent → evidence → executable truth',
          );
          return ['', `  ${title}`, `  ${subtitle}`];
        },
        invalidate() {},
      }));
      ctx.ui.setWidget('maat-status', maatStatusLines(platformStatus(), caseManager), {
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
