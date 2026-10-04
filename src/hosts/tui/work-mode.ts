import { Type } from '@earendil-works/pi-ai';
import type { ExtensionContext, InlineExtension } from '@earendil-works/pi-coding-agent';

export type WorkMode = 'assist' | 'case';
const protectedTools = new Set(['bash', 'powershell', 'edit', 'write']);
const caseTools = new Set(['begin_case', 'exe_js', 'save_case']);
const entryType = 'maat-work-mode';
const blockedReason =
  'Case mode: shell and direct file edits are disabled. Use Maat execution and save_case tools. To troubleshoot, explicitly switch to assist mode with user approval.';

// A workflow guard, not an OS security sandbox for generated code.
export class WorkModePolicy {
  mode: WorkMode = 'assist';

  beforeTool(name: string): string | undefined {
    if (caseTools.has(name)) this.mode = 'case';
    if (this.mode === 'case' && protectedTools.has(name)) return blockedReason;
  }

  afterTool(name: string, isError: boolean): void {
    if (name === 'save_case' && !isError) this.mode = 'assist';
  }

  userBash() {
    if (this.mode === 'case') {
      return { result: { output: blockedReason, exitCode: 1, cancelled: false, truncated: false } };
    }
  }
}

export function createWorkModeExtension(): InlineExtension {
  return {
    name: 'maat-work-mode',
    hidden: true,
    factory: (pi) => {
      const policy = new WorkModePolicy();
      const show = (ctx: ExtensionContext) => {
        if (ctx.mode === 'tui')
          ctx.ui.setStatus(
            'maat-mode',
            `Mode: ${policy.mode} · shell/edit ${policy.mode === 'assist' ? 'enabled' : 'disabled'}`,
          );
      };
      const persist = (previous: WorkMode, ctx: ExtensionContext) => {
        if (previous !== policy.mode) pi.appendEntry(entryType, { mode: policy.mode });
        show(ctx);
      };
      const restore = (ctx: ExtensionContext) => {
        policy.mode = 'assist';
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type === 'custom' && entry.customType === entryType) {
            const data = entry.data as { mode?: unknown } | undefined;
            if (data?.mode === 'assist' || data?.mode === 'case') policy.mode = data.mode;
          }
        }
        show(ctx);
      };
      pi.on('session_start', (_event, ctx) => restore(ctx));
      pi.on('session_tree', (_event, ctx) => restore(ctx));
      pi.on('tool_call', (event, ctx) => {
        const previous = policy.mode;
        const reason = policy.beforeTool(event.toolName);
        persist(previous, ctx);
        if (reason) return { block: true, reason };
      });
      pi.on('tool_result', (event, ctx) => {
        const previous = policy.mode;
        policy.afterTool(event.toolName, event.isError);
        persist(previous, ctx);
      });
      pi.on('user_bash', () => policy.userBash());
      pi.on('before_agent_start', (event) => ({
        systemPrompt: `${event.systemPrompt}\nCurrent Maat work mode: ${policy.mode}.`,
      }));
      pi.registerCommand('mode', {
        description: 'Switch workflow: /mode assist or /mode case (keeps Case draft)',
        handler: async (args, ctx) => {
          if (!ctx.isIdle()) {
            ctx.ui.notify('Stop the current run before changing mode.', 'warning');
            return;
          }
          const mode = args.trim();
          if (mode !== 'assist' && mode !== 'case') {
            ctx.ui.notify(`Current mode: ${policy.mode}. Use /mode assist or /mode case.`, 'info');
            return;
          }
          const previous = policy.mode;
          policy.mode = mode;
          persist(previous, ctx);
          pi.sendMessage(
            {
              customType: entryType,
              content: `User selected ${mode} mode. Existing Case draft is retained.`,
              display: true,
            },
            { triggerTurn: false },
          );
        },
      });
      pi.registerTool({
        name: 'set_work_mode',
        label: 'Set Work Mode',
        description:
          'Enter case mode before exploration/generation. Returning to assist for troubleshooting requires user confirmation; retains the draft. Successful save_case automatically returns to assist.',
        parameters: Type.Object({
          mode: Type.Union([Type.Literal('assist'), Type.Literal('case')]),
        }),
        execute: async (_id, params, _signal, _update, ctx) => {
          if (params.mode === 'assist' && policy.mode === 'case') {
            if (
              ctx.mode !== 'tui' ||
              !(await ctx.ui.confirm(
                'Switch to assistance?',
                'Pause Case exploration and allow shell/file edits? The Case draft will be retained.',
              ))
            ) {
              throw new Error(
                'Remain in case mode. User approval is required to enable shell/file edits.',
              );
            }
          }
          const previous = policy.mode;
          policy.mode = params.mode;
          persist(previous, ctx);
          return {
            content: [{ type: 'text', text: `Work mode: ${policy.mode}` }],
            details: { mode: policy.mode },
          };
        },
      });
    },
  };
}
