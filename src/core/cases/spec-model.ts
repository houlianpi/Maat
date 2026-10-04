import type { CaseDraft } from '../../cases/types.ts';

export type SpecStep = {
  number: number;
  name: string;
  adapterId: string;
  bindings: string[];
  code: string;
};
export type SpecModel = {
  id: string;
  module?: string;
  name: string;
  description: string;
  preconditions: string[];
  actionSteps: string[];
  objectives: string[];
  tags: string[];
  suites: string[];
  requirements: CaseDraft['requirements'];
  steps: SpecStep[];
};

export function buildSpecModel(draft: CaseDraft): SpecModel {
  return {
    id: draft.id,
    module: draft.module,
    name: draft.name,
    description: draft.description,
    preconditions: draft.preconditions,
    actionSteps: draft.actionSteps,
    objectives: draft.objectives.map((item) => item.description),
    tags: draft.tags,
    suites: draft.suites,
    requirements: draft.requirements ?? [],
    steps: draft.steps.map((step) => ({
      number: step.number,
      name: `Recorded step ${String(step.number).padStart(3, '0')}`,
      adapterId: step.adapterId ?? 'web',
      bindings: step.bindings ?? ['page', 'context', 'browser', 'expect', 'display'],
      code: step.code,
    })),
  };
}
