import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { CodexMaatRuntime } from './runtime.ts';

type EvidenceSummary = {
  id: string;
  mimeType?: string;
  name?: string;
  path?: string;
  status?: string;
  type?: string;
};

async function latestFormalEvidence(workspaceRoot: string): Promise<EvidenceSummary[]> {
  const runsRoot = path.join(workspaceRoot, 'artifacts', 'maat', 'runs');
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  const manifests = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const casesRoot = path.join(runsRoot, entry.name, 'cases');
          const cases = await readdir(casesRoot, { withFileTypes: true }).catch(() => []);
          return Promise.all(
            cases
              .filter((item) => item.isDirectory())
              .map(async (item) => {
                const manifest = path.join(casesRoot, item.name, 'evidence.json');
                const body = await readFile(manifest, 'utf8').catch(() => undefined);
                if (!body) return undefined;
                return {
                  modifiedAt: (await stat(manifest)).mtimeMs,
                  directory: path.dirname(manifest),
                  body,
                };
              }),
          );
        }),
    )
  )
    .flat()
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  if (!manifests[0]) return [];
  const parsed = JSON.parse(manifests[0].body) as { items?: EvidenceSummary[] };
  return (parsed.items ?? []).map((item, index) => ({
    ...item,
    id: item.id ?? `formal-${index + 1}`,
    ...(item.path ? { path: path.resolve(manifests[0].directory, item.path) } : {}),
  }));
}

export async function dashboardState(runtime: CodexMaatRuntime) {
  const platform = runtime.maat.platforms.status();
  const draft = runtime.maat.cases.current();
  const latestRun = await runtime.latestRun();
  const evidence = draft?.evidence.length
    ? draft.evidence.map((item) => ({
        id: item.id,
        mimeType: item.mimeType,
        path: item.path,
        type: item.type,
        name: `Step ${item.stepNumber}`,
      }))
    : await latestFormalEvidence(runtime.workspaceRoot);
  return {
    revision: Date.now(),
    workspace: { root: runtime.workspaceRoot, name: path.basename(runtime.workspaceRoot) },
    platform,
    setup:
      runtime.maat.setup.current().platform === platform.id
        ? runtime.maat.setup.current()
        : undefined,
    case: draft
      ? {
          id: draft.id,
          name: draft.name,
          steps: draft.steps.length,
          attempts: draft.failures.length,
          objectives: draft.objectives.length,
          suites: draft.suites,
          tags: draft.tags,
        }
      : undefined,
    evidence: evidence.slice(-12),
    latestRun,
    reportPath: latestRun ? path.join(latestRun.runDirectory, 'report', 'index.html') : undefined,
  };
}

export async function dashboardEvidence(runtime: CodexMaatRuntime, id: string) {
  const state = await dashboardState(runtime);
  const evidence = state.evidence.find((item) => item.id === id);
  if (!evidence?.path || evidence.type === 'text') throw new Error(`No image Evidence: ${id}`);
  const resolved = path.resolve(evidence.path);
  const relative = path.relative(runtime.workspaceRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Evidence path is outside the active workspace.');
  }
  return {
    data: (await readFile(resolved)).toString('base64'),
    mimeType:
      evidence.mimeType ?? (resolved.toLowerCase().endsWith('.jpg') ? 'image/jpeg' : 'image/png'),
  };
}
