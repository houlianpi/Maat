#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';

import { CodexMaatRuntime, type CodexMaatRuntimeOptions } from './runtime.ts';
import { registerDashboard } from './dashboard.ts';
import { registerCaseTools } from './tools/case-tools.ts';
import { registerExplorationTools } from './tools/exploration-tools.ts';
import { registerPlatformTools } from './tools/platform-tools.ts';
import { registerSetupTools } from './tools/setup-tools.ts';
import { registerTestTools } from './tools/test-tools.ts';

export function createMaatCodexServer(options: CodexMaatRuntimeOptions = {}) {
  const runtime = new CodexMaatRuntime(options);
  const server = new McpServer(
    { name: 'maat', version: '0.3.1' },
    {
      instructions:
        'Maat builds executable UI tests. Select a platform, inspect its execution context, begin a Case, explore with maat_execute_javascript, record only minimal reusable business steps, then validate with maat_save_case. Only assert explicit user objectives.',
    },
  );
  registerPlatformTools(server, runtime);
  registerSetupTools(server, runtime);
  registerExplorationTools(server, runtime);
  registerCaseTools(server, runtime);
  registerTestTools(server, runtime);
  registerDashboard(server, runtime);
  return { server, runtime };
}

export async function runMaatCodexServer(options: CodexMaatRuntimeOptions = {}): Promise<void> {
  const configuredRoot = options.workspaceRoot ?? process.env.MAAT_WORKSPACE_ROOT;
  if (configuredRoot) process.chdir(configuredRoot);
  const { server, runtime } = createMaatCodexServer(options);
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await runtime.close();
      } finally {
        await server.close();
      }
    })());
  process.once('SIGINT', () => void close().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void close().finally(() => process.exit(0)));
  process.once('beforeExit', () => void runtime.close());
  await server.connect(
    new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 }),
  );
  if (!options.workspaceRoot && !process.env.MAAT_WORKSPACE_ROOT) {
    if (!server.server.getClientCapabilities()?.roots) {
      throw new Error(
        'Codex did not provide a workspace root. Set MAAT_WORKSPACE_ROOT for the Maat Tool Server.',
      );
    }
    const roots = await server.server.listRoots();
    const localRoots = roots.roots
      .filter((root) => root.uri.startsWith('file:'))
      .map((root) => fileURLToPath(root.uri));
    if (localRoots.length !== 1) {
      throw new Error(
        `Maat requires exactly one local Codex workspace root; received ${localRoots.length}. Set MAAT_WORKSPACE_ROOT explicitly.`,
      );
    }
    process.chdir(localRoots[0]!);
    await runtime.relocate(localRoots[0]!);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMaatCodexServer().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
