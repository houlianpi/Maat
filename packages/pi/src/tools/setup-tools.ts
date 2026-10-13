import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { type MaatApi, type SetupAction } from '@houlianpi/maat-core';
import { setupAgentContext, setupDoctor, setupPanel } from '../setup-ui.ts';
import { phoneReadinessGuidance, resolveSetupLocale, setupMessage } from '../setup-i18n.ts';
import type { MobilePreparation } from '../mobile-preparation.ts';

const exec = promisify(execFile);

function hasCode(error: unknown, code: string, depth = 0): boolean {
  if (depth > 4 || !error || typeof error !== 'object') return false;
  if ('code' in error && error.code === code) return true;
  if (error instanceof AggregateError)
    return error.errors.some((item) => hasCode(item, code, depth + 1));
  return error instanceof Error && hasCode(error.cause, code, depth + 1);
}

export function createSetupTools(
  maat: MaatApi,
  preparation?: MobilePreparation,
): ToolDefinition<any, any, any>[] {
  const options = { prepareAvailable: !!preparation };
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
              text: `${setupPanel(snapshot, locale).join('\n')}\n\n${setupAgentContext(snapshot, locale, options)}`,
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
        'Establish or reuse the selected local Android or physical iPhone control connection and verify readiness before returning its current UI observation. Ordinary iOS connection initialization is allowed by default using a valid WDA build and an existing phone helper; live WDA must confirm unlocked state before source, screenshot or business UI. First WDA installation, signing changes and restarts require separate explicit authorization; never automatically unlock. This is not a dependency-only doctor or business validation; remote readiness is unsupported.',
      parameters: Type.Object(
        {
          jobId: Type.Optional(
            Type.String({
              description:
                'Opaque bearer ID returned by a prior check_device_ready start. With jobId, omit all start-only fields.',
            }),
          ),
          jobAction: Type.Optional(Type.Union([Type.Literal('query'), Type.Literal('cancel')])),
          waitSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
          screenshot: Type.Optional(Type.Boolean()),
          allowWdaInstallation: Type.Optional(
            Type.Boolean({
              description:
                'iOS only, this attempt only. Set true only after the user explicitly authorizes first installation of the WDA control component on the selected phone. Never infer this grant from an ordinary phone task or set it automatically. Not permission for signing changes, restart or unlock. Handle this internal grant yourself, not as a technical parameter assignment for the user.',
            }),
          ),
          targetSelection: Type.Optional(
            Type.Object(
              {
                discoveryId: Type.String({
                  description:
                    'Ephemeral discovery snapshot returned by the latest check_device_ready result.',
                }),
                candidateNumber: Type.Integer({
                  minimum: 1,
                  description: 'Number shown for the candidate in that same discovery snapshot.',
                }),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      executionMode: 'sequential',
      execute: async (_id, params, signal, _update, ctx) => {
        const locale = resolveSetupLocale(undefined, ctx);
        let result: Awaited<ReturnType<typeof maat.setup.ready>>;
        try {
          result = await maat.setup.ready({
            ...(params.jobId
              ? {
                  jobId: params.jobId,
                  ...(params.jobAction ? { jobAction: params.jobAction } : {}),
                }
              : {
                  screenshot: params.screenshot,
                  allowWdaInstallation: params.allowWdaInstallation,
                  ...(params.targetSelection ? { targetSelection: params.targetSelection } : {}),
                }),
            ...(params.waitSeconds === undefined ? {} : { waitSeconds: params.waitSeconds }),
            signal,
          });
        } catch (error) {
          const creationUncertain = hasCode(error, 'phone-session-creation-uncertain');
          if (creationUncertain)
            throw new Error(
              [
                'PHONE_READINESS_RECOVERY_REQUIRED',
                'category: phone-session-creation-uncertain',
                'code: phone-session-creation-uncertain',
                'phase: session-create',
                'readiness: creation-unconfirmed',
                'summary: Phone Session creation was not confirmed; a Session resource may exist, but no phone UI observation or user action ran.',
                'recovery: Do not call check_device_ready, exe_js, configure, release, recreate, or DELETE an unknown Session in this process. Restart the Maat process only after the user has safely handled the external Appium state.',
              ].join('\n'),
              { cause: error },
            );
          const message = error instanceof Error ? error.message : String(error);
          const guidance = phoneReadinessGuidance(message, locale);
          if (guidance) throw new Error(`${message}\n${guidance}`, { cause: error });
          throw error;
        }
        if ('jobId' in result) {
          if (result.state !== 'succeeded') {
            const text =
              result.state === 'creation-uncertain'
                ? `PHONE_READINESS_RECOVERY_REQUIRED\ncategory: ${result.category}\njobId: ${result.jobId}\nreadiness: recovery-required\nDo not start, recreate, delete, release, configure, or execute phone operations in this process.`
                : `Phone connection job ${result.state} (jobId: ${result.jobId}${result.category ? `, category: ${result.category}` : ''}). ${
                    result.state === 'queued' || result.state === 'running'
                      ? 'This wait ended without stopping or extending the job; query the same jobId.'
                      : 'This is not device readiness or business success.'
                  }`;
            return {
              content: [{ type: 'text', text }],
              structuredContent: result,
              details: result,
            };
          }
          if (result.ready !== true || !result.platform || !result.proof || !result.observations)
            throw new Error('Succeeded connection job did not retain its readiness result.');
          const { observations, ...snapshot } = result;
          return {
            content: [
              {
                type: 'text',
                text: `Conclusion: phone tasks can start. The ${result.platform === 'ios' ? 'iOS' : 'Android'} control channel is ready; reuse the current observation below. This does not prove the business task completed.`,
              },
              ...observations,
            ],
            structuredContent: snapshot,
            details: snapshot,
          };
        }
        if (!result.ready) {
          const text =
            result.status === 'selection-required'
              ? locale === 'zh-CN'
                ? `需要选择当前手机。请只使用本结果中的临时 discoveryId 和候选编号再次调用 check_device_ready：\n${JSON.stringify(result)}`
                : `Current phone selection is required. Call check_device_ready again using only this result's ephemeral discoveryId and candidate number:\n${JSON.stringify(result)}`
              : result.status === 'target-selected'
                ? locale === 'zh-CN'
                  ? `已为本连接生命周期选择手机目标：${result.candidate.displayName}（${result.candidate.kind}，${result.candidate.discriminator}）；${result.selectedBy === 'single-candidate' ? '因当前仅有一个候选而自动选择' : '按本次明确选择确定'}。这只是选择披露，尚未执行环境检查、创建 Session 或读取手机界面。请先向用户披露此目标，然后再次调用 check_device_ready 继续准备。`
                  : `Phone target selected for this connection lifecycle: ${result.candidate.displayName} (${result.candidate.kind}, ${result.candidate.discriminator}); ${result.selectedBy === 'single-candidate' ? 'auto-selected because it was the only current candidate' : 'chosen by explicit selection'}. This is selection disclosure, not readiness: no doctor check, Session creation, or phone UI read has run. Disclose this target, then call check_device_ready again to continue readiness.`
                : locale === 'zh-CN'
                  ? `手机目标尚未选择（${result.status}）。未创建 Session，也未执行手机操作。`
                  : `No phone target was selected (${result.status}). No Session or phone action was started.`;
          return {
            content: [{ type: 'text', text }],
            structuredContent: result,
            details: result,
          };
        }
        const { observations, ...readiness } = result;
        const disclosure = result.targetSelection
          ? locale === 'zh-CN'
            ? `本连接生命周期目标：${result.targetSelection.candidate.displayName}（${result.targetSelection.candidate.kind}，${result.targetSelection.candidate.discriminator}）；${result.targetSelection.selectedBy === 'single-candidate' ? '因当前仅有一个候选而自动选择' : '按本次明确选择确定'}。`
            : `Connection lifecycle target: ${result.targetSelection.candidate.displayName} (${result.targetSelection.candidate.kind}, ${result.targetSelection.candidate.discriminator}); ${result.targetSelection.selectedBy === 'single-candidate' ? 'auto-selected because it was the only current candidate' : 'chosen by explicit selection'}.`
          : '';
        return {
          content: [
            {
              type: 'text',
              text:
                locale === 'zh-CN'
                  ? `${disclosure}\n结论：可以开始手机任务。${result.platform === 'ios' ? 'iOS' : 'Android'} 操作通道已确认，请复用下面的当前界面观察继续；这不代表业务任务已完成。`
                  : `${disclosure}\nConclusion: phone tasks can start. The ${result.platform === 'ios' ? 'iOS' : 'Android'} control channel is ready; reuse the current observation below. This does not prove the business task completed.`,
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
        'Return Android/iPhone preparation instructions for the host Agent, or open the recommended macOS Settings page. Does not install, launch services or change permissions.',
      parameters: Type.Object({ actionId: Type.Optional(Type.String()) }),
      executionMode: 'sequential',
      execute: async (_id, params, _signal, _update, ctx) => {
        const locale = resolveSetupLocale(undefined, ctx);
        const platform = maat.platforms.current().id;
        if (platform === 'android' || platform === 'ios') {
          const snapshot = maat.setup.current();
          const action = params.actionId
            ? snapshot.capabilities.find((item) => item.action?.id === params.actionId)?.action
            : snapshot.recommendedAction;
          if (snapshot.platform !== platform || !action)
            throw new Error(
              `Check ${platform} setup first; no matching preparation step is available.`,
            );
          return {
            content: [
              {
                type: 'text',
                text: [
                  setupMessage(locale, action.labelKey),
                  setupAgentContext(snapshot, locale, options),
                  locale === 'zh-CN'
                    ? '尚未执行任何系统修改。请按 maat-setup Skill 使用宿主工具完成已授权的准备，再重新检查。'
                    : 'No system changes were executed. Follow the maat-setup Skill using authorized host tools, then recheck.',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            details: { ...action, systemChangesExecuted: false },
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
        const platform = maat.platforms.current().id;
        const snapshot = await maat.setup.check({ platform, signal });
        const resume = platform === 'macos' ? maat.setup.resume() : undefined;
        return {
          content: [
            {
              type: 'text',
              text: `${setupPanel(snapshot, locale).join('\n')}\n\n${setupAgentContext(snapshot, locale, options)}${resume ? `\n\n${locale === 'zh-CN' ? '准备状态已重新检查。请读取当前界面后继续原任务，不要重复已可能执行的操作。' : 'Preparation was rechecked. Read the current UI before continuing; do not repeat potentially executed actions.'}` : ''}`,
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
        const platform = maat.platforms.current().id;
        const snapshot = await maat.setup.check({ platform, signal });
        return {
          content: [
            {
              type: 'text',
              text: `${setupDoctor(snapshot, locale)}\n\n${setupAgentContext(snapshot, locale, options)}`,
            },
          ],
          details: snapshot,
        };
      },
    }),
  ];
}
