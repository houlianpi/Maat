import { formatWithOptions } from 'node:util';
import vm from 'node:vm';
import ts from 'typescript';
import {
  imageMimeType,
  isCanonicalBase64,
  isRecord,
  maxCodeBytes,
  maxOutputBytes,
  type JavaScriptObservation,
  type WorkerError,
} from './protocol.ts';
import type { ExplorationRuntime, ExplorationRuntimeModule } from './runtime.ts';

let runtime: ExplorationRuntime | undefined;
let busy = false;
process.on('disconnect', () => void close());

async function close() {
  try {
    await runtime?.close();
  } finally {
    process.exit(0);
  }
}

function executionError(error: unknown, phase: WorkerError['phase']): WorkerError {
  const name =
    error instanceof Error
      ? error.name
      : isRecord(error) && typeof error.name === 'string'
        ? error.name
        : 'Error';
  const message = (
    error instanceof Error
      ? error.message
      : isRecord(error) && typeof error.message === 'string'
        ? error.message
        : String(error)
  ).slice(0, 8_000);
  const category: WorkerError['category'] =
    phase === 'validate'
      ? 'invalid-input'
      : phase === 'compile' || name === 'SyntaxError'
        ? 'syntax-error'
        : name === 'ReferenceError'
          ? 'reference-error'
          : name === 'TypeError'
            ? 'type-error'
            : /expect\(|assert|expected|received/i.test(message)
              ? 'assertion-error'
              : /output exceeds/i.test(message)
                ? 'output-limit'
                : 'runtime-error';
  return {
    name,
    message,
    category,
    phase,
    actionState: phase === 'validate' || phase === 'compile' ? 'not-started' : 'uncertain',
  };
}

process.on(
  'message',
  async (message: {
    id: number;
    operation: string;
    module?: string;
    options?: unknown;
    code?: string;
  }) => {
    if (busy) {
      process.send?.({
        id: message.id,
        error: executionError(new Error('Exploration Worker is busy.'), 'validate'),
      });
      return;
    }
    busy = true;
    let phase: WorkerError['phase'] = 'validate';
    try {
      if (message.operation === 'initialize') {
        const factory = (await import(message.module!)) as ExplorationRuntimeModule;
        runtime = await factory.createRuntime(message.options);
        process.send?.({ id: message.id, result: [] });
      } else if (message.operation === 'close') {
        process.send?.({ id: message.id, result: [] });
        await close();
      } else {
        if (
          !runtime ||
          typeof message.code !== 'string' ||
          !message.code.trim() ||
          Buffer.byteLength(message.code) > maxCodeBytes
        )
          throw new Error('Invalid exploration code or uninitialized Runtime.');
        const output: JavaScriptObservation[] = [];
        let bytes = 2;
        const append = (item: JavaScriptObservation) => {
          bytes += Buffer.byteLength(JSON.stringify(item));
          if (bytes > maxOutputBytes) throw new Error('Exploration output exceeds 12 MiB.');
          output.push(item);
        };
        const display = (value: string | Uint8Array) => {
          if (typeof value === 'string') {
            const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
              value,
            );
            const data = match?.[2] ?? value;
            if ((!match && !isCanonicalBase64(value)) || !data) {
              throw new Error(
                'display() accepts image bytes, base64 screenshot data, or a PNG/JPEG/WebP base64 data URL. Use console.log() for text.',
              );
            }
            const mimeType = imageMimeType(data);
            if (match?.[1] && mimeType !== match[1])
              throw new Error('Image data URL MIME type does not match its payload.');
            append({ type: 'image', mimeType, data });
            return;
          }
          const data = Buffer.from(value).toString('base64');
          append({
            type: 'image',
            mimeType: imageMimeType(value),
            data,
          });
        };
        // In-memory screenshot observations only; this global does not persist Evidence records.
        const evidence = {
          screenshot: async () => {
            const shot = await runtime!.screenshot();
            append({ type: 'image', data: shot.data, mimeType: shot.mimeType });
          },
        };
        const context = vm.createContext({
          ...runtime.bindings(),
          Buffer,
          display,
          evidence,
          console: {
            log: (...values: unknown[]) =>
              append({
                type: 'text',
                text: formatWithOptions({ getters: false, maxStringLength: 2_000 }, ...values),
              }),
          },
        });
        phase = 'compile';
        const transpiled = ts.transpileModule(`(async () => {\n${message.code}\n})()`, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
          reportDiagnostics: true,
        });
        const diagnostics = (transpiled.diagnostics ?? []).filter(
          (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
        );
        if (diagnostics.length)
          throw new SyntaxError(
            diagnostics
              .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
              .join('; ')
              .slice(0, 8_000),
          );
        const script = new vm.Script(transpiled.outputText, {
          filename: 'maat-exploration.ts',
        });
        phase = 'execute';
        const value = await script.runInContext(context);
        if (!output.length)
          append({
            type: 'text',
            text:
              value === undefined
                ? 'exe_js completed with no output.'
                : formatWithOptions({ maxStringLength: 2_000 }, value),
          });
        process.send?.({ id: message.id, result: output });
      }
    } catch (error) {
      process.send?.({
        id: message.id,
        error: executionError(error, phase),
      });
    } finally {
      busy = false;
    }
  },
);
