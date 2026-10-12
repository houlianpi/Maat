import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { MaatApi, SetupSnapshot } from '@houlianpi/maat-core';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import type { TSchema } from '@earendil-works/pi-ai';
import { resolveSetupLocale, type SetupLocale } from './setup-i18n.ts';
import {
  compactResult,
  failureFacts,
  failureSummary,
  record,
  resultText,
  setupSnapshot,
  toolTitles,
} from './mobile-summary.ts';

/** Presentation only: no observation, recovery, device action or host policy changes. */
export function createMobileUi(pi: ExtensionAPI, maat: MaatApi) {
  let latestContext: ExtensionContext | undefined;
  let locale: SetupLocale = 'en';
  let platformId = maat.platforms.current().id;
  let snapshot: SetupSnapshot | undefined;
  let confirmed = false;
  let risk: 'locked' | 'lock-unknown' | 'wda-security' | 'connection' | undefined;
  const activeCalls = new Map<string, string>();
  const enabled = () => pi.getFlag('maat-mobile-ui') === true;
  const relevant = (name: string) => name === 'exe_js' || name === 'check_device_ready';
  const capture = (ctx: ExtensionContext) => {
    latestContext = ctx;
    locale = resolveSetupLocale(undefined, ctx);
  };

  pi.registerFlag('maat-mobile-ui', {
    description: 'Compact Maat tool cards and concise status',
    type: 'boolean',
    default: false,
  });

  const status = () => {
    const zh = locale === 'zh-CN';
    const names = [...activeCalls.values()];
    const deviceAction = snapshot?.capabilities.find(
      (item) =>
        item.required &&
        item.status !== 'ready' &&
        item.status !== 'skipped' &&
        (item.id === 'androidDevice' || item.id === 'iosDevice'),
    );
    // Explicit user-only actions and unresolved execution risk outrank activity.
    if (risk === 'locked') return zh ? '请解锁手机' : 'Unlock the phone';
    if (risk === 'lock-unknown')
      return zh ? '冷连接待明确授权' : 'Cold connection needs explicit authorization';
    if (risk === 'wda-security') return zh ? '请检查 WDA 信任或签名' : 'Check WDA trust or signing';
    if (risk) return zh ? '请检查连接' : 'Check the connection';
    if (deviceAction?.messageKey === 'capability.iosDevice.trust')
      return zh ? '请在 iPhone 信任此电脑' : 'Trust this computer on the iPhone';
    if (deviceAction?.messageKey === 'capability.iosDevice.select')
      return zh ? '请选择 iPhone' : 'Select the iPhone';
    if (deviceAction?.messageKey === 'capability.iosDevice.missing')
      return zh ? '请连接 iPhone' : 'Connect the iPhone';
    if (
      snapshot?.capabilities.some(
        (item) =>
          item.id === 'iosDeveloperMode' &&
          item.messageKey === 'capability.iosDeveloperMode.required',
      )
    )
      return zh ? '请本人开启开发者模式' : 'Enable Developer Mode yourself';
    if (deviceAction?.messageKey === 'capability.androidDevice.unauthorized')
      return zh ? '请允许 USB 调试' : 'Allow USB debugging on the phone';
    if (deviceAction?.messageKey === 'capability.androidDevice.select')
      return zh ? '请选择手机' : 'Select the phone';
    if (deviceAction?.messageKey === 'capability.androidDevice.missing')
      return zh ? '请连接手机' : 'Connect the phone';
    if (deviceAction && deviceAction.status !== 'unknown')
      return zh ? '请检查连接' : 'Check the connection';
    if (names.includes('exe_js')) return zh ? '正在操作' : 'Operating';
    if (
      names.some((name) =>
        ['check_device_ready', 'check_platform_setup', 'retry_setup_step'].includes(name),
      ) ||
      snapshot?.state === 'checking'
    )
      return zh ? '正在检查' : 'Checking';
    if (snapshot && !snapshot.canContinue) return zh ? '尚未准备' : 'Not prepared';
    if (confirmed) return zh ? '就绪' : 'Ready';
    return zh ? '待连接' : 'Awaiting connection';
  };
  const update = (ctx = latestContext) => {
    if (!ctx) return;
    capture(ctx);
    if (!enabled() || ctx.mode !== 'tui') return;
    try {
      ctx.ui.setWidget(
        'maat-status',
        () => ({
          render: (width) => [
            truncateToWidth(
              `${['android', 'ios'].includes(platformId) ? maat.platforms.current().label : locale === 'zh-CN' ? '手机' : 'Phone'} · ${status()}`,
              width,
            ),
          ],
          invalidate() {},
        }),
        { placement: 'aboveEditor' },
      );
    } catch {
      /* Presentation teardown cannot replace execution errors. */
    }
  };
  const reset = (ctx?: ExtensionContext) => {
    activeCalls.clear();
    snapshot = undefined;
    confirmed = false;
    risk = undefined;
    platformId = maat.platforms.current().id;
    latestContext = ctx;
    locale = 'en';
    update(ctx);
  };
  const prepared = (next: SetupSnapshot, ctx: ExtensionContext) => {
    capture(ctx);
    if (!enabled()) return;
    if (platformId !== maat.platforms.current().id) reset(ctx);
    if (next.platform === platformId) {
      snapshot = next;
      if (!next.canContinue) confirmed = false;
    }
    update(ctx);
  };

  for (const messageType of ['maat-android-setup', 'maat-ios-setup']) {
    pi.registerMessageRenderer<{ summary: string[] }>(messageType, (message, options) => {
      if (!enabled()) return undefined;
      return new Text(
        options.expanded
          ? resultText({ content: [{ type: 'text', text: message.content }] })
          : (message.details?.summary.join('\n') ??
            (locale === 'zh-CN' ? '手机准备' : 'Phone preparation')),
        0,
        0,
      );
    });
  }
  pi.on('session_start', (_event, ctx) => reset(ctx));
  pi.on('session_tree', (_event, ctx) => reset(ctx));
  pi.on('session_shutdown', () => reset());
  pi.on('before_agent_start', (_event, ctx) => update(ctx));
  pi.on('agent_end', (_event, ctx) => update(ctx));
  pi.on('tool_execution_start', (event, ctx) => {
    capture(ctx);
    if (!enabled() || !toolTitles[event.toolName]) return;
    activeCalls.set(event.toolCallId, event.toolName);
    update(ctx);
  });
  pi.on('tool_execution_end', (event, ctx) => {
    capture(ctx);
    if (!enabled() || !toolTitles[event.toolName]) return;
    activeCalls.delete(event.toolCallId);
    if (platformId !== maat.platforms.current().id) {
      reset(ctx);
    } else if (
      !event.isError &&
      ['select_platform', 'configure_session', 'configure_browser'].includes(event.toolName)
    ) {
      // Accepted routing invalidates confirmation, not same-platform action uncertainty.
      confirmed = false;
      snapshot = undefined;
    }
    const result = record(event.result);
    const details = result.details ?? result.structuredContent;
    const facts = record(details);
    if (event.toolName === 'release_device_session' && !event.isError && facts.released === true) {
      confirmed = false;
      snapshot = undefined;
      risk = undefined;
    }
    const next = setupSnapshot(facts.snapshot ?? details) ?? setupSnapshot(facts.setup);
    if (next?.platform === platformId) {
      snapshot = next;
      if (!next.canContinue) confirmed = false;
    }
    if (relevant(event.toolName)) {
      if (event.isError) {
        const failure = failureFacts(event.result);
        risk =
          failure.code === 'ANDROID_DEVICE_LOCKED' || failure.code === 'IOS_DEVICE_LOCKED'
            ? 'locked'
            : failure.code === 'IOS_DEVICE_LOCK_STATE_UNKNOWN'
              ? 'lock-unknown'
              : failure.code === 'IOS_WDA_SECURITY_REJECTED'
                ? 'wda-security'
                : 'connection';
        confirmed = false;
      } else if (event.toolName === 'check_device_ready' && facts.ready === true) {
        // Only an actual recent channel check resolves the connection warning.
        confirmed = true;
        risk = undefined;
      }
    }
    update(ctx);
  });

  const decorate = <P extends TSchema, D, S>(
    tool: ToolDefinition<P, D, S>,
  ): ToolDefinition<P, D, S> => {
    if (!enabled()) return tool;
    return {
      ...tool,
      renderShell: 'self',
      renderCall: (args, theme, context) => ({
        render: (width) => {
          const zh = locale === 'zh-CN';
          const title = toolTitles[tool.name]?.[zh ? 0 : 1] ?? tool.label;
          const state = record(context.state);
          const phase =
            state.maatReturned === true
              ? ''
              : !context.argsComplete
                ? zh
                  ? '生成参数中'
                  : 'Generating arguments'
                : context.executionStarted
                  ? zh
                    ? '执行中'
                    : 'Executing'
                  : zh
                    ? '待执行'
                    : 'Queued';
          return new Text(
            theme.fg('toolOutput', `${title}${phase ? ` · ${phase}` : ''}`) +
              (context.expanded ? `\n${JSON.stringify(args, null, 2)}` : ''),
            0,
            0,
          ).render(width);
        },
        invalidate() {},
      }),
      renderResult: (result, options, theme, context) => {
        record(context.state).maatReturned = !options.isPartial;
        const lines = options.isPartial
          ? [locale === 'zh-CN' ? '部分结果' : 'Partial result']
          : context.isError
            ? failureSummary(result, locale)
            : compactResult(tool.name, result, locale);
        const raw = record(result);
        const expanded = options.expanded
          ? [
              resultText(result),
              ...(raw.details !== undefined ? [JSON.stringify(raw.details, null, 2)] : []),
              ...(raw.structuredContent !== undefined
                ? [JSON.stringify(raw.structuredContent, null, 2)]
                : []),
            ]
              .filter(Boolean)
              .join('\n')
          : '';
        return new Text(
          theme.fg(context.isError ? 'error' : 'toolOutput', lines.join('\n')) +
            (expanded ? `\n${expanded}` : ''),
          0,
          0,
        );
      },
    };
  };
  return Object.assign(decorate, { update, prepared });
}
