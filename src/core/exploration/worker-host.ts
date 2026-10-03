import { formatWithOptions } from 'node:util';
import vm from 'node:vm';
import ts from 'typescript';
import { maxCodeBytes, maxOutputBytes, type JavaScriptObservation } from '../../worker/protocol.ts';
import type { ExplorationRuntime, ExplorationRuntimeModule } from './runtime.ts';

let runtime: ExplorationRuntime | undefined;
let busy = false;
process.on('disconnect', () => void close());

async function close() { try { await runtime?.close(); } finally { process.exit(0); } }

process.on('message', async (message: { id: number; operation: string; module?: string; options?: unknown; code?: string }) => {
  if (busy) { process.send?.({ id: message.id, error: 'Exploration Worker is busy.' }); return; }
  busy = true;
  try {
    if (message.operation === 'initialize') {
      const factory = await import(message.module!) as ExplorationRuntimeModule;
      runtime = await factory.createRuntime(message.options);
      process.send?.({ id: message.id, result: [] });
    } else if (message.operation === 'close') {
      process.send?.({ id: message.id, result: [] });
      await close();
    } else {
      if (!runtime || typeof message.code !== 'string' || !message.code.trim() || Buffer.byteLength(message.code) > maxCodeBytes) throw new Error('Invalid exploration code or uninitialized Runtime.');
      const output: JavaScriptObservation[] = []; let bytes = 2;
      const append = (item: JavaScriptObservation) => { bytes += Buffer.byteLength(JSON.stringify(item)); if (bytes > maxOutputBytes) throw new Error('Exploration output exceeds 12 MiB.'); output.push(item); };
      const display = (value: string | Uint8Array) => append({ type: 'image', mimeType: 'image/png', data: typeof value === 'string' ? value.replace(/^data:image\/[^;]+;base64,/, '') : Buffer.from(value).toString('base64') });
      const evidence = { screenshot: async () => { const shot = await runtime!.screenshot(); append({ type: 'image', data: shot.data, mimeType: shot.mimeType }); } };
      const context = vm.createContext({ ...runtime.bindings(), Buffer, display, evidence, console: { log: (...values: unknown[]) => append({ type: 'text', text: formatWithOptions({ getters: false, maxStringLength: 2_000 }, ...values) }) } });
      const source = ts.transpileModule(`(async () => {\n${message.code}\n})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
      const value = await new vm.Script(source, { filename: 'maat-exploration.ts' }).runInContext(context);
      if (!output.length) append({ type: 'text', text: value === undefined ? 'exe_js completed with no output.' : formatWithOptions({ maxStringLength: 2_000 }, value) });
      process.send?.({ id: message.id, result: output });
    }
  } catch (error) { process.send?.({ id: message.id, error: error instanceof Error ? error.message : String(error) }); } finally { busy = false; }
});
