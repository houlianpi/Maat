import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { type MaatApi, type SetupAction } from '@houlianpi/maat-core';
import { setupAgentContext, setupDoctor, setupPanel } from '../setup-ui.ts';
import { resolveSetupLocale, setupMessage } from '../setup-i18n.ts';

const exec = promisify(execFile);

export function createSetupTools(maat: MaatApi): ToolDefinition<any, any, any>[] {
  return [
    defineTool({
      name: 'check_platform_setup',
      label: 'Check Platform Setup',
      description: 'Read-only check of the selected platform setup and available capabilities.',
      parameters: Type.Object({ platform: Type.Optional(Type.String()) }),
      executionMode: 'sequential',
      execute: async (_id, params, signal, _update, ctx) => {
        const locale = resolveSetupLocale(undefined, ctx);
        const snapshot = await maat.setup.check({
          platform: params.platform ?? maat.platforms.current().id,
          signal,
        });
        return {
          content: [
            {
              type: 'text',
              text: `${setupPanel(snapshot, locale).join('\n')}\n\n${setupAgentContext(snapshot, locale)}`,
            },
          ],
          structuredContent: snapshot,
          details: snapshot,
        };
      },
    }),
    defineTool({
      name: 'check_device_ready',
      label: 'Check Device Ready',
      description:
        'Verify the selected local Android control channel and return its current UI observation. A new Session requires an awake/unlocked local phone and may deploy missing automation helpers. This is not a dependency-only doctor or business validation; cold remote setup is unsupported.',
      parameters: Type.Object({ screenshot: Type.Optional(Type.Boolean()) }),
      executionMode: 'sequential',
      execute: async (_id, params, signal, _update, ctx) => {
        const locale = resolveSetupLocale(undefined, ctx);
        let result: Awaited<ReturnType<typeof maat.setup.ready>>;
        try {
          result = await maat.setup.ready({ screenshot: params.screenshot, signal });
        } catch (error) {
          if (error instanceof Error && error.message.includes('ANDROID_DEVICE_LOCKED'))
            throw new Error(
              locale === 'zh-CN'
                ? 'ANDROID_DEVICE_LOCKED：手机已锁定或熄屏。请本人点亮并解锁手机，完成后重新检查；不要重启服务或重复之前的操作。'
                : 'ANDROID_DEVICE_LOCKED: the phone is locked or its screen is off. Wake and unlock it yourself, then recheck; do not restart the service or repeat previous actions.',
              { cause: error },
            );
          throw error;
        }
        const { observations, ...readiness } = result;
        return {
          content: [
            {
              type: 'text',
              text:
                locale === 'zh-CN'
                  ? 'Android 操作通道已确认。请复用下面的当前界面观察继续任务；这不代表业务任务已完成。'
                  : 'The Android control channel is ready. Reuse the current observation below; this does not prove the business task completed.',
            },
            ...observations,
          ],
          structuredContent: readiness,
          details: readiness,
        };
      },
    }),
    defineTool({
      name: 'open_setup_step',
      label: 'Open Setup Step',
      description:
        'Return Android preparation instructions for the host Agent, or open the recommended macOS Settings page. Does not install, launch services or change permissions.',
      parameters: Type.Object({ actionId: Type.Optional(Type.String()) }),
      executionMode: 'sequential',
      execute: async (_id, params, _signal, _update, ctx) => {
        const locale = resolveSetupLocale(undefined, ctx);
        if (maat.platforms.current().id === 'android') {
          const snapshot = maat.setup.current();
          const action = params.actionId
            ? snapshot.capabilities.find((item) => item.action?.id === params.actionId)?.action
            : snapshot.recommendedAction;
          if (snapshot.platform !== 'android' || !action)
            throw new Error(
              'Check Android setup first; no matching preparation step is available.',
            );
          return {
            content: [
              {
                type: 'text',
                text: [
                  setupMessage(locale, action.labelKey),
                  setupAgentContext(snapshot, locale),
                  locale === 'zh-CN'
                    ? '尚未执行任何系统修改。请按 maat-setup Skill 使用宿主工具完成已授权的准备，再重新检查。'
                    : 'No system changes were executed. Follow the maat-setup Skill using authorized host tools, then recheck.',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            details: action,
          };
        }
        maat.setup.interrupt({
          platform: 'macos',
          pendingAction: params.actionId ?? maat.setup.current().recommendedAction?.id,
        });
        const action = await maat.setup.action(params.actionId as SetupAction['id'] | undefined);
        if (action.settingsUrl) await exec('open', [action.settingsUrl]);
        return {
          content: [
            {
              type: 'text',
              text: action.settingsUrl
                ? `${
                    action.id === 'open-screen-recording'
                      ? locale === 'zh-CN'
                        ? '已打开系统设置。请允许 Xcode、启动 Appium 的终端，以及列表中的 macOS 自动化组件。'
                        : 'System Settings opened. Allow Xcode, the terminal that starts Appium, and the listed macOS automation component.'
                      : locale === 'zh-CN'
                        ? '已打开系统设置。'
                        : 'System Settings opened.'
                  } ${locale === 'zh-CN' ? '完成后运行 retry_setup_step。' : 'Run retry_setup_step when finished.'}`
                : `${setupMessage(locale, action.labelKey)}\n${action.command ?? ''}`.trim(),
            },
          ],
          details: action,
        };
      },
    }),
    defineTool({
      name: 'retry_setup_step',
      label: 'Retry Setup Step',
      description: 'Recheck setup after the user finishes the requested system action.',
      parameters: Type.Object({}),
      executionMode: 'sequential',
      execute: async (_id, _params, signal, _update, ctx) => {
        const locale = resolveSetupLocale(undefined, ctx);
        const platform = maat.platforms.current().id === 'android' ? 'android' : 'macos';
        const snapshot = await maat.setup.check({ platform, signal });
        const resume = platform === 'macos' ? maat.setup.resume() : undefined;
        return {
          content: [
            {
              type: 'text',
              text: `${setupPanel(snapshot, locale).join('\n')}\n\n${setupAgentContext(snapshot, locale)}${resume ? `\n\n${locale === 'zh-CN' ? '准备状态已重新检查。请读取当前界面后继续原任务，不要重复已可能执行的操作。' : 'Preparation was rechecked. Read the current UI before continuing; do not repeat potentially executed actions.'}` : ''}`,
            },
          ],
          details: { snapshot, resume },
        };
      },
    }),
    defineTool({
      name: 'continue_without_capability',
      label: 'Continue Without Capability',
      description:
        'Record the user choice to continue without an optional capability for the current Appium/WDA process.',
      parameters: Type.Object({
        capability: Type.Union([
          Type.Literal('screenCapture'),
          Type.Literal('videoRecording'),
          Type.Literal('fullDiskAccess'),
        ]),
      }),
      executionMode: 'sequential',
      execute: async (_id, params, _signal, _update, ctx) => {
        const locale = resolveSetupLocale(undefined, ctx);
        const snapshot = await maat.setup.skip(params.capability);
        return {
          content: [{ type: 'text', text: setupPanel(snapshot, locale).join('\n') }],
          details: snapshot,
        };
      },
    }),
    defineTool({
      name: 'get_setup_diagnostics',
      label: 'Get Setup Diagnostics',
      description: 'Return redacted technical setup diagnostics for engineers.',
      parameters: Type.Object({}),
      execute: async (_id, _params, signal, _update, ctx) => {
        const locale = resolveSetupLocale(undefined, ctx);
        const platform = maat.platforms.current().id === 'android' ? 'android' : 'macos';
        const snapshot = await maat.setup.check({ platform, signal });
        return {
          content: [
            {
              type: 'text',
              text: `${setupDoctor(snapshot, locale)}\n\n${setupAgentContext(snapshot, locale)}`,
            },
          ],
          details: snapshot,
        };
      },
    }),
  ];
}
