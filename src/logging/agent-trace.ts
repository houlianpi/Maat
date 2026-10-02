import { inspect } from "node:util";

export type TraceDirection = "HOST -> LLM" | "LLM -> HOST";

export type AgentTrace = {
  text(direction: TraceDirection, label: string, text: string): void;
  value(direction: TraceDirection, label: string, value: unknown): void;
};

export type AgentTraceOptions = {
  enabled?: boolean;
  write?: (text: string) => void;
};

const sensitiveKey = /(?:api[-_]?key|token|secret|password|credential|authorization)/i;

function summarize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map((item) => summarize(item, seen));
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  const record = value as Record<string, unknown>;
  if (
    record.type === "image" &&
    typeof record.data === "string" &&
    typeof record.mimeType === "string"
  ) {
    return {
      type: "image",
      mimeType: record.mimeType,
      base64Characters: record.data.length,
    };
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      sensitiveKey.test(key) ? "[redacted]" : summarize(item, seen),
    ]),
  );
}

export function createAgentTrace(options: AgentTraceOptions = {}): AgentTrace {
  const enabled =
    options.enabled ?? !["0", "false", "off"].includes(
      process.env.MAAT_TRACE?.toLowerCase() ?? "",
    );
  const write = options.write ?? ((text: string) => process.stderr.write(text));

  function section(
    direction: TraceDirection,
    label: string,
    body: string,
  ): void {
    if (!enabled) return;
    write(`\n[TRACE][${direction}][${label}]\n${body}\n`);
  }

  return {
    text: section,
    value(direction, label, value) {
      section(
        direction,
        label,
        inspect(summarize(value), {
          breakLength: 100,
          colors: false,
          compact: false,
          depth: 10,
          maxArrayLength: 100,
          maxStringLength: 32_000,
        }),
      );
    },
  };
}
