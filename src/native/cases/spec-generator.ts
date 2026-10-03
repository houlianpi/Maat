import type { CaseDraft } from '../../cases/types.ts';
import type { NativeAppTarget } from '../environment/schema.ts';
import { caseTargetComment } from './target.ts';

export function nativeSpec(draft: CaseDraft, target: NativeAppTarget): string {
  const fixture = '../'.repeat((draft.module?.split('/').length ?? 0) + 1) + 'fixtures/maat-test.ts';
  const description = ['Case ID: ' + draft.id, draft.name, draft.description, 'Preconditions:', ...draft.preconditions, 'Actions:', ...draft.actionSteps, 'Objectives:', ...draft.objectives.map(o => o.description)].join('\n');
  const tags = [...draft.tags.map(t => '@' + t), ...draft.suites.map(t => '@suite:' + t)].join(' ');
  return '/**\n * ' + description.replaceAll('*/', '* /').split('\n').join('\n * ') + '\n' + caseTargetComment(target) + ' */\n' +
    `import { driver, browser, expect, describe, it, display, evidence } from ${JSON.stringify(fixture)};

describe(${JSON.stringify(draft.name + ' ' + tags)}, () => {
  it(${JSON.stringify(draft.id)}, async () => {
${draft.steps.map(step => `    await (async () => {
${step.code.split('\n').map(line => '      ' + line).join('\n')}
    })();`).join('\n')}
  });
});
`;
}
