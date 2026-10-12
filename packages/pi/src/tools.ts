import type { MaatApi } from '@houlianpi/maat-core';
import { createExecJsTool } from './tools/exec-js-tool.ts';
import { createPlatformTools } from './tools/platform-tools.ts';
import { createSetupTools } from './tools/setup-tools.ts';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { setupAgentContext, setupPanel } from './setup-ui.ts';
import { phoneReadinessGuidance, resolveSetupLocale } from './setup-i18n.ts';
import { MobilePreparation } from './mobile-preparation.ts';
import { createMobilePreparationTool } from './tools/mobile-preparation-tool.ts';

/** Pi-specific projection of the host-neutral Maat API. */
export function createMaatPiTools(
  maat: MaatApi,
  preparation?: MobilePreparation,
): ToolDefinition<any, any, any>[] {
  return [
    createExecJsTool(
      {
        close: async () => {
          await maat.mobile.releaseCurrentSession();
        },
        execute: (code, signal) => maat.exploration.executeJavaScript(code, signal),
      },
      {
        description:
          'Execute JavaScript against the active Platform Adapter. Call list_platforms after switching to see the available runtime globals.',
        guidelines: ['Use only globals exposed by the active adapter codeContext.'],
      },
      async (error, ctx, signal) => {
        const platform = maat.platforms.current().id;
        if (platform !== 'macos' && platform !== 'android' && platform !== 'ios') return;
        const message = error instanceof Error ? error.message : String(error);
        const locale = resolveSetupLocale(undefined, ctx);
        if (platform === 'ios' || platform === 'android') {
          const guidance = phoneReadinessGuidance(message, locale);
          if (guidance) return guidance;
        }
        const isScreenshot = message.includes('MACOS_SCREEN_CAPTURE_PERMISSION_REQUIRED');
        const isSetupFailure =
          isScreenshot ||
          /ECONNREFUSED|connection refused|No Appium server responded|Appium.*(?:unavailable|not reachable)|Mac2.*(?:missing|not installed)|Could not find.*driver|XCUITEST_DRIVER_MISSING|XCODE_REQUIRED|IOS_DEVICE_(?:MISSING|OFFLINE|UNPAIRED|SELECTION_REQUIRED)|IOS_SETUP_/i.test(
            message,
          );
        if (!isSetupFailure) return;
        if (platform === 'android' || platform === 'ios') {
          const snapshot = await maat.setup.check({ platform, signal });
          const label = platform === 'ios' ? 'iOS' : 'Android';
          return [
            locale === 'zh-CN'
              ? `${label} 连接准备尚未完成。按 maat-setup Skill 的 ${platform} 流程使用已授权的宿主工具处理，不读项目源码修复环境，不要重放之前的手机动作。`
              : `${label} preparation is incomplete. Follow the ${platform} workflow in the maat-setup Skill using authorized host tools, not project source inspection; do not replay previous phone actions.`,
            ...setupPanel(snapshot, locale),
            setupAgentContext(snapshot, locale, { prepareAvailable: !!preparation }),
            `Execution error: ${message}`,
          ].join('\n');
        }
        maat.setup.interrupt({
          platform: 'macos',
          pendingAction: isScreenshot ? 'screenshot' : 'session',
        });
        const snapshot = await maat.setup.check({ platform: 'macos', signal });
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
    ...createSetupTools(maat, preparation),
    ...(preparation ? [createMobilePreparationTool(preparation)] : []),
  ];
}
