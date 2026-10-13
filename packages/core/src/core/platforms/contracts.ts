import {
  isRecord,
  maxOutputBytes,
  parseObservations,
  type JavaScriptObservation,
} from '../exploration/protocol.ts';
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

/** Validates and filters the single readiness proof format; it carries no recovery capability. */
export function validateReadinessObservations(
  raw: unknown,
  label: string,
  screenshot: boolean,
): JavaScriptObservation[] {
  if (Array.isArray(raw) && Buffer.byteLength(JSON.stringify(raw)) > maxOutputBytes)
    throw new Error('READINESS_OUTPUT_LIMIT: readiness observations exceed 12 MiB.');
  const observations = parseObservations(raw);
  const proof = observations.find((observation) => {
    if (observation.type !== 'text') return false;
    try {
      const value: unknown = JSON.parse(observation.text);
      return (
        isRecord(value) &&
        value.maatSetupReadiness === 1 &&
        value.phoneUnlocked === true &&
        value.sessionUsable === true &&
        value.sourceReadable === true &&
        value.viewportReadable === true &&
        typeof value.source === 'string' &&
        Boolean(value.source.trim()) &&
        isRecord(value.viewport) &&
        typeof value.viewport.width === 'number' &&
        Number.isFinite(value.viewport.width) &&
        value.viewport.width > 0 &&
        typeof value.viewport.height === 'number' &&
        Number.isFinite(value.viewport.height) &&
        value.viewport.height > 0
      );
    } catch {
      return false;
    }
  });
  if (!proof)
    throw new Error(
      `READINESS_PROOF_INVALID: ${label} setup readiness did not return phoneUnlocked:true, nonempty source and valid viewport observation.`,
    );
  const images = observations.filter((observation) => observation.type === 'image');
  if (screenshot && images.length === 0)
    throw new Error(
      `READINESS_SCREENSHOT_FAILED: ${label} setup readiness did not return a screenshot observation.`,
    );
  return [proof, ...images];
}

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
    options?: {
      allowWdaInitialization?: boolean;
      allowWdaInstallation?: boolean;
      screenshot?: boolean;
    },
  ): Promise<JavaScriptObservation[]>;
  status(): PlatformStatus;
  close(): Promise<void>;
}
