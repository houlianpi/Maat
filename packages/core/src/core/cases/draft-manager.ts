import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { StepExecution, StepRecorder } from './step-recorder.ts';
import type { JavaScriptObservation } from '../exploration/protocol.ts';
import type { CaseDraft, CaseEvidence } from './types.ts';

export type BeginCaseInput = {
  id: string;
  module?: string;
  name: string;
  description: string;
  preconditions?: string[];
  actionSteps?: string[];
  objectives: string[];
  tags?: string[];
  suites?: string[];
  rootDirectory?: string;
  requireScreenshotEvidence?: boolean;
};

function normalizeId(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!id) throw new Error('Case id must contain letters or numbers.');
  return id;
}

function normalizeModule(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const segments = value.split(/[\/\\]+/).map(normalizeId);
  if (segments.some((segment) => !segment)) {
    throw new Error('Case module contains an invalid path segment.');
  }
  return segments.join('/');
}

export class CaseDraftManager implements StepRecorder {
  private draft: CaseDraft | undefined;

  clear(): void {
    this.draft = undefined;
  }

  get current(): CaseDraft | undefined {
    return this.draft;
  }

  begin(input: BeginCaseInput): CaseDraft {
    if (input.objectives.length === 0) {
      throw new Error('A Case requires at least one explicit test objective.');
    }
    this.draft = {
      id: normalizeId(input.id),
      ...(input.module ? { module: normalizeModule(input.module) } : {}),
      name: input.name.trim(),
      description: input.description.trim(),
      preconditions: input.preconditions ?? [],
      actionSteps: input.actionSteps ?? [],
      objectives: input.objectives.map((description, index) => ({
        id: `objective-${index + 1}`,
        description,
      })),
      tags: [...new Set(input.tags ?? [])],
      suites: [...new Set(input.suites ?? [])],
      rootDirectory: path.resolve(input.rootDirectory ?? 'maat-tests'),
      requirements: [],
      steps: [],
      failures: [],
      evidence: [],
      ...(input.requireScreenshotEvidence ? { requireScreenshotEvidence: true } : {}),
    };
    return this.draft;
  }

  async recordSuccessfulStep(
    code: string,
    observations: JavaScriptObservation[],
    execution?: StepExecution,
    name?: string,
  ): Promise<void> {
    if (!this.draft) return;
    this.draft.steps.push({
      number: this.draft.steps.length + 1,
      name: name?.trim() || `Recorded step ${String(this.draft.steps.length + 1).padStart(3, '0')}`,
      adapterId: execution?.adapterId ?? 'web',
      bindings: execution?.bindings ?? ['page', 'context', 'browser', 'expect', 'display'],
      code,
      observations,
    });
    if (execution) {
      const requirements = (this.draft.requirements ??= []);
      const index = requirements.findIndex(
        (item) => item.adapterId === execution.requirement.adapterId,
      );
      if (index === -1) requirements.push(execution.requirement);
      else requirements[index] = execution.requirement;
    }
    const stepNumber = this.draft.steps.length;
    const evidenceDirectory = path.resolve('artifacts/cases', this.draft.id, 'evidence');
    await mkdir(evidenceDirectory, { recursive: true });
    for (const observation of observations) {
      const id = `${String(stepNumber).padStart(3, '0')}-${String(this.draft.evidence.length + 1).padStart(3, '0')}`;
      if (observation.type === 'text') {
        const filename = `${id}.txt`;
        const outputPath = path.join(evidenceDirectory, filename);
        await writeFile(outputPath, `${observation.text}\n`);
        this.draft.evidence.push({
          id,
          stepNumber,
          type: 'text',
          text: observation.text,
          path: outputPath,
        });
      } else {
        const extension = observation.mimeType === 'image/jpeg' ? 'jpg' : 'png';
        const filename = `${id}.${extension}`;
        const outputPath = path.join(evidenceDirectory, filename);
        await writeFile(outputPath, Buffer.from(observation.data, 'base64'));
        this.draft.evidence.push({
          id,
          stepNumber,
          type: 'image',
          mimeType: observation.mimeType,
          path: outputPath,
        });
      }
    }
  }

  listSteps() {
    return (this.draft?.steps ?? []).map(({ observations: _observations, ...step }) => step);
  }

  removeStep(number: number): void {
    if (!this.draft) throw new Error('No active Case.');
    const index = this.draft.steps.findIndex((step) => step.number === number);
    if (index === -1) throw new Error(`Unknown Case step ${number}.`);
    const [removed] = this.draft.steps.splice(index, 1);
    this.draft.evidence = this.draft.evidence
      .filter((evidence) => evidence.stepNumber !== number)
      .map((evidence) => ({
        ...evidence,
        stepNumber: evidence.stepNumber > number ? evidence.stepNumber - 1 : evidence.stepNumber,
      }));
    if (
      removed?.adapterId &&
      !this.draft.steps.some((step) => step.adapterId === removed.adapterId)
    ) {
      this.draft.requirements = this.draft.requirements?.filter(
        (requirement) => requirement.adapterId !== removed.adapterId,
      );
    }
    this.renumberSteps();
  }

  replaceStep(number: number, input: { name?: string; code?: string }): void {
    if (!this.draft) throw new Error('No active Case.');
    const step = this.draft.steps.find((candidate) => candidate.number === number);
    if (!step) throw new Error(`Unknown Case step ${number}.`);
    if (input.name === undefined && input.code === undefined)
      throw new Error('Replace Case step requires name and/or code.');
    if (input.name !== undefined) {
      if (!input.name.trim()) throw new Error('Case step name must be nonempty.');
      step.name = input.name.trim();
    }
    if (input.code !== undefined) {
      if (!input.code.trim()) throw new Error('Case step code must be nonempty.');
      step.code = input.code;
    }
  }

  private renumberSteps(): void {
    if (!this.draft) return;
    for (const [index, step] of this.draft.steps.entries()) step.number = index + 1;
  }

  async recordFailedStep(code: string, error: unknown, execution?: StepExecution): Promise<void> {
    if (!this.draft) return;
    this.draft.failures.push({
      ...(execution ? { adapterId: execution.adapterId } : {}),
      code,
      error: error instanceof Error ? error.message : String(error),
    });
    const attemptsDirectory = path.resolve('artifacts/cases', this.draft.id, 'attempts');
    await mkdir(attemptsDirectory, { recursive: true });
    const attempt = String(this.draft.failures.length).padStart(3, '0');
    await Promise.all([
      writeFile(path.join(attemptsDirectory, `${attempt}.js`), `${code.trim()}\n`),
      writeFile(
        path.join(attemptsDirectory, `${attempt}.json`),
        `${JSON.stringify(this.draft.failures.at(-1), null, 2)}\n`,
      ),
    ]);
  }

  status(): Record<string, unknown> {
    if (!this.draft) return { active: false };
    return {
      active: true,
      id: this.draft.id,
      module: this.draft.module,
      name: this.draft.name,
      rootDirectory: this.draft.rootDirectory,
      objectives: this.draft.objectives,
      candidateSteps: this.draft.steps.length,
      adapters: [...new Set(this.draft.steps.map((step) => step.adapterId ?? 'web'))],
      failedAttempts: this.draft.failures.length,
      evidenceItems: this.draft.evidence.length,
      suites: this.draft.suites,
      tags: this.draft.tags,
    };
  }

  listEvidence(): CaseEvidence[] {
    return this.draft?.evidence ?? [];
  }

  getEvidence(id: string): CaseEvidence | undefined {
    return this.draft?.evidence.find((item) => item.id === id);
  }
}
