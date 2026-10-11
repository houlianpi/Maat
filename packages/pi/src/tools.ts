import type { MaatApi } from '@houlianpi/maat-core';
import { createExecJsTool } from './tools/exec-js-tool.ts';
import { createPlatformTools } from './tools/platform-tools.ts';
import { createSetupTools } from './tools/setup-tools.ts';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { setupAgentContext, setupPanel } from './setup-ui.ts';
import { resolveSetupLocale } from './setup-i18n.ts';

/** Pi-specific projection of the host-neutral Maat API. */
export function createMaatPiTools(maat: MaatApi): ToolDefinition<any, any, any>[] {
  return [
    createExecJsTool(
      {
        close: () => maat.platforms.current().close(),
        execute: (code, signal) => maat.exploration.executeJavaScript(code, signal),
      },
      {
        description:
          'Execute JavaScript against the active Platform Adapter. Call list_platforms after switching to see the available runtime globals.',
        guidelines: ['Use only globals exposed by the active adapter codeContext.'],
      },
      async (error, ctx, signal) => {
        const platform = maat.platforms.current().id;
        if (platform !== 'macos' && platform !== 'android') return;
        const message = String(error);
        const isScreenshot = message.includes('MACOS_SCREEN_CAPTURE_PERMISSION_REQUIRED');
        const isSetupFailure =
          isScreenshot ||
          /ECONNREFUSED|connection refused|No Appium server responded|Appium.*(?:unavailable|not reachable)|Mac2.*(?:missing|not installed)|Could not find.*driver/i.test(
            message,
          );
        if (!isSetupFailure) return;
        if (platform === 'android') {
          const snapshot = await maat.setup.check({ platform, signal });
          const locale = resolveSetupLocale(undefined, ctx);
          return [
            locale === 'zh-CN'
              ? 'Android 连接准备尚未完成。按 maat-setup Skill 使用已授权的宿主工具处理，不要重放之前的手机动作。'
              : 'Android preparation is incomplete. Follow the maat-setup Skill using authorized host tools; do not replay previous phone actions.',
            ...setupPanel(snapshot, locale),
            setupAgentContext(snapshot, locale),
            `Execution error: ${message}`,
          ].join('\n');
        }
        maat.setup.interrupt({
          platform: 'macos',
          pendingAction: isScreenshot ? 'screenshot' : 'session',
        });
        const snapshot = await maat.setup.check({ platform: 'macos', signal });
        const locale = resolveSetupLocale(undefined, ctx);
        const explanation =
          locale === 'zh-CN'
            ? isScreenshot
              ? '当前截图能力不可用，请按提示完成权限设置。'
              : 'macOS 操作环境需要完成一个设置。'
            : isScreenshot
              ? 'Screenshot observation is unavailable; complete the requested permission step.'
              : 'The macOS execution environment needs one setup step.';
        return `${explanation}\n${setupPanel(snapshot, locale).join('\n')}`;
      },
    ),
    ...createPlatformTools(maat),
    ...createSetupTools(maat),
  ];
}
