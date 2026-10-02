import { execFile, fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { chromium, type BrowserServer } from "playwright";

import {
  isRecord,
  maxCodeBytes,
  maxOutputBytes,
  parseObservations,
  type JavaScriptObservation,
  type WorkerOperation,
  type WorkerRequest,
} from "./protocol.ts";

export type JavaScriptSession = {
  execute(code: string, signal?: AbortSignal): Promise<JavaScriptObservation[]>;
  close(): Promise<void>;
};

export type JavaScriptSessionOptions = {
  assertionTimeoutMs?: number;
  channel?: string;
  executablePath?: string;
  headless?: boolean;
  initializationTimeoutMs?: number;
  profileDirectory?: string;
  userDataDir?: string;
  executionTimeoutMs?: number;
};

type PendingRequest = {
  id: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

const execFileAsync = promisify(execFile);

async function cleanupPersistentBrowserProcesses(
  userDataDir: string,
): Promise<void> {
  if (process.platform === "win32") return;

  const { stdout } = await execFileAsync("ps", [
    "-axo",
    "pid=,pgid=,command=",
  ]).catch(() => ({ stdout: "" }));
  const processGroups = new Set<number>();

  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const command = match[3];
    if (
      command.includes(`--user-data-dir=${userDataDir}`) &&
      command.includes("--enable-automation") &&
      command.includes("--remote-debugging-pipe") &&
      !command.includes(" Helper")
    ) {
      processGroups.add(Number(match[2]));
    }
  }

  for (const group of processGroups) {
    try {
      process.kill(-group, "SIGTERM");
    } catch {
      // The process may have exited while it was being inspected.
    }
  }
  if (processGroups.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  for (const group of processGroups) {
    try {
      process.kill(-group, 0);
      process.kill(-group, "SIGKILL");
    } catch {
      // The graceful shutdown succeeded.
    }
  }
}

function workerEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(name),
    ),
  );
}

export async function launchJavaScriptSession(
  options: JavaScriptSessionOptions = {},
): Promise<JavaScriptSession> {
  const browserServer = options.userDataDir
    ? undefined
    : await chromium.launchServer({
        channel: options.channel,
        executablePath: options.executablePath,
        headless: options.headless ?? true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
  const workerPath = fileURLToPath(new URL("./javascript-worker.ts", import.meta.url));
  let child: ChildProcess;

  try {
    child = fork(workerPath, [], {
      execArgv: ["--experimental-strip-types"],
      detached: options.userDataDir !== undefined,
      env: workerEnvironment(),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
  } catch (error) {
    await browserServer?.kill();
    throw error;
  }

  let sequence = 0;
  let pending: PendingRequest | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let terminalError: Error | undefined;
  let stderr = "";

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4_000);
  });

  function close(
    reason = new Error("JavaScript session closed."),
    force = false,
  ): Promise<void> {
    if (closing) return closing;
    closed = true;
    terminalError = reason;
    const request = pending;
    pending = undefined;
    request?.reject(reason);

    closing = (async () => {
      if (!force && child.connected) {
        child.send({ id: -1, operation: "close" } satisfies WorkerRequest);
        await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 300)),
        ]);
      }
      if (child.exitCode === null && child.signalCode === null) {
        if (options.userDataDir && child.pid && process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else {
          child.kill("SIGKILL");
        }
      }

      if (browserServer) {
        try {
          await Promise.race([
            force ? browserServer.kill() : browserServer.close(),
            new Promise<never>((_resolve, reject) =>
              setTimeout(() => reject(new Error("Browser close timed out.")), 1_000),
            ),
          ]);
        } catch {
          await browserServer.kill().catch(() => undefined);
        }
      }
      if (force && options.userDataDir) {
        await cleanupPersistentBrowserProcesses(options.userDataDir);
      }
      await exited;
      child.stderr?.destroy();
    })();
    return closing;
  }

  child.on("error", (error) => {
    void close(new Error(`JavaScript worker failed: ${error.message}`), true);
  });
  child.on("exit", () => {
    if (!closed) {
      void close(
        new Error(`JavaScript worker exited unexpectedly. ${stderr}`.trim()),
        true,
      );
    }
  });
  child.on("message", (message: unknown) => {
    if (closed) return;
    if (
      !isRecord(message) ||
      !pending ||
      message.id !== pending.id ||
      Buffer.byteLength(JSON.stringify(message)) > maxOutputBytes
    ) {
      void close(new Error("JavaScript worker returned an invalid response."), true);
      return;
    }

    const request = pending;
    pending = undefined;
    if (typeof message.error === "string") request.reject(new Error(message.error));
    else if ("result" in message) request.resolve(message.result);
    else {
      request.reject(new Error("JavaScript worker response has no result."));
      void close(new Error("JavaScript worker protocol error."), true);
    }
  });

  async function request<T>(
    operation: WorkerOperation,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
    timeoutMs = options.executionTimeoutMs ?? 60_000,
    timeoutLabel = "JavaScript execution",
  ): Promise<T> {
    if (closed) throw terminalError ?? new Error("JavaScript session closed.");
    if (pending) throw new Error("A JavaScript operation is already running.");
    signal?.throwIfAborted();

    const id = ++sequence;
    return await new Promise<T>((resolve, reject) => {
      const fail = (error: Error) => {
        void close(error, true);
      };
      const timer = setTimeout(
        () => fail(new Error(`${timeoutLabel} exceeded ${timeoutMs}ms.`)),
        timeoutMs,
      );
      const onAbort = () => fail(new Error("JavaScript execution aborted."));
      signal?.addEventListener("abort", onAbort, { once: true });

      pending = {
        id,
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          try {
            resolve(parse(value));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      child.send({ id, ...operation }, (error) => {
        if (error) fail(new Error(`Could not reach JavaScript worker: ${error.message}`));
      });
    });
  }

  try {
    const assertionTimeoutMs = options.assertionTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(assertionTimeoutMs) || assertionTimeoutMs <= 0) {
      throw new Error("assertionTimeoutMs must be a positive integer.");
    }
    await request(
      {
        operation: "initialize",
        assertionTimeoutMs,
        browser: options.userDataDir
          ? {
              mode: "persistent",
              userDataDir: options.userDataDir,
              channel: options.channel,
              executablePath: options.executablePath,
              headless: options.headless ?? true,
              profileDirectory: options.profileDirectory,
            }
          : { mode: "connect", endpoint: browserServer!.wsEndpoint() },
      },
      () => undefined,
      undefined,
      options.initializationTimeoutMs ?? (options.userDataDir ? 60_000 : 15_000),
      "Browser initialization",
    );
  } catch (error) {
    await close(error instanceof Error ? error : new Error(String(error)), true);
    throw error;
  }

  return {
    execute(code, signal) {
      if (!code.trim() || Buffer.byteLength(code) > maxCodeBytes) {
        return Promise.reject(
          new Error("JavaScript code must be nonempty and at most 64 KiB."),
        );
      }
      return request({ operation: "execute", code }, parseObservations, signal);
    },
    close: () => close(),
  };
}
