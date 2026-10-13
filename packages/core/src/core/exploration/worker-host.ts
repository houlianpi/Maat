import { formatWithOptions } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import vm from 'node:vm';
import ts from 'typescript';
import {
  AppiumProtocol,
  ChromiumProtocol,
  GeckoProtocol,
  MJsonWProtocol,
  SauceLabsProtocol,
  SeleniumProtocol,
  WebDriverProtocol,
} from '@wdio/protocols';
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
const trustedTransportFailures = new WeakSet<object>();
type ProtocolCommandContext = {
  requestSeen: boolean;
  invalidSessionResponse: boolean;
};
const protocolCommandContext = new AsyncLocalStorage<ProtocolCommandContext>();
const protocolCommandNames = new Set(
  [
    AppiumProtocol,
    ChromiumProtocol,
    GeckoProtocol,
    MJsonWProtocol,
    SauceLabsProtocol,
    SeleniumProtocol,
    WebDriverProtocol,
  ].flatMap((protocol) =>
    Object.values(protocol).flatMap((methods) =>
      Object.values(methods).flatMap((definition) =>
        isRecord(definition) && typeof definition.command === 'string' ? [definition.command] : [],
      ),
    ),
  ),
);
process.on('disconnect', () => void close());

async function close() {
  try {
    await runtime?.close();
  } finally {
    process.exit(0);
  }
}

const invalidSessionFacts = [
  'invalid session id',
  'invalidsessioniderror',
  'nosuchsessionerror',
  'no such session',
  'no_such_session',
] as const;

function safeProperty(value: unknown, key: PropertyKey): unknown {
  if (!isRecord(value)) return;
  try {
    return Reflect.get(value, key);
  } catch {
    return;
  }
}

function structuredInvalidSession(value: unknown, depth = 0): boolean {
  if (depth > 3 || !isRecord(value)) return false;
  const exactInvalidFact = (fact: unknown) =>
    typeof fact === 'string' &&
    invalidSessionFacts.some((candidate) => candidate === fact.trim().toLowerCase());
  if (
    exactInvalidFact(safeProperty(value, 'name')) ||
    exactInvalidFact(safeProperty(value, 'code'))
  )
    return true;
  const data = safeProperty(value, 'data');
  if (isRecord(data) && exactInvalidFact(safeProperty(data, 'error'))) return true;
  return structuredInvalidSession(safeProperty(value, 'cause'), depth + 1);
}

function webdriverProtocolOptions(options: unknown): unknown {
  if (!isRecord(options)) return options;
  return {
    ...options,
    transformRequest: (request: unknown) => {
      const context = protocolCommandContext.getStore();
      if (context) context.requestSeen = true;
      return request;
    },
    transformResponse: (response: unknown) => {
      const context = protocolCommandContext.getStore();
      if (context && context.requestSeen && isRecord(response)) {
        const body = response.body;
        const value = isRecord(body) ? body.value : undefined;
        if (isRecord(value) && value.error === 'invalid session id')
          context.invalidSessionResponse = true;
      }
      return response;
    },
  };
}

function trustedDriverBindings(bindings: Record<string, unknown>): Record<string, unknown> {
  const driver = bindings.driver;
  if ((!isRecord(driver) && typeof driver !== 'function') || driver === null) return bindings;
  const proxies = new WeakMap<object, object>();
  const blockedProperties = new Set<PropertyKey>([
    'addCommand',
    'overwriteCommand',
    '__propertiesObject__',
  ]);
  const protect = (value: unknown, command?: ProtocolCommandContext): unknown => {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
    const target = value as object;
    const existing = proxies.get(target);
    if (existing) return existing;
    const mark = (error: unknown) => {
      if (
        command?.requestSeen &&
        command.invalidSessionResponse &&
        (isRecord(error) || typeof error === 'function')
      )
        trustedTransportFailures.add(error as object);
      return error;
    };
    const facade = Array.isArray(value) ? [] : Object.create(null);
    const proxy = new Proxy(facade, {
      get(_current, key) {
        if (blockedProperties.has(key)) return;
        const member = Reflect.get(target, key, target);
        if (typeof member !== 'function') return protect(member, command);
        if (key === 'then')
          return (
            fulfilled?: (result: unknown) => unknown,
            rejected?: (error: unknown) => unknown,
          ) =>
            protocolCommandContext.run(
              command ?? { requestSeen: false, invalidSessionResponse: false },
              () =>
                Reflect.apply(member, target, [
                  fulfilled ? (result: unknown) => fulfilled(protect(result, command)) : fulfilled,
                  rejected ? (error: unknown) => rejected(mark(error)) : rejected,
                ]),
            );
        if (key === 'catch')
          return (rejected?: (error: unknown) => unknown) =>
            protocolCommandContext.run(
              command ?? { requestSeen: false, invalidSessionResponse: false },
              () =>
                Reflect.apply(member, target, [
                  rejected ? (error: unknown) => rejected(mark(error)) : rejected,
                ]),
            );
        if (typeof key !== 'string' || !protocolCommandNames.has(key))
          return (...args: unknown[]) => protect(Reflect.apply(member, target, args));
        return (...args: unknown[]) => {
          const next = { requestSeen: false, invalidSessionResponse: false };
          return protocolCommandContext.run(next, () =>
            protect(Reflect.apply(member, target, args), next),
          );
        };
      },
      has: (_current, key) => !blockedProperties.has(key) && Reflect.has(target, key),
      ownKeys: (current) => [
        ...new Set([
          ...Reflect.ownKeys(current),
          ...Reflect.ownKeys(target).filter((key) => !blockedProperties.has(key)),
        ]),
      ],
      getOwnPropertyDescriptor(current, key) {
        const local = Reflect.getOwnPropertyDescriptor(current, key);
        if (local && !local.configurable) return local;
        if (blockedProperties.has(key)) return;
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (!descriptor) return;
        return {
          configurable: true,
          enumerable: descriptor.enumerable,
          ...(Object.hasOwn(descriptor, 'value')
            ? { value: protect(descriptor.value, command), writable: false }
            : {
                get: descriptor.get
                  ? () => protect(Reflect.apply(descriptor.get!, target, []), command)
                  : undefined,
                set: undefined,
              }),
        };
      },
      getPrototypeOf: () =>
        target instanceof Promise
          ? Promise.prototype
          : (protect(Reflect.getPrototypeOf(target), command) as object | null),
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
      setPrototypeOf: () => false,
    });
    proxies.set(target, proxy);
    return proxy;
  };
  const protectedDriver = protect(driver);
  return {
    ...bindings,
    driver: protectedDriver,
    ...(bindings.browser === driver ? { browser: protectedDriver } : {}),
  };
}

function executionError(error: unknown, phase: WorkerError['phase']): WorkerError {
  let name =
    error instanceof Error
      ? error.name
      : typeof safeProperty(error, 'name') === 'string'
        ? (safeProperty(error, 'name') as string)
        : 'Error';
  const trustedInvalidSession =
    phase === 'execute' && isRecord(error) && trustedTransportFailures.has(error);
  if (trustedInvalidSession) name = 'InvalidSessionError';
  else if (
    phase === 'execute' &&
    (name === 'InvalidSessionError' || structuredInvalidSession(error))
  )
    name = 'Error';
  const message = (
    error instanceof Error
      ? error.message
      : typeof safeProperty(error, 'message') === 'string'
        ? (safeProperty(error, 'message') as string)
        : (() => {
            try {
              return String(error);
            } catch {
              return 'Model code threw an unreadable value.';
            }
          })()
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
        runtime = await factory.createRuntime(
          message.module?.includes('/platforms/appium/')
            ? webdriverProtocolOptions(message.options)
            : message.options,
        );
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
          if (bytes > maxOutputBytes)
            throw new Error('READINESS_OUTPUT_LIMIT: exploration output exceeds 12 MiB.');
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
            const command = { requestSeen: false, invalidSessionResponse: false };
            let shot;
            try {
              shot = await protocolCommandContext.run(command, () => runtime!.screenshot());
            } catch (error) {
              if (
                command.requestSeen &&
                command.invalidSessionResponse &&
                (isRecord(error) || typeof error === 'function')
              )
                trustedTransportFailures.add(error as object);
              throw error;
            }
            append({ type: 'image', data: shot.data, mimeType: shot.mimeType });
          },
        };
        const context = vm.createContext({
          ...trustedDriverBindings(runtime.bindings()),
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
