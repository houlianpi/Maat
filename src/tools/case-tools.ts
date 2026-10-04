import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';

import type { CaseDraftManager } from '../core/cases/draft-manager.ts';
import type { MaatHarness } from '../core/harness.ts';

export function createCaseTools(caseManager: CaseDraftManager, projects: MaatHarness) {
  const beginCase = defineTool({
    name: 'begin_case',
    label: 'Begin Case',
    description:
      "Start a test Case from the user's natural-language description, action steps, and explicit test objectives.",
    parameters: Type.Object({
      id: Type.String(),
      module: Type.Optional(
        Type.String({
          description:
            'Optional business module under maat-tests/<platform>/cases, for example calculator or payments/refunds. The platform root is fixed by select_platform.',
        }),
      ),
      name: Type.String(),
      description: Type.String(),
      preconditions: Type.Optional(Type.Array(Type.String())),
      actionSteps: Type.Optional(Type.Array(Type.String())),
      objectives: Type.Array(Type.String(), { minItems: 1 }),
      tags: Type.Optional(Type.Array(Type.String())),
      suites: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (_id, params) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            caseManager.begin({ ...params, rootDirectory: projects.current.root }),
          ),
        },
      ],
      details: {},
    }),
  });

  const getCaseStatus = defineTool({
    name: 'get_case_status',
    label: 'Get Case Status',
    description:
      'Return the active Case objectives, candidate steps, failures, and Evidence count.',
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: 'text', text: JSON.stringify(caseManager.status()) }],
      details: {},
    }),
  });

  const saveCase = defineTool({
    name: 'save_case',
    label: 'Validate and Save Case',
    description:
      'Validate the complete Case with fresh Adapter Sessions, then save one Mocha TypeScript spec. A Case may contain Web and Appium steps. Do not change user expectations to make a test pass.',
    parameters: Type.Object({}),
    execute: async (_id, _params, signal) => {
      const draft = caseManager.current;
      if (!draft) throw new Error('No active Case. Call begin_case first.');
      const result = await projects.save(draft, signal);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: result,
      };
    },
  });

  const listEvidence = defineTool({
    name: 'list_evidence',
    label: 'List Evidence',
    description: 'List text and screenshot Evidence captured for the active Case.',
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: 'text', text: JSON.stringify(caseManager.listEvidence()) }],
      details: {},
    }),
  });

  const showEvidence = defineTool({
    name: 'show_evidence',
    label: 'Show Evidence',
    description:
      'Return one Evidence item. Screenshot Evidence is rendered inline by Pi TUI when the terminal supports images.',
    parameters: Type.Object({ id: Type.String() }),
    execute: async (_id, params) => {
      const evidence = caseManager.getEvidence(params.id);
      if (!evidence) throw new Error(`Unknown Evidence id: ${params.id}`);
      if (evidence.type === 'text') {
        return {
          content: [{ type: 'text' as const, text: evidence.text ?? '' }],
          details: evidence,
        };
      }
      if (!evidence.path || !evidence.mimeType) {
        throw new Error(`Image Evidence ${params.id} is incomplete.`);
      }
      return {
        content: [
          {
            type: 'image' as const,
            data: (await readFile(evidence.path)).toString('base64'),
            mimeType: evidence.mimeType,
          },
          { type: 'text' as const, text: evidence.path },
        ],
        details: evidence,
      };
    },
  });

  return [beginCase, getCaseStatus, saveCase, listEvidence, showEvidence];
}
import { readFile } from 'node:fs/promises';
