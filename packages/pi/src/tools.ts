import type { MaatApi } from '@houlianpi/maat-core';
import { createCaseTools } from './tools/case-tools.ts';
import { createExecJsTool } from './tools/exec-js-tool.ts';
import { createPlatformTools } from './tools/platform-tools.ts';
import { createSetupTools } from './tools/setup-tools.ts';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { setupPanel } from './setup-ui.ts';

/** Pi-specific projection of the host-neutral Maat API. */
export function createMaatPiTools(maat: MaatApi): ToolDefinition<any, any, any>[] {
  return [
    createExecJsTool(
      {
        close: () => maat.platforms.current().close(),
        execute: (code, signal) => maat.exploration.executeJavaScript(code, signal),
      },
      maat.drafts,
      {
        description:
          'Execute JavaScript against the active Platform Adapter. Call list_platforms after switching to see the available runtime globals.',
        guidelines: ['Use only globals exposed by the active adapter codeContext.'],
      },
      () => maat.exploration.execution(),
      async (error) => {
        if (maat.platforms.current().id !== 'macos') return;
        const message = String(error);
        const isScreenshot = message.includes('MACOS_SCREEN_CAPTURE_PERMISSION_REQUIRED');
        const isSetupFailure =
          isScreenshot ||
          /ECONNREFUSED|connection refused|Appium.*(?:unavailable|not reachable)|Mac2.*(?:missing|not installed)|Could not find.*driver/i.test(
            message,
          );
        if (!isSetupFailure) return;
        maat.setup.interrupt({
          platform: 'macos',
          caseId: maat.cases.current()?.id,
          pendingAction: isScreenshot ? 'screenshot' : 'session',
          workMode: maat.cases.current() ? 'case' : 'assist',
        });
        const snapshot = await maat.setup.check({ platform: 'macos' });
        const explanation = isScreenshot
          ? '已经通过的业务断言仍然有效；只有截图 Evidence 尚未开启。'
          : 'macOS 测试环境需要完成一个设置。当前 Case 已保留。';
        return `${explanation}\n${setupPanel(snapshot).join('\n')}`;
      },
    ),
    ...createCaseTools(maat),
    ...createPlatformTools(maat),
    ...createSetupTools(maat),
  ];
}
