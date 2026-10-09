import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { type MaatApi, type SetupAction } from '@houlianpi/maat-core';
import { setupDoctor, setupPanel } from '../setup-ui.ts';
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
      execute: async (_id, params, _signal, _update, ctx) => {
        const locale = resolveSetupLocale(undefined, ctx);
        const snapshot = await maat.setup.check({
          platform: params.platform ?? maat.platforms.current().id,
        });
        return {
          content: [{ type: 'text', text: setupPanel(snapshot, locale).join('\n') }],
          structuredContent: snapshot,
          details: snapshot,
        };
      },
    }),
    defineTool({
      name: 'open_setup_step',
      label: 'Open Setup Step',
      description:
        'Open the macOS Settings page for the currently recommended setup step. Does not change permissions.',
      parameters: Type.Object({ actionId: Type.Optional(Type.String()) }),
      executionMode: 'sequential',
      execute: async (_id, params, _signal, _update, ctx) => {
        const locale = resolveSetupLocale(undefined, ctx);
        const activeCase = maat.cases.current();
        if (activeCase)
          maat.setup.interrupt({
            platform: 'macos',
            caseId: activeCase.id,
            pendingAction: params.actionId ?? maat.setup.current().recommendedAction?.id,
            workMode: 'case',
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
      execute: async (_id, _params, _signal, _update, ctx) => {
        const locale = resolveSetupLocale(undefined, ctx);
        const snapshot = await maat.setup.check({ platform: 'macos' });
        const resume = maat.setup.resume();
        return {
          content: [
            {
              type: 'text',
              text: `${setupPanel(snapshot, locale).join('\n')}${resume?.caseId ? `\n\n${locale === 'zh-CN' ? `已恢复 Case ${resume.caseId}，请从中断位置继续，不要重复已成功步骤。` : `Resumed Case ${resume.caseId}. Continue from the interruption without repeating successful steps.`}` : ''}`,
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
      execute: async (_id, _params, _signal, _update, ctx) => {
        const locale = resolveSetupLocale(undefined, ctx);
        const snapshot = await maat.setup.check({ platform: 'macos' });
        return {
          content: [{ type: 'text', text: setupDoctor(snapshot, locale) }],
          details: snapshot,
        };
      },
    }),
  ];
}
