import type { JavaScriptObservation } from '../worker/protocol.ts';
import type { RuntimeRequirement } from '../platforms/contracts.ts';

export type CaseObjective = {
  id: string;
  description: string;
};

export type CaseStep = {
  number: number;
  adapterId?: string;
  bindings?: string[];
  code: string;
  observations: JavaScriptObservation[];
};

export type CaseAttemptFailure = {
  adapterId?: string;
  code: string;
  error: string;
};

export type CaseEvidence = {
  id: string;
  stepNumber: number;
  type: 'text' | 'image';
  text?: string;
  mimeType?: string;
  path?: string;
};

export type CaseDraft = {
  id: string;
  module?: string;
  name: string;
  description: string;
  preconditions: string[];
  actionSteps: string[];
  objectives: CaseObjective[];
  tags: string[];
  suites: string[];
  rootDirectory: string;
  requirements?: RuntimeRequirement[];
  steps: CaseStep[];
  failures: CaseAttemptFailure[];
  evidence: CaseEvidence[];
};
