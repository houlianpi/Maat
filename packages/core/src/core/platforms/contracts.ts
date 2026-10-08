import type { JavaScriptObservation } from '../exploration/protocol.ts';

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
export type SessionSetup = {
  serverUrl?: string;
  device?: { kind?: string; name?: string };
  capabilities?: Record<string, unknown>;
  allowDataReset?: boolean;
};
export type SetupInspection = { kind: 'devices' | 'applications'; query?: string };
export type RuntimeRequirement = { adapterId: string; setup?: Record<string, unknown> };
export type TestSession = {
  readonly context: Record<string, unknown>;
  setup(): Promise<void>;
  screenshot(): Promise<{ data: string; mimeType: string }>;
  teardown(): Promise<void>;
};

/** The only platform lifecycle Maat Core depends on. */
export interface PlatformAdapter {
  readonly id: string;
  readonly label: string;
  readonly root: string;
  readonly codeContext: CodeContext;
  initialize(): Promise<void>;
  configure?(configuration: Record<string, unknown>): Promise<unknown>;
  configureSession?(setup: SessionSetup): Promise<void>;
  inspectSetup?(request: SetupInspection): Promise<unknown>;
  execute(code: string, signal?: AbortSignal): Promise<JavaScriptObservation[]>;
  runtimeRequirement(): RuntimeRequirement;
  createTestSession(requirement?: RuntimeRequirement): Promise<TestSession>;
  status(): PlatformStatus;
  close(): Promise<void>;
}
