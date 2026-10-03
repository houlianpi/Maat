import type { JavaScriptObservation } from '../worker/protocol.ts';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

export type PlatformStatus = {
  id: string;
  label: string;
  root: string;
  session: 'idle' | 'ready';
  detail?: string;
};

export type CodeContext = {
  language: 'javascript';
  globals: Array<{ name: string; description: string }>;
  guidelines: string[];
};
export type SessionSetup = { serverUrl?: string; device?: { kind?: string; name?: string }; capabilities?: Record<string, unknown>; allowDataReset?: boolean };
export type SetupInspection = { kind: 'devices' | 'applications'; query?: string };
export type RuntimeRequirement = { adapterId: string; setup?: Record<string, unknown> };
export type TestSession = {
  readonly context: Record<string, unknown>;
  screenshot(): Promise<{ data: string; mimeType: string }>;
  close(): Promise<void>;
};

/** The only platform lifecycle Maat Core depends on. */
export interface PlatformAdapter {
  readonly id: string;
  readonly label: string;
  readonly root: string;
  readonly codeContext: CodeContext;
  tools?(): ToolDefinition[];

  initialize(): Promise<void>;
  configureSession?(setup: SessionSetup): Promise<void>;
  inspectSetup?(request: SetupInspection): Promise<unknown>;
  execute(code: string, signal?: AbortSignal): Promise<JavaScriptObservation[]>;
  runtimeRequirement(): RuntimeRequirement;
  createTestSession(requirement?: RuntimeRequirement): Promise<TestSession>;
  status(): PlatformStatus;
  close(): Promise<void>;
}
