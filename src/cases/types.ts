import type { BrowserName } from "../browser/browser-options.ts";
import type { JavaScriptObservation } from "../worker/protocol.ts";

export type CaseObjective = {
  id: string;
  description: string;
};

export type CaseStep = {
  number: number;
  code: string;
  observations: JavaScriptObservation[];
};

export type CaseAttemptFailure = {
  code: string;
  error: string;
};

export type CaseEvidence = {
  id: string;
  stepNumber: number;
  type: "text" | "image";
  text?: string;
  mimeType?: string;
  path?: string;
};

export type CaseDraft = {
  id: string;
  name: string;
  description: string;
  preconditions: string[];
  actionSteps: string[];
  objectives: CaseObjective[];
  tags: string[];
  suites: string[];
  rootDirectory: string;
  steps: CaseStep[];
  failures: CaseAttemptFailure[];
  evidence: CaseEvidence[];
};

export type SavedCase = {
  version: 1;
  id: string;
  name: string;
  description: string;
  preconditions: string[];
  actionSteps: string[];
  objectives: CaseObjective[];
  tags: string[];
  suites: string[];
  browser: BrowserName;
  profile?: string;
  code: "test.ts";
  savedAt: string;
};
