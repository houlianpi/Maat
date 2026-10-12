import type { JavaScriptObservation } from '../exploration/protocol.ts';
import type { TargetSelectionInput, TargetSelectionResult } from '../../mobile/contracts/device.ts';

export type PlatformStatus = {
  id: string;
  label: string;
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
  clearAppTarget?: boolean;
  allowDataReset?: boolean;
};
export type SetupInspection = { kind: 'devices' | 'applications'; query?: string };

/** The only platform lifecycle Maat Core depends on. */
export interface PlatformAdapter {
  readonly id: string;
  readonly label: string;
  readonly codeContext: CodeContext;
  initialize(): Promise<void>;
  configure?(configuration: Record<string, unknown>): Promise<unknown>;
  configureSession?(setup: SessionSetup): Promise<void>;
  inspectSetup?(request: SetupInspection): Promise<unknown>;
  selectReadinessTarget?(
    selection?: TargetSelectionInput,
    signal?: AbortSignal,
  ): Promise<TargetSelectionResult | undefined>;
  execute(code: string, signal?: AbortSignal): Promise<JavaScriptObservation[]>;
  /** Phone readiness: first-installation permission is transient, never an unlocked proof. */
  executeReadiness?(
    code: string,
    signal?: AbortSignal,
    options?: { allowWdaInitialization?: boolean; allowWdaInstallation?: boolean },
  ): Promise<JavaScriptObservation[]>;
  status(): PlatformStatus;
  close(): Promise<void>;
}
