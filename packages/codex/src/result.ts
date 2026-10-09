import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function jsonResult(value: unknown, summary?: string): CallToolResult {
  const structuredContent =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  return {
    structuredContent,
    content: [
      {
        type: 'text',
        text: summary ?? JSON.stringify(value, null, 2),
      },
    ],
  };
}

export function textResult(text: string, details: Record<string, unknown> = {}): CallToolResult {
  return { structuredContent: details, content: [{ type: 'text', text }] };
}
