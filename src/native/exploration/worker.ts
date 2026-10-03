import vm from 'node:vm';
import { format } from 'node:util';
import { attach } from 'webdriverio';
import { expect } from 'expect-webdriverio';
import ts from 'typescript';
import { maxCodeBytes, maxOutputBytes, type JavaScriptObservation } from '../../worker/protocol.ts';

let driver: Awaited<ReturnType<typeof attach>>;
let busy = false;
process.on('disconnect', () => process.exit(0));
process.on('message', async (message: { id: number; operation: string; options?: Parameters<typeof attach>[0]; code?: string }) => {
  if (busy) { process.send?.({ id: message.id, error: 'Native worker is busy.' }); return; }
  busy = true;
  try {
    if (message.operation === 'initialize') {
      driver = await attach(message.options!);
      process.send?.({ id: message.id, result: [] });
    } else {
      const code = message.code;
      if (!driver || typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > maxCodeBytes) throw new Error('Invalid native code or uninitialized worker.');
      const output: JavaScriptObservation[] = [];
      let bytes = 2;
      const append = (item: JavaScriptObservation) => {
        bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
        if (bytes > maxOutputBytes) throw new Error('Native output exceeds 12 MiB.');
        output.push(item);
      };
      const display = (data: string) => {
        if (typeof data !== 'string') throw new Error('display expects screenshot base64.');
        append({ type: 'image', mimeType: 'image/png', data });
      };
      const evidence = { screenshot: async (_name?: string) => display(await driver.takeScreenshot()) };
      const sandbox = vm.createContext({ driver, browser: driver, expect, display, evidence, console: { log: (...args: unknown[]) => append({ type: 'text', text: format(...args) }) } });
      // TypeScript is transformed, not typechecked; runtime errors return to the agent.
      const source = ts.transpileModule('(async () => {\n' + code + '\n})()', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
      const value = await new vm.Script(source, { filename: 'native-step.ts' }).runInContext(sandbox);
      if (!output.length) append({ type: 'text', text: value === undefined ? 'Native step completed.' : format(value) });
      process.send?.({ id: message.id, result: output });
    }
  } catch (error) {
    process.send?.({ id: message.id, error: String(error instanceof Error ? error.message : error).slice(0, 8000) });
  } finally { busy = false; }
});
