export type JavaScriptObservation =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type WorkerOperation =
  | {
      operation: 'initialize';
      assertionTimeoutMs: number;
      browser:
        | { mode: 'connect'; endpoint: string }
        | {
            mode: 'persistent';
            userDataDir: string;
            channel?: string;
            executablePath?: string;
            headless: boolean;
            profileDirectory?: string;
          };
    }
  | { operation: 'execute'; code: string }
  | { operation: 'close' };

export type WorkerRequest = WorkerOperation & { id: number };

export type WorkerResponse = { id: number; result: unknown } | { id: number; error: string };

export const maxCodeBytes = 64 * 1024;
export const maxOutputBytes = 12 * 1024 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseObservations(value: unknown): JavaScriptObservation[] {
  if (!Array.isArray(value)) {
    throw new Error('Worker returned invalid observations.');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > maxOutputBytes) {
    throw new Error('Worker output exceeds 12 MiB.');
  }

  return value.map((item) => {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
      return { type: 'text', text: item.text };
    }
    if (
      isRecord(item) &&
      item.type === 'image' &&
      typeof item.data === 'string' &&
      typeof item.mimeType === 'string' &&
      /^image\/(?:png|jpeg|webp)$/.test(item.mimeType)
    ) {
      return { type: 'image', data: item.data, mimeType: item.mimeType };
    }
    throw new Error('Worker returned an unsupported observation.');
  });
}
