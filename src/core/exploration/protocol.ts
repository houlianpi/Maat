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

export function isCanonicalBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

export function imageMimeType(
  data: string | Uint8Array,
): 'image/png' | 'image/jpeg' | 'image/webp' {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.from(data);
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  throw new Error('Image data must contain a valid PNG, JPEG, or WebP payload.');
}

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
      isCanonicalBase64(item.data) &&
      typeof item.mimeType === 'string' &&
      /^image\/(?:png|jpeg|webp)$/.test(item.mimeType)
    ) {
      if (imageMimeType(item.data) !== item.mimeType)
        throw new Error('Worker returned image data that does not match its MIME type.');
      return { type: 'image', data: item.data, mimeType: item.mimeType };
    }
    throw new Error('Worker returned an unsupported observation.');
  });
}
