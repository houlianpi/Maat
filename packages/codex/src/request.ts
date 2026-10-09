import type { CodexMaatRuntime } from './runtime.ts';

export type MaatRequestExtra = { _meta?: unknown; signal: AbortSignal };

export async function bindMaatRequest(
  runtime: CodexMaatRuntime,
  extra: MaatRequestExtra,
): Promise<void> {
  await runtime.bindRequest(extra._meta);
}
