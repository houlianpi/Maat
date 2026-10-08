import type { RuntimeRequirement } from '../platforms/contracts.ts';
import type { JavaScriptObservation } from '../exploration/protocol.ts';

export type StepExecution = {
  adapterId: string;
  bindings: string[];
  requirement: RuntimeRequirement;
};

export type StepRecorder = {
  recordSuccessfulStep(
    code: string,
    observations: JavaScriptObservation[],
    execution?: StepExecution,
    name?: string,
  ): Promise<void>;
  recordFailedStep(code: string, error: unknown, execution?: StepExecution): Promise<void>;
};
