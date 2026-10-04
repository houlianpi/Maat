import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { JavaScriptObservation } from '../../core/exploration/protocol.ts';
import type { StepExecution, StepRecorder } from '../../core/cases/step-recorder.ts';
import { generateReplay, type ReplayStep } from './replay-generator.ts';

export type RunStatus = 'completed' | 'failed';

export type RunRecorderOptions = {
  browser?: string;
};

export type RunRecorder = StepRecorder & {
  readonly runDirectory: string;
  readonly replayPath: string;
  finalize(status: RunStatus, error?: unknown): Promise<string | undefined>;
};

type RecordedObservation =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; path: string };

function runId(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

function imageExtension(mimeType: string): string {
  return mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1];
}

export async function createRunRecorder(
  prompt: string,
  rootDirectory = path.resolve('artifacts/runs'),
  options: RunRecorderOptions = {},
): Promise<RunRecorder> {
  const startedAt = new Date();
  const runDirectory = path.join(rootDirectory, runId(startedAt));
  const stepsDirectory = path.join(runDirectory, 'steps');
  const observationsDirectory = path.join(runDirectory, 'observations');
  const failedStepsDirectory = path.join(runDirectory, 'failed-steps');
  const replayPath = path.join(runDirectory, 'replay.ts');
  const steps: ReplayStep[] = [];
  let finalized = false;
  const failures: Array<{ codePath: string; error: string }> = [];

  await Promise.all([
    mkdir(stepsDirectory, { recursive: true }),
    mkdir(observationsDirectory, { recursive: true }),
    mkdir(failedStepsDirectory, { recursive: true }),
  ]);

  return {
    runDirectory,
    replayPath,
    async recordSuccessfulStep(code, observations) {
      if (finalized) throw new Error('Run recorder has already finalized.');
      const number = steps.length + 1;
      const prefix = String(number).padStart(3, '0');
      const recorded: RecordedObservation[] = [];
      let imageNumber = 0;

      await writeFile(path.join(stepsDirectory, `${prefix}.js`), `${code.trim()}\n`);
      for (const observation of observations) {
        if (observation.type === 'text') {
          recorded.push(observation);
          continue;
        }
        const filename = `${prefix}-${String(++imageNumber).padStart(3, '0')}.${imageExtension(observation.mimeType)}`;
        await writeFile(
          path.join(observationsDirectory, filename),
          Buffer.from(observation.data, 'base64'),
        );
        recorded.push({
          type: 'image',
          mimeType: observation.mimeType,
          path: `observations/${filename}`,
        });
      }
      await writeFile(
        path.join(observationsDirectory, `${prefix}.json`),
        `${JSON.stringify(recorded, null, 2)}\n`,
      );
      steps.push({ number, code });
    },
    async recordFailedStep(code, error) {
      if (finalized) throw new Error('Run recorder has already finalized.');
      const number = failures.length + 1;
      const filename = `${String(number).padStart(3, '0')}.js`;
      await writeFile(path.join(failedStepsDirectory, filename), `${code.trim()}\n`);
      failures.push({
        codePath: `failed-steps/${filename}`,
        error: error instanceof Error ? error.message : String(error),
      });
    },
    async finalize(status, error) {
      if (finalized) return failures.length === 0 ? replayPath : undefined;
      finalized = true;
      const replayable = failures.length === 0 && status === 'completed';
      if (replayable) {
        await writeFile(replayPath, generateReplay(steps, { browser: options.browser }));
      }
      await writeFile(
        path.join(runDirectory, 'manifest.json'),
        `${JSON.stringify(
          {
            version: 1,
            startedAt: startedAt.toISOString(),
            completedAt: new Date().toISOString(),
            status: replayable ? status : 'failed',
            replayable,
            prompt,
            browser: options.browser ?? 'chromium',
            stepCount: steps.length,
            replay: replayable ? 'replay.ts' : null,
            failures,
            ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
          },
          null,
          2,
        )}\n`,
      );
      return replayable ? replayPath : undefined;
    },
  };
}
