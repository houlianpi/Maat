import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { StepRecorder } from "../recording/run-recorder.ts";
import type { JavaScriptObservation } from "../worker/protocol.ts";
import type { CaseDraft, CaseEvidence } from "./types.ts";

export type BeginCaseInput = {
  id: string;
  name: string;
  description: string;
  preconditions?: string[];
  actionSteps?: string[];
  objectives: string[];
  tags?: string[];
  suites?: string[];
  rootDirectory?: string;
};

function normalizeId(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) throw new Error("Case id must contain letters or numbers.");
  return id;
}

export class CaseManager implements StepRecorder {
  private draft: CaseDraft | undefined;

  get current(): CaseDraft | undefined {
    return this.draft;
  }

  begin(input: BeginCaseInput): CaseDraft {
    if (input.objectives.length === 0) {
      throw new Error("A Case requires at least one explicit test objective.");
    }
    this.draft = {
      id: normalizeId(input.id),
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
      rootDirectory: path.resolve(input.rootDirectory ?? "cua-tests"),
      steps: [],
      failures: [],
      evidence: [],
    };
    return this.draft;
  }

  async recordSuccessfulStep(
    code: string,
    observations: JavaScriptObservation[],
  ): Promise<void> {
    if (!this.draft) return;
    this.draft.steps.push({
      number: this.draft.steps.length + 1,
      code,
      observations,
    });
    const stepNumber = this.draft.steps.length;
    const evidenceDirectory = path.resolve(
      "artifacts/cases",
      this.draft.id,
      "evidence",
    );
    await mkdir(evidenceDirectory, { recursive: true });
    for (const observation of observations) {
      const id = `${String(stepNumber).padStart(3, "0")}-${String(this.draft.evidence.length + 1).padStart(3, "0")}`;
      if (observation.type === "text") {
        const filename = `${id}.txt`;
        const outputPath = path.join(evidenceDirectory, filename);
        await writeFile(outputPath, `${observation.text}\n`);
        this.draft.evidence.push({
          id,
          stepNumber,
          type: "text",
          text: observation.text,
          path: outputPath,
        });
      } else {
        const extension = observation.mimeType === "image/jpeg" ? "jpg" : "png";
        const filename = `${id}.${extension}`;
        const outputPath = path.join(evidenceDirectory, filename);
        await writeFile(outputPath, Buffer.from(observation.data, "base64"));
        this.draft.evidence.push({
          id,
          stepNumber,
          type: "image",
          mimeType: observation.mimeType,
          path: outputPath,
        });
      }
    }
  }

  async recordFailedStep(code: string, error: unknown): Promise<void> {
    if (!this.draft) return;
    this.draft.failures.push({
      code,
      error: error instanceof Error ? error.message : String(error),
    });
    const attemptsDirectory = path.resolve(
      "artifacts/cases",
      this.draft.id,
      "attempts",
    );
    await mkdir(attemptsDirectory, { recursive: true });
    const attempt = String(this.draft.failures.length).padStart(3, "0");
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
      name: this.draft.name,
      rootDirectory: this.draft.rootDirectory,
      objectives: this.draft.objectives,
      candidateSteps: this.draft.steps.length,
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
