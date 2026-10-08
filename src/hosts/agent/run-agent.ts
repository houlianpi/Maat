import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';

import type { BrowserName } from '../../platforms/web/config.ts';
import { createMaat } from '../../api/create-maat.ts';
import { createAgentTrace } from './trace.ts';
import { createRunRecorder } from './run-recorder.ts';
import { createExecJsTool } from '../../tools/exec-js-tool.ts';

function shortToolCallId(id: string): string {
  return id.split('|', 1)[0].slice(0, 24);
}

export type RunAgentOptions = {
  browser?: BrowserName;
  executablePath?: string;
  headless?: boolean;
  profileDirectory?: string;
  userDataDir?: string;
};

export async function runAgent(prompt: string, options: RunAgentOptions = {}): Promise<void> {
  const trace = createAgentTrace();
  const browser = options.browser ?? 'chrome';
  const recorder = await createRunRecorder(prompt, undefined, { browser });
  const maat = createMaat({ workspaceRoot: process.cwd() });
  let initialized = false;
  let runError: unknown;
  try {
    await maat.platforms.configure({
      browser,
      headless: options.headless ?? false,
      executablePath: options.executablePath,
      profileDirectory: options.profileDirectory,
      userDataDir: options.userDataDir,
    });
    initialized = true;
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      tools: ['exe_js'],
      customTools: [
        createExecJsTool(
          {
            close: () => maat.platforms.current().close(),
            execute: (code, signal) => maat.exploration.executeJavaScript(code, signal),
          },
          recorder,
          {
            description:
              'Execute asynchronous JavaScript against one persistent Playwright page. The globals page, context, browser, expect, console and display are available.',
            guidelines: [
              'Use Playwright locators.',
              'Use display(await page.screenshot()) for visual Evidence.',
            ],
          },
        ),
      ],
      sessionManager: SessionManager.inMemory(),
    });

    let streamedText = false;
    const unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case 'message_update':
          if (event.assistantMessageEvent.type === 'text_delta') {
            streamedText = true;
            process.stdout.write(event.assistantMessageEvent.delta);
          }
          break;
        case 'message_end':
          if (event.message.role === 'assistant') {
            const text = event.message.content
              .filter((item) => item.type === 'text')
              .map((item) => item.text)
              .join('\n');
            if (text) trace.text('LLM -> HOST', 'ASSISTANT MESSAGE', text);
          }
          break;
        case 'tool_execution_start':
          trace.value(
            'LLM -> HOST',
            `TOOL CALL ${event.toolName} (${shortToolCallId(event.toolCallId)})`,
            event.args,
          );
          break;
        case 'tool_execution_end':
          trace.value(
            'HOST -> LLM',
            `TOOL RESULT ${event.toolName} (${shortToolCallId(event.toolCallId)})${
              event.isError ? ' ERROR' : ''
            }`,
            event.result,
          );
          break;
      }
    });

    try {
      trace.text('HOST -> LLM', 'SYSTEM PROMPT', session.systemPrompt);
      trace.value(
        'HOST -> LLM',
        'TOOLS',
        session.getActiveToolNames().map((name) => {
          const tool = session.getToolDefinition(name);
          return tool
            ? {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                promptGuidelines: tool.promptGuidelines,
              }
            : { name };
        }),
      );
      trace.text('HOST -> LLM', 'USER PROMPT', prompt);
      await session.prompt(prompt);

      const lastMessage = session.state.messages.at(-1);
      if (
        lastMessage?.role === 'assistant' &&
        (lastMessage.stopReason === 'error' || lastMessage.stopReason === 'aborted')
      ) {
        throw new Error(lastMessage.errorMessage ?? `Request ${lastMessage.stopReason}`);
      }

      if (!streamedText) {
        process.stdout.write(session.getLastAssistantText() ?? '');
      }
      process.stdout.write('\n');
    } finally {
      unsubscribe();
      session.dispose();
    }
  } catch (error) {
    runError = error;
    if (!initialized) {
      await recorder.recordFailedStep('// Browser failed to launch.', error);
    }
    throw error;
  } finally {
    await maat.close();
    const replayPath = await recorder.finalize(runError ? 'failed' : 'completed', runError);
    process.stderr.write(
      replayPath
        ? `\nReplay: ${replayPath}\n`
        : `\nReplay not generated: run contained a failure. Diagnostics: ${recorder.runDirectory}\n`,
    );
  }
}
