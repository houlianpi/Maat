import { setupMessage, type SetupLocale } from './setup-i18n.ts';
import type { SetupSnapshot } from '@houlianpi/maat-core';

export const toolTitles: Record<string, [string, string]> = {
  release_device_session: ['释放手机连接', 'Release phone connection'],
  exe_js: ['执行 JavaScript', 'Execute JavaScript'],
  check_device_ready: ['检查手机通道', 'Check phone channel'],
  list_platforms: ['查看可用平台', 'Available platforms'],
  select_platform: ['选择平台', 'Select platform'],
  list_devices: ['查找设备', 'Discover devices'],
  find_applications: ['查找应用', 'Find applications'],
  configure_session: ['配置连接', 'Configure connection'],
  configure_browser: ['配置浏览器', 'Configure browser'],
  get_browser_config: ['浏览器配置', 'Browser configuration'],
  check_platform_setup: ['检查准备条件', 'Check preparation'],
  retry_setup_step: ['复查准备条件', 'Recheck preparation'],
  open_setup_step: ['准备下一步', 'Next preparation step'],
  continue_without_capability: ['可选能力选择', 'Optional capability choice'],
  get_setup_diagnostics: ['准备诊断', 'Preparation diagnostics'],
};

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function resultText(result: unknown): string {
  const content = record(result).content;
  return Array.isArray(content)
    ? content
        .flatMap((item: unknown) => {
          const entry = record(item);
          return entry.type === 'text' && typeof entry.text === 'string' ? [entry.text] : [];
        })
        .join('\n')
    : '';
}

export function setupSnapshot(value: unknown): SetupSnapshot | undefined {
  const candidate = record(value);
  if (
    typeof candidate.platform !== 'string' ||
    typeof candidate.canContinue !== 'boolean' ||
    !Array.isArray(candidate.capabilities) ||
    typeof candidate.state !== 'string'
  )
    return;
  // Producers own this typed contract; reject malformed historical data before using it.
  if (
    !candidate.capabilities.every(
      (item: unknown) =>
        typeof record(item).messageKey === 'string' && typeof record(item).status === 'string',
    )
  )
    return;
  return candidate as unknown as SetupSnapshot;
}

export function preparationSummary(snapshot: SetupSnapshot, locale: SetupLocale): string[] {
  const zh = locale === 'zh-CN';
  const blockers = snapshot.capabilities.filter(
    (item) => item.status !== 'ready' && item.status !== 'skipped',
  );
  return [
    snapshot.state === 'unknown'
      ? zh
        ? '准备未检查'
        : 'Preparation not checked'
      : snapshot.state === 'checking'
        ? zh
          ? '准备检查中'
          : 'Checking preparation'
        : snapshot.canContinue
          ? zh
            ? '准备通过 · 通道待确认'
            : 'Preparation passed · channel unconfirmed'
          : zh
            ? '准备阻塞'
            : 'Preparation blocked',
    ...(blockers.length
      ? [
          `${zh ? '待处理' : 'Needs attention'} (${blockers.length}): ${blockers
            .slice(0, 2)
            .map(
              (item) =>
                `${item.errorCode ? `${item.errorCode}: ` : ''}${setupMessage(locale, item.messageKey)}`,
            )
            .join(' · ')}`,
        ]
      : []),
    `${zh ? '下一步' : 'Next'}: ${
      snapshot.recommendedAction
        ? setupMessage(locale, snapshot.recommendedAction.labelKey)
        : snapshot.canContinue
          ? snapshot.platform === 'android' || snapshot.platform === 'ios'
            ? 'check_device_ready'
            : 'exe_js'
          : zh
            ? '按 setup Skill 检查缺项'
            : 'Diagnose missing conditions with the setup Skill'
    }`,
  ];
}

export type FailureFacts = {
  reason: string;
  actionState: 'not-started' | 'uncertain';
  phase?: string;
  name?: string;
  code?: string;
};

export function failureFacts(result: unknown): FailureFacts {
  const text = resultText(result);
  const details = record(record(result).details);
  const facts = record(details.failure ?? details);
  // Only the existing, explicitly versioned machine failure envelope is parsed.
  // Never infer actions, authorization or task status from JS or natural language.
  const lines = text.split('\n');
  const envelope = lines[0] === 'MAAT_EXECUTION_FAILED';
  const field = (key: string): string | undefined => {
    if (typeof facts[key] === 'string') return facts[key];
    return envelope
      ? lines.find((line) => line.startsWith(`${key}: `))?.slice(key.length + 2)
      : undefined;
  };
  const code =
    field('code') ??
    /\b(?:ANDROID_DEVICE_LOCKED|IOS_DEVICE_LOCKED|IOS_DEVICE_LOCK_STATE_UNKNOWN|IOS_WDA_SECURITY_REJECTED)\b/.exec(
      envelope ? (field('summary') ?? '') : (text.split('\n')[0] ?? ''),
    )?.[0];
  return {
    reason:
      field('summary') ??
      (text.split('\n').filter(Boolean).slice(0, 2).join(' · ') || 'Unknown error'),
    actionState: field('actionState') === 'not-started' ? 'not-started' : 'uncertain',
    phase: field('phase'),
    name: field('name') ?? field('category'),
    code,
  };
}

export function failureSummary(result: unknown, locale: SetupLocale): string[] {
  const facts = failureFacts(result);
  const zh = locale === 'zh-CN';
  return [
    [
      facts.name,
      facts.phase,
      facts.reason.length > 350 ? `${facts.reason.slice(0, 350)}…` : facts.reason,
    ]
      .filter(Boolean)
      .join(' · '),
    facts.actionState === 'not-started'
      ? zh
        ? '未执行 UI 动作'
        : 'No UI action ran'
      : facts.code === 'IOS_DEVICE_LOCK_STATE_UNKNOWN'
        ? zh
          ? '执行不确定 · 勿重放；冷连接仍被阻止'
          : 'Execution uncertain · do not replay; cold connection remains blocked'
        : zh
          ? '执行不确定 · 先只读观察，勿重放'
          : 'Execution uncertain · observe read-only; do not replay',
    facts.code === 'ANDROID_DEVICE_LOCKED' || facts.code === 'IOS_DEVICE_LOCKED'
      ? zh
        ? '下一步：请本人点亮并解锁，再重新检查'
        : 'Next: wake and unlock the phone yourself, then recheck'
      : facts.code === 'IOS_DEVICE_LOCK_STATE_UNKNOWN'
        ? zh
          ? '下一步：本人确认手机状态，明确授权本次 WDA 初始化；不自动绕过冷保护'
          : 'Next: confirm phone state and explicitly authorize this WDA initialization; no automatic cold-guard bypass'
        : facts.code === 'IOS_WDA_SECURITY_REJECTED'
          ? zh
            ? '下一步：检查开发者 App 信任；已信任或无入口则核查签名/有效期，勿循环重试'
            : 'Next: check developer App trust; if trusted or absent, inspect signing/profile expiry; no retry loop'
          : zh
            ? '下一步：检查连接并只读观察，不自动重试动作'
            : 'Next: check the connection and observe read-only; no automatic action retry',
  ];
}

function shortText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const characters = Array.from(trimmed);
  const preview = characters.slice(0, 240).join('');
  const lines = preview.split('\n');
  const truncated = characters.length > 240 || lines.length > 3;
  const visible = lines.slice(0, 3);
  if (truncated) {
    const content = Array.from(visible.join('\n')).slice(0, 239).join('');
    return `${content}…`.split('\n');
  }
  return visible;
}

export function compactResult(name: string, result: unknown, locale: SetupLocale): string[] {
  const zh = locale === 'zh-CN';
  const text = resultText(result);
  const object = record(result);
  const details: unknown = object.details ?? object.structuredContent;
  const facts = record(details);
  if (name === 'release_device_session' && facts.released === true)
    return [zh ? '手机连接已释放 · 对话保留' : 'Phone Session released · conversation retained'];
  const snapshot = setupSnapshot(facts.snapshot ?? details);
  if (snapshot) {
    const summary = preparationSummary(snapshot, locale);
    if (name === 'continue_without_capability') {
      const skipped = snapshot.capabilities.filter((item) => item.status === 'skipped');
      if (skipped.length)
        summary[0] += ` · ${zh ? '已跳过可选能力' : 'Optional capabilities skipped'}: ${skipped.map((item) => item.id).join(', ')}`;
    }
    if (name === 'get_setup_diagnostics' && snapshot.checkedAt)
      summary[0] += ` · ${snapshot.checkedAt}`;
    return summary;
  }
  if (['list_platforms', 'list_devices', 'find_applications'].includes(name)) {
    let entries: unknown = details;
    if (!Array.isArray(entries)) {
      try {
        entries = JSON.parse(text);
      } catch {
        /* conservative fallback */
      }
    }
    if (Array.isArray(entries)) {
      const names = entries
        .slice(0, name === 'list_platforms' ? 8 : 3)
        .flatMap((entry: unknown) => {
          const item = record(entry);
          const label =
            item.label ??
            item.name ??
            item.displayName ??
            (name === 'list_platforms' ? item.id : undefined);
          if (name === 'list_devices' && label === item.id) return [];
          return typeof label === 'string' ? [label] : [];
        });
      return [
        `${zh ? '数量' : 'Count'}: ${entries.length}${names.length ? ` · ${names.join(' · ')}` : ''}`,
        ...(entries.length === 0
          ? [
              zh
                ? '结果为空 · 请检查平台/目标或查询条件'
                : 'Empty result · check platform/target or query',
            ]
          : []),
      ];
    }
  }
  if (name === 'configure_session')
    return [zh ? '配置连接 · 提示已接收，连接待验证' : 'Connection hints accepted · unverified'];
  if (name === 'configure_browser' || name === 'get_browser_config')
    return [
      `${typeof facts.browser === 'string' ? facts.browser : zh ? '浏览器' : 'Browser'} · ${
        facts.headless === true
          ? zh
            ? '无窗口'
            : 'Headless'
          : facts.headless === false
            ? zh
              ? '有窗口'
              : 'Headed'
            : zh
              ? '未指定窗口模式'
              : 'Window mode unspecified'
      } · ${zh ? '仅配置' : 'Configuration only'}`,
    ];
  if (name === 'select_platform') {
    const state = record(facts.state);
    const setup = setupSnapshot(facts.setup);
    const summary = setup
      ? preparationSummary(setup, locale)
      : [zh ? '通道待确认' : 'channel unconfirmed'];
    summary[0] = `${zh ? '已选择' : 'Selected'}: ${state.label ?? state.id ?? 'platform'} · ${summary[0]}`;
    return summary;
  }
  if (name === 'check_device_ready' && facts.ready === true)
    return [zh ? '检查手机通道 · 通道已确认' : 'Phone channel · Confirmed'];
  if (name === 'open_setup_step' && typeof facts.labelKey === 'string')
    return [
      setupMessage(locale, facts.labelKey as Parameters<typeof setupMessage>[1]),
      ...(facts.systemChangesExecuted === false
        ? [
            zh
              ? '未执行系统修改 · 按 setup Skill 使用已授权宿主工具准备后再检查'
              : 'No system changes executed · use authorized host tools via setup Skill, then recheck',
          ]
        : shortText(text).slice(-1)),
    ];
  const visible = shortText(text);
  if (name === 'exe_js' && visible.length) return visible;
  const content = object.content;
  const images = Array.isArray(content)
    ? content.filter((item: unknown) => record(item).type === 'image').length
    : 0;
  const title =
    name === 'exe_js'
      ? zh
        ? '手机操作'
        : 'Phone operation'
      : (toolTitles[name]?.[zh ? 0 : 1] ?? name);
  const summary =
    !text && images
      ? zh
        ? `返回 ${images} 张图片`
        : `Returned ${images} image${images === 1 ? '' : 's'}`
      : zh
        ? '已返回'
        : 'Returned';
  return [`${title} · ${summary}`, ...visible];
}
